import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactInput,
  ArtifactKind,
} from "../../src/contracts/artifacts.js";
import type {
  OpenRunInput,
  RunState,
  RunView,
} from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { createRunService } from "../../src/services/run/index.js";
import {
  RunScheduler,
  type SchedulerExecution,
  type SchedulerPorts,
} from "../../src/services/scheduler/index.js";
import { US_SECURITY } from "../fixtures/market.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function input(): OpenRunInput {
  const roles = [
    { id: "fast", dependsOn: [] },
    { id: "slow", dependsOn: [] },
    { id: "follow", dependsOn: ["fast"] },
  ];
  return {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T22:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        ...roles.map((task) => ({
          ...task,
          executor: {
            kind: "role" as const,
            role: "analyst" as const,
            specialty: task.id,
          },
          inputTasks: task.dependsOn,
          outputKinds: ["analysis" as const],
          dataRequirements: [],
          instructionVersion: 1,
        })),
        {
          id: "finalize",
          executor: { kind: "service", service: "finalize" },
          dependsOn: roles.map(({ id }) => id),
          inputTasks: roles.map(({ id }) => id),
          outputKinds: ["decision", "report"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    },
    versions: {
      plugin: "fixture",
      mode: "fixture",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function setup(supplied = input()) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-scheduler-test-"));
  const root = new DataRoot(directory);
  const runs = createRunService(
    new RunStore<RunState>(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  const { runId } = runs.open("owner", supplied, "open");
  const operation = { runId, identity: "owner" };
  const schedulers: RunScheduler[] = [];
  const releases: (() => void)[] = [];
  let subscriptions = 0;
  const access: SchedulerPorts["runs"] = {
    view: (operation) => runs.view(operation),
    readDefinition: (id) => runs.readDefinition(id),
    subscribe(id, notify) {
      const release = runs.subscribe(id, notify);
      subscriptions++;
      return () => {
        release();
        subscriptions--;
      };
    },
  };
  cleanups.push(async () => {
    for (const release of releases) release();
    try {
      for (const scheduler of schedulers) await scheduler.close();
      expect(subscriptions).toBe(0);
    } finally {
      root.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const gate = () => {
    const value = deferred<void>();
    releases.push(() => value.resolve());
    return value;
  };
  const claim = (taskId: string, requestId: string) => {
    const task = supplied.definition.tasks.find(({ id }) => id === taskId)!;
    const claimed =
      task.executor.kind === "service"
        ? runs.claimService(operation, taskId, task.executor.service, requestId)
        : runs.claim(operation, taskId, requestId);
    return { ...claimed, identity: "worker", sessionId: null };
  };
  const publish = (claimed: ReturnType<typeof claim>) => {
    const content = (kind: ArtifactKind): ArtifactInput => ({
      kind,
      title: claimed.taskId,
      body: "Fixed scheduler fixture",
      inputRefs: claimed.inputRefs,
      claims: [],
      payload: {},
    });
    return claimed.taskId === "finalize"
      ? runs.finalize(
          claimed,
          content("decision"),
          content("report"),
          "publish",
        )
      : runs.commitArtifact(claimed, [content("analysis")], "publish");
  };
  const execute = async (
    execution: SchedulerExecution,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (execution.kind === "stage")
      return Promise.all(
        execution.tasks.map(({ taskId }) =>
          publish(claim(taskId, JSON.stringify([execution.requestId, taskId]))),
        ),
      );
    return publish(claim(execution.taskId, execution.requestId));
  };
  const starts: SchedulerExecution[] = [];
  const views: RunView[] = [];
  const make = (perform: SchedulerPorts["execute"] = execute) => {
    const scheduler = new RunScheduler(runId, {
      runs: access,
      execute: (execution, signal) => {
        starts.push(execution);
        return perform(execution, signal);
      },
      onChange: (view) => {
        views.push(view);
      },
    });
    schedulers.push(scheduler);
    return scheduler;
  };
  return {
    runs,
    access,
    get subscriptions() {
      return subscriptions;
    },
    runId,
    operation,
    claim,
    publish,
    execute,
    starts,
    views,
    gate,
    make,
  };
}

it("starts ready roots together and starts a child while independent work and committed-parent cleanup are still active", async () => {
  const h = setup();
  const roots = deferred<void>();
  const child = deferred<void>();
  const tail = h.gate();
  const slow = h.gate();
  let rootStarts = 0;
  const scheduler = h.make(async (execution, signal) => {
    if (execution.kind !== "task") throw new Error("Expected individual task");
    const claimed = h.claim(execution.taskId, execution.requestId);
    if (execution.taskId === "fast" || execution.taskId === "slow") {
      if (++rootStarts === 2) roots.resolve();
    }
    if (execution.taskId === "slow") await slow.promise;
    signal.throwIfAborted();
    const result = h.publish(claimed);
    if (execution.taskId === "fast") await tail.promise;
    if (execution.taskId === "follow") child.resolve();
    return result;
  });
  let returned = false;
  const done = scheduler.start().then(() => {
    returned = true;
  });
  await roots.promise;
  await child.promise;
  expect(
    h.runs
      .view(h.operation)
      .tasks.slice(0, 3)
      .map(({ status }) => status),
  ).toEqual(["succeeded", "running", "succeeded"]);
  expect(returned).toBe(false);
  slow.resolve();
  await setImmediate();
  expect(h.runs.view(h.operation).status).toBe("completed");
  expect(returned).toBe(false);
  tail.resolve();
  await done;
  expect(h.starts.filter(({ kind }) => kind === "task")).toHaveLength(4);
});

it("waits for explicit stage acceptance and automatically resumes after it is recorded", async () => {
  const supplied = input();
  supplied.definition.tasks[2]!.dependsOn = ["fast", "slow"];
  supplied.definition.tasks[2]!.inputTasks = ["fast", "slow"];
  supplied.definition.stages = [
    { id: "analysis", taskIds: ["fast", "slow"], beforeTasks: ["follow"] },
  ];
  const h = setup(supplied);
  const scheduler = h.make();
  const done = scheduler.start();
  expect(scheduler.start()).toBe(done);
  await setImmediate();
  const stage = h.runs.view(h.operation).stages![0]!;
  expect(stage).toMatchObject({ readyForReview: true, accepted: false });
  expect(
    h.starts.map((work) => (work.kind === "task" ? work.taskId : work.stageId)),
  ).toEqual(["fast", "slow"]);
  h.runs.reviewStage(
    h.operation,
    {
      stageId: "analysis",
      verdict: "rejected",
      feedback: "Clarify evidence",
      refs: stage.refs,
    },
    "reject",
  );
  await setImmediate();
  expect(h.starts).toHaveLength(2);
  h.runs.reviewStage(
    h.operation,
    {
      stageId: "analysis",
      verdict: "accepted",
      feedback: "Evidence verified",
      refs: stage.refs,
    },
    "accept",
  );
  await done;
  expect(h.runs.view(h.operation).status).toBe("completed");
});

it.each([false, true])(
  "keeps together dispatch atomic and permits a single ready revision: %s",
  async (single) => {
    const supplied = input();
    supplied.definition.stages = [
      {
        id: "peers",
        taskIds: ["fast", "slow"],
        beforeTasks: [],
        dispatch: "together",
      },
    ];
    const h = setup(supplied);
    if (single) h.publish(h.claim("fast", "fixed-fast"));
    await h.make().start();
    expect(h.starts[0]).toMatchObject(
      single
        ? { kind: "task", taskId: "slow", attempt: 1 }
        : {
            kind: "stage",
            stageId: "peers",
            tasks: [
              { taskId: "fast", attempt: 1 },
              { taskId: "slow", attempt: 1 },
            ],
          },
    );
    expect(h.runs.view(h.operation).status).toBe("completed");
  },
);

it("does not retry failed tasks even when readyTasks lists them, and explicit redo creates a new request", async () => {
  const h = setup();
  const scheduler = h.make(async (execution, signal) => {
    if (
      execution.kind === "task" &&
      execution.taskId === "fast" &&
      execution.attempt === 1
    ) {
      const claim = h.claim(execution.taskId, execution.requestId);
      return h.runs.failAttempt(
        claim,
        { code: "FAILED", message: "Fixture failure" },
        "fail",
      );
    }
    return h.execute(execution, signal);
  });
  const done = scheduler.start();
  await setImmediate();
  expect(h.runs.view(h.operation).readyTasks).toContain("fast");
  expect(
    h.starts.filter((work) => work.kind === "task" && work.taskId === "fast"),
  ).toHaveLength(1);
  h.runs.redo(h.operation, "fast", "redo-fast");
  await done;
  const fast = h.starts.filter(
    (work) => work.kind === "task" && work.taskId === "fast",
  );
  expect(fast).toHaveLength(2);
  expect(fast[1]!.requestId).not.toBe(fast[0]!.requestId);
});

it("does not automatically retry a failed member of a together stage", async () => {
  const supplied = input();
  supplied.definition.stages = [
    {
      id: "peers",
      taskIds: ["fast", "slow"],
      beforeTasks: [],
      dispatch: "together",
    },
  ];
  const h = setup(supplied);
  h.runs.failAttempt(
    h.claim("fast", "failed-fast"),
    { code: "FAILED", message: "Previous failure" },
    "fail",
  );
  const scheduler = h.make();
  const done = scheduler.start();
  await setImmediate();
  expect(h.starts).toEqual([]);
  h.runs.redo(h.operation, "fast", "redo-fast");
  await done;
  expect(h.starts[0]).toMatchObject({
    kind: "stage",
    tasks: [
      { taskId: "fast", attempt: 2 },
      { taskId: "slow", attempt: 1 },
    ],
  });
});

it("leaves unowned running attempts alone and requires explicit recovery and redo", async () => {
  const h = setup();
  const lost = h.claim("slow", "previous-host");
  const scheduler = h.make();
  const done = scheduler.start();
  await setImmediate();
  expect(
    h.starts.some((work) => work.kind === "task" && work.taskId === "slow"),
  ).toBe(false);
  h.runs.recoverInterrupted(
    h.operation,
    [{ taskId: "slow", attempt: lost.attempt }],
    { code: "HOST_INTERRUPTED", message: "Confirmed lost" },
    "recover",
  );
  await setImmediate();
  expect(
    h.starts.some((work) => work.kind === "task" && work.taskId === "slow"),
  ).toBe(false);
  h.runs.redo(h.operation, "slow", "redo-slow");
  await done;
  expect(h.starts).toContainEqual(
    expect.objectContaining({ kind: "task", taskId: "slow", attempt: 2 }),
  );
});

it("coalesces a synchronous notification burst, stays idle without polling and releases its subscription", async () => {
  const h = setup();
  const fast = h.claim("fast", "existing-fast");
  h.claim("slow", "existing-slow");
  const scheduler = h.make();
  const done = scheduler.start();
  await setImmediate();
  const initial = h.views.length;
  expect(initial).toBe(1);
  expect(h.subscriptions).toBe(1);
  const blocked = h.runs.block(
    h.operation,
    [{ taskId: null, attempt: null, code: "WAIT", message: "Explicit pause" }],
    "block",
  );
  h.runs.resume(
    h.operation,
    { resolvedReasonIds: blocked.reasonIds, instructions: [] },
    "resume",
  );
  h.runs.view(h.operation);
  await setImmediate();
  expect(h.views).toHaveLength(initial + 1);
  await setImmediate();
  expect(h.views).toHaveLength(initial + 1);
  await scheduler.close();
  await done;
  expect(h.subscriptions).toBe(0);
  h.runs.failAttempt(
    fast,
    { code: "FAILED", message: "After scheduler release" },
    "fail-after-close",
  );
  await setImmediate();
  expect(h.views).toHaveLength(initial + 1);
});

it("keeps a replacement request reserved while the executor waits for admission after redo", async () => {
  const h = setup();
  const started = deferred<void>();
  const release = h.gate();
  const admission = h.gate();
  const scheduler = h.make(async (execution, signal) => {
    if (
      execution.kind === "task" &&
      execution.taskId === "fast" &&
      execution.attempt === 1
    ) {
      const claim = h.claim(execution.taskId, execution.requestId);
      started.resolve();
      await release.promise;
      return h.runs.readAttempt(claim);
    }
    if (execution.kind === "task" && execution.taskId === "fast") {
      await release.promise;
      await admission.promise;
    }
    return h.execute(execution, signal);
  });
  const done = scheduler.start();
  await started.promise;
  h.runs.cancelTask(
    h.operation,
    { taskId: "fast", expectedAttempt: 1, reason: "Revise assumptions" },
    "cancel-fast",
  );
  await setImmediate();
  expect(
    h.runs
      .view(h.operation)
      .tasks.slice(0, 3)
      .map(({ status }) => status),
  ).toEqual(["cancelled", "succeeded", "cancelled"]);
  h.runs.redo(h.operation, "fast", "redo-fast");
  await setImmediate();
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 1,
  });
  release.resolve();
  await setImmediate();
  expect(
    h.starts.filter((work) => work.kind === "task" && work.taskId === "fast"),
  ).toHaveLength(2);
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 1,
  });
  admission.resolve();
  await done;
  expect(h.runs.view(h.operation).status).toBe("completed");
  expect(h.starts).toContainEqual(
    expect.objectContaining({ kind: "task", taskId: "fast", attempt: 2 }),
  );
});

it("restarts one member of an active together group without waiting for its independent peer", async () => {
  const supplied = input();
  supplied.definition.stages = [
    {
      id: "peers",
      taskIds: ["fast", "slow"],
      beforeTasks: [],
      dispatch: "together",
    },
  ];
  const h = setup(supplied);
  const started = deferred<void>();
  const revision = deferred<void>();
  const firstReleased = h.gate();
  const peerReleased = h.gate();
  const scheduler = h.make(async (execution, signal) => {
    if (execution.kind === "stage") {
      const fast = h.claim("fast", `${execution.requestId}:fast`);
      const slow = h.claim("slow", `${execution.requestId}:slow`);
      started.resolve();
      return Promise.all([
        firstReleased.promise.then(() => h.runs.readAttempt(fast)),
        peerReleased.promise.then(() => h.publish(slow)),
      ]);
    }
    if (execution.taskId === "fast") {
      await firstReleased.promise;
      const result = await h.execute(execution, signal);
      revision.resolve();
      return result;
    }
    return h.execute(execution, signal);
  });
  const done = scheduler.start();
  await started.promise;
  h.runs.cancelTask(
    h.operation,
    { taskId: "fast", expectedAttempt: 1, reason: "Revise one peer" },
    "cancel-fast",
  );
  firstReleased.resolve();
  h.runs.redo(h.operation, "fast", "redo-fast");
  await revision.promise;
  await setImmediate();
  expect(
    h.runs
      .view(h.operation)
      .tasks.slice(0, 3)
      .map(({ status }) => status),
  ).toEqual(["succeeded", "running", "succeeded"]);
  expect(h.starts).toContainEqual(
    expect.objectContaining({ kind: "task", taskId: "fast", attempt: 2 }),
  );
  peerReleased.resolve();
  await done;
  expect(h.runs.view(h.operation).status).toBe("completed");
});

it("does not launch tasks when cancelled before the initial scan", async () => {
  const h = setup();
  const scheduler = h.make();
  const done = scheduler.start();
  h.runs.cancel(h.operation, "cancel-before-start");
  await done;
  expect(h.starts).toEqual([]);
});

it("aborts owned work after canonical cancellation and waits for resource release", async () => {
  const h = setup();
  const started = deferred<void>();
  const aborted = deferred<void>();
  const release = h.gate();
  let count = 0;
  const scheduler = h.make(async (execution, signal) => {
    if (execution.kind !== "task") throw new Error("Expected individual task");
    h.claim(execution.taskId, execution.requestId);
    if (++count === 2) started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    await release.promise;
    signal.throwIfAborted();
  });
  let returned = false;
  const done = scheduler.start().then(() => {
    returned = true;
  });
  await started.promise;
  h.runs.cancel(h.operation, "cancel");
  await aborted.promise;
  expect(returned).toBe(false);
  release.resolve();
  await done;
  expect(h.starts).toHaveLength(2);
  expect(h.runs.view(h.operation).status).toBe("cancelled");
});

it("close stops admission and waits for its owned resources without publishing business cancellation", async () => {
  const h = setup();
  const started = deferred<void>();
  const aborted = deferred<void>();
  const release = h.gate();
  let count = 0;
  const scheduler = h.make(async (execution, signal) => {
    if (execution.kind !== "task") throw new Error("Expected individual task");
    const claim = h.claim(execution.taskId, execution.requestId);
    if (++count === 2) started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    await release.promise;
    h.runs.failServiceAttempt(
      claim,
      { code: "CANCELLED", message: "Owned execution stopped" },
      "stop",
    );
    signal.throwIfAborted();
  });
  const done = scheduler.start();
  await started.promise;
  let returned = false;
  const closed = scheduler.close().then(() => {
    returned = true;
  });
  await aborted.promise;
  expect(returned).toBe(false);
  expect(h.runs.view(h.operation).status).toBe("active");
  release.resolve();
  await Promise.all([closed, done]);
  await scheduler.start();
  expect(h.starts).toHaveLength(2);
});

it("stops admission immediately when an execution throws synchronously", async () => {
  const h = setup();
  const failure = new Error("Fixture admission failure");
  const started: SchedulerExecution[] = [];
  const scheduler = new RunScheduler(h.runId, {
    runs: h.access,
    onChange() {},
    execute(execution) {
      started.push(execution);
      throw failure;
    },
  });
  await expect(scheduler.start()).rejects.toBe(failure);
  expect(started).toEqual([
    expect.objectContaining({ kind: "task", taskId: "fast" }),
  ]);
  await expect(scheduler.close()).rejects.toBe(failure);
});

it("retains all failures when independent executions reject together", async () => {
  const h = setup();
  const failures = [
    new Error("Fast infrastructure failure"),
    new Error("Slow infrastructure failure"),
  ];
  const scheduler = new RunScheduler(h.runId, {
    runs: h.access,
    onChange() {},
    async execute(execution) {
      if (execution.kind !== "task")
        throw new Error("Expected individual task");
      const claim = h.claim(execution.taskId, execution.requestId);
      const failure = failures[execution.taskId === "fast" ? 0 : 1]!;
      h.runs.failAttempt(
        claim,
        { code: "HOST_FAILED", message: failure.message },
        "fail",
      );
      throw failure;
    },
  });
  const reason: unknown = await scheduler
    .start()
    .catch((cause: unknown) => cause);
  expect(reason).toBeInstanceOf(AggregateError);
  expect((reason as AggregateError).errors).toHaveLength(2);
  expect((reason as AggregateError).errors).toEqual(
    expect.arrayContaining(failures),
  );
  await expect(scheduler.close()).rejects.toBe(reason);
});

it("preserves execution errors and drains already-started independent work before rejecting", async () => {
  const h = setup();
  const release = h.gate();
  const failed = deferred<void>();
  const failure = new Error("Fixture execution infrastructure failure");
  const scheduler = new RunScheduler(h.runId, {
    runs: h.access,
    onChange() {},
    async execute(execution) {
      if (execution.kind !== "task")
        throw new Error("Expected individual task");
      const claim = h.claim(execution.taskId, execution.requestId);
      if (execution.taskId === "fast") {
        h.runs.failAttempt(
          claim,
          { code: "HOST_FAILED", message: failure.message },
          "fail",
        );
        failed.resolve();
        throw failure;
      }
      await release.promise;
      return h.publish(claim);
    },
  });
  const done = scheduler.start().then(
    () => ({ succeeded: true }),
    (reason: unknown) => ({ reason }),
  );
  cleanups.push(async () => {
    release.resolve();
    await expect(scheduler.close()).rejects.toBe(failure);
  });
  await failed.promise;
  let returned = false;
  void done.then(() => {
    returned = true;
  });
  await setImmediate();
  expect(returned).toBe(false);
  release.resolve();
  expect(await done).toMatchObject({ reason: failure });
  expect(
    h.runs
      .view(h.operation)
      .tasks.slice(0, 3)
      .map(({ status }) => status),
  ).toEqual(["failed", "succeeded", "pending"]);
});

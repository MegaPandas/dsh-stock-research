import { SessionId } from "@deepseek-ai/dsh-session";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ResearchError } from "../../src/contracts/errors.js";
import {
  createDispatchOperations,
  createCollectionTaskOperations,
  createServiceTaskOperations,
} from "../../src/host/research-operations.js";
import { createScheduledResearchExecutor } from "../../src/host/scheduled-operations.js";
import { DispatchBridge } from "../../src/host/dispatch/index.js";
import type { SchedulerExecution } from "../../src/services/scheduler/index.js";
import { DecisionService } from "../../src/services/decisions.js";
import { DigestService } from "../../src/services/digest/index.js";
import { CollectionRunService } from "../../src/services/collection-run/index.js";
import { generateHandoffDigest } from "../../src/services/digest/handoff.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import { decisionFixture } from "../fixtures/decision.js";
import { digestGate, gatedDigest } from "../fixtures/digest-execution.js";
import {
  analysis,
  dispatchHost,
  modelGate,
} from "../fixtures/dispatch-host.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function host(...args: Parameters<typeof dispatchHost>) {
  const h = await dispatchHost(...args);
  cleanups.push(h.close);
  const operations = {
    ...createDispatchOperations(h.bridge),
    ...createCollectionTaskOperations(h.bridge),
    ...createServiceTaskOperations(
      h.bridge,
      new DecisionService(h.runs, () => "2024-01-04T00:00:00.000Z"),
    ),
  };
  const execute = createScheduledResearchExecutor(
    h.bridge,
    h.bindings,
    operations,
  );
  const selection = (
    taskId: string,
    attempt = 1,
    requestId = `${taskId}-${attempt}`,
  ): SchedulerExecution => ({
    kind: "task",
    taskId,
    attempt,
    executor: h.runs
      .readDefinition(h.runId)
      .tasks.find(({ id }) => id === taskId)!.executor,
    requestId,
  });
  return {
    ...h,
    selection,
    execute,
    schedule: (
      execution: SchedulerExecution,
      signal = new AbortController().signal,
    ) => execute(h.parent.agent, h.runId, execution, signal),
  };
}

const handoff = {
  ...analysis(),
  payload: {
    schemaVersion: 3 as const,
    report: agentAnalysisReport(),
    stageHandoff: {
      keyPoints: ["Fixed conclusion"],
      disagreements: [],
      risks: [],
      openQuestions: [],
    },
  },
};

function group(h: Awaited<ReturnType<typeof host>>) {
  const definition = h.runs.readDefinition(h.runId);
  definition.tasks = definition.tasks.slice(0, 2);
  definition.stages = [
    {
      id: "peers",
      taskIds: ["analysis", "parallel"],
      beforeTasks: [],
      dispatch: "together",
    },
  ];
  const { runId } = h.runs.open(
    h.parent.agent.id,
    {
      definition,
      versions: {
        plugin: "fixture",
        mode: "fixture",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "stage",
  );
  const binding = h.bindings.require(h.parent.agent).binding;
  if (binding.kind !== "coordinator") throw new Error("Expected coordinator");
  binding.runIds = [...binding.runIds, runId];
  const execution = {
    kind: "stage" as const,
    stageId: "peers",
    tasks: [
      { taskId: "analysis", attempt: 1 },
      { taskId: "parallel", attempt: 1 },
    ],
    requestId: "stage",
  };
  return { runId, execution };
}

function retains(cause: unknown, expected: Error): boolean {
  return (
    cause === expected ||
    (cause instanceof AggregateError &&
      cause.errors.some((error: unknown) => retains(error, expected))) ||
    (cause instanceof Error && retains(cause.cause, expected))
  );
}

it("executes roles and deterministic digest services through their existing owners", async () => {
  const h = await host(
    [{ kind: "save", artifact: handoff }],
    () => generateHandoffDigest,
  );
  await h.schedule(h.selection("analysis"));
  const requests = h.adapter.requests.length;
  const source = h.runs.readAttempt({
    runId: h.runId,
    taskId: "analysis",
    attempt: 1,
  });
  expect(source.status).toBe("succeeded");
  await h.schedule(h.selection("digest"));
  const digest = h.runs.readAttempt({
    runId: h.runId,
    taskId: "digest",
    attempt: 1,
  });
  expect(digest).toMatchObject({
    status: "succeeded",
    inputRefs: source.outputRefs,
  });
  expect(
    h.runs.readArtifact(digest.outputRefs[0]!).content.payload,
  ).toMatchObject({
    report: { content: { keyPoints: ["[analysis] Fixed conclusion"] } },
  });
  expect(h.adapter.requests).toHaveLength(requests);
  await h.schedule(h.selection("analysis"));
  expect(h.adapter.requests).toHaveLength(requests);
});

it("finalizes the validated fixed draft without creating a role execution", async () => {
  const h = await host([]);
  const c = decisionFixture();
  cleanups.push(c.close);
  const digests = new DigestService(c.runs, c.artifacts, generateHandoffDigest);
  const bridge = new DispatchBridge(
    h.ctx,
    c.runs,
    h.sessions,
    () => {
      throw new Error("Finalization must not prepare a role");
    },
    digests,
    new CollectionRunService(c.runs, {
      collectNode: async () => {
        throw new Error("Unexpected fixture collection");
      },
    }),
  );
  cleanups.push(() => bridge.close());
  const binding = h.bindings.require(h.parent.agent).binding;
  if (binding.kind !== "coordinator") throw new Error("Expected coordinator");
  binding.runIds = [...binding.runIds, c.operation.runId];
  const execute = createScheduledResearchExecutor(bridge, h.bindings, {
    ...createDispatchOperations(bridge),
    ...createCollectionTaskOperations(bridge),
    ...createServiceTaskOperations(bridge, new DecisionService(c.runs, c.now)),
  });
  await execute(
    h.parent.agent,
    c.operation.runId,
    {
      kind: "task",
      taskId: "final",
      attempt: 1,
      executor: { kind: "service", service: "finalize" },
      requestId: "final",
    },
    new AbortController().signal,
  );
  expect(c.runs.view(c.operation).status).toBe("completed");
  const final = c.runs.readAttempt({
    ...c.operation,
    taskId: "final",
    attempt: 1,
  });
  expect(final.status).toBe("succeeded");
  expect(
    final.outputRefs.map((ref) => c.runs.readArtifact(ref).content.kind),
  ).toEqual(["decision", "report"]);
  expect(h.prepared).toEqual([]);
  expect(h.adapter.requests).toEqual([]);
});

it.each(["unbound", "task", "other-run"] as const)(
  "rejects a %s caller before admission",
  async (kind) => {
    const h = await host([]);
    const outsider = await h.ctx.agents.create({
      sessionId: SessionId("outsider"),
    });
    if (kind !== "unbound")
      h.bindings.bind(
        outsider.agent,
        kind === "task"
          ? { kind: "task", runId: h.runId, taskId: "analysis", attempt: 1 }
          : { kind: "coordinator", runIds: [] },
      );
    const before = h.runs.view(h.operation);
    await expect(
      h.execute(
        outsider.agent,
        h.runId,
        h.selection("analysis"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(h.runs.view(h.operation)).toEqual(before);
    expect(h.prepared).toEqual([]);
  },
);

it("preserves a pre-cancelled caller reason and leaves canonical state untouched", async () => {
  const h = await host([]);
  const before = h.runs.view(h.operation);
  const reason = new DOMException("Caller stopped", "AbortError");
  await expect(
    h.schedule(h.selection("analysis"), AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
  expect(h.runs.view(h.operation)).toEqual(before);
});

it("skips stale attempts and unmet dependencies without claiming or retrying them", async () => {
  const h = await host([{ kind: "save" }]);
  await h.schedule(h.selection("analysis", 2));
  await h.schedule(h.selection("dependent"));
  expect(h.prepared).toEqual([]);
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 0,
  });
  await h.schedule(h.selection("analysis"));
  await h.bridge.redo(h.operation, "analysis", "redo");
  await h.schedule(h.selection("analysis"));
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 1,
  });
  expect(h.prepared).toHaveLength(1);
});

it("checks every planned member before entering together dispatch", async () => {
  const h = await host([{ kind: "save" }, { kind: "save" }]);
  const { runId, execution } = group(h);
  execution.tasks[1]!.attempt = 2;
  await h.execute(
    h.parent.agent,
    runId,
    execution,
    new AbortController().signal,
  );
  expect(h.runs.view({ runId }).tasks.map(({ attempt }) => attempt)).toEqual([
    0, 0,
  ]);
  execution.tasks[1]!.attempt = 1;
  await h.execute(
    h.parent.agent,
    runId,
    execution,
    new AbortController().signal,
  );
  expect(
    h.runs
      .view({ runId })
      .tasks.map(({ status, attempt }) => ({ status, attempt })),
  ).toEqual([
    { status: "succeeded", attempt: 1 },
    { status: "succeeded", attempt: 1 },
  ]);
});

it("settles every member when a together group is stopped before provisioning", async () => {
  const h = await host([]);
  const { runId, execution } = group(h);
  const work = h.execute(
    h.parent.agent,
    runId,
    execution,
    new AbortController().signal,
  );
  await h.bridge.cancel({ runId, identity: h.parent.agent.id }, "cancel-group");
  await work;
  expect(
    h.runs
      .view({ runId })
      .tasks.map(({ status, attempt }) => ({ status, attempt })),
  ).toEqual([
    { status: "cancelled", attempt: 1 },
    { status: "cancelled", attempt: 1 },
  ]);
  expect(h.prepared).toEqual([]);
  expect(h.adapter.requests).toEqual([]);
});

it("settles an owner stop before role provisioning without treating it as a scheduler failure", async () => {
  const h = await host([]);
  const work = h.schedule(h.selection("analysis"));
  await h.bridge.cancelTask(
    h.operation,
    { taskId: "analysis", expectedAttempt: 1, reason: "Withdraw" },
    "cancel",
  );
  await work;
  expect(h.runs.view(h.operation).tasks[0]!.status).toBe("cancelled");
  expect(h.prepared).toEqual([]);
  expect(h.adapter.requests).toEqual([]);
});

it("rechecks cancellation after a replacement waits for the old execution to release", async () => {
  const gate = modelGate();
  const h = await host([{ kind: "wait", gate }, { kind: "save" }]);
  const first = h.schedule(h.selection("analysis"));
  await gate.started.promise;
  const cancel = h.bridge.cancelTask(
    h.operation,
    { taskId: "analysis", expectedAttempt: 1, reason: "Replace" },
    "cancel",
  );
  const redo = h.bridge.redo(h.operation, "analysis", "redo");
  const second = h.schedule(h.selection("analysis", 2));
  const cancelAgain = h.bridge.cancelTask(
    h.operation,
    { taskId: "analysis", expectedAttempt: 1, reason: "Withdraw replacement" },
    "cancel-again",
  );
  await gate.aborted.promise;
  await setImmediate();
  expect(h.prepared).toHaveLength(1);
  gate.released.resolve();
  await Promise.all([first, cancel, redo, second, cancelAgain]);
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "cancelled",
    attempt: 1,
  });
  expect(h.prepared).toHaveLength(1);
  await h.bridge.redo(h.operation, "analysis", "redo-again");
  await h.schedule(h.selection("analysis", 2));
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "succeeded",
    attempt: 2,
  });
});

it("settles a stopped digest only after its owned execution releases", async () => {
  const gate = digestGate();
  const h = await host([{ kind: "save", artifact: handoff }], () =>
    gatedDigest(gate),
  );
  cleanups.push(() => gate.released.resolve());
  await h.schedule(h.selection("analysis"));
  let returned = false;
  const work = h.schedule(h.selection("digest")).then(() => {
    returned = true;
  });
  await gate.started.promise;
  const stopping = h.bridge.cancelTask(
    h.operation,
    { taskId: "digest", expectedAttempt: 1, reason: "Stop summary" },
    "cancel-digest",
  );
  await gate.aborted.promise;
  expect(returned).toBe(false);
  expect(h.digests.isExecuting(h.runId, { taskId: "digest", attempt: 1 })).toBe(
    true,
  );
  gate.released.resolve();
  await Promise.all([work, stopping]);
  expect(
    h.runs.view(h.operation).tasks.find(({ taskId }) => taskId === "digest")!
      .status,
  ).toBe("cancelled");
  expect(h.digests.isExecuting(h.runId, { taskId: "digest", attempt: 1 })).toBe(
    false,
  );
});

it.each([
  new Error("Provider failed during stop"),
  new DOMException("Unrelated provider abort", "AbortError"),
  new ResearchError("STORAGE_FAILED", "Provider storage failed during stop"),
])(
  "preserves a non-owner rejection even after canonical cancellation: %s",
  async (failure) => {
    const gate = digestGate();
    const h = await host(
      [{ kind: "save", artifact: handoff }],
      () => async (input, signal) => {
        try {
          return await gatedDigest(gate)(input, signal);
        } catch {
          throw failure;
        }
      },
    );
    cleanups.push(() => gate.released.resolve());
    await h.schedule(h.selection("analysis"));
    const work = h
      .schedule(h.selection("digest"))
      .catch((cause: unknown) => cause);
    await gate.started.promise;
    const stopping = h.bridge.cancelTask(
      h.operation,
      { taskId: "digest", expectedAttempt: 1, reason: "Stop summary" },
      "cancel-digest",
    );
    await gate.aborted.promise;
    gate.released.resolve();
    const [cause] = await Promise.all([work, stopping]);
    expect(cause).toBe(failure);
    expect(
      h.runs.view(h.operation).tasks.find(({ taskId }) => taskId === "digest")!
        .status,
    ).toBe("cancelled");
  },
);

it("propagates cleanup and stop-barrier failures despite the published cancellation", async () => {
  const gate = modelGate();
  const h = await host([{ kind: "wait", gate }]);
  const failure = new Error("Activation release failed");
  const start = h.ctx.subagents.startActivation.bind(h.ctx.subagents);
  vi.spyOn(h.ctx.subagents, "startActivation").mockImplementation(
    async (...args) => {
      const activation = await start(...args);
      return {
        ...activation,
        async dispose() {
          await activation.dispose();
          throw failure;
        },
      };
    },
  );
  const work = h
    .schedule(h.selection("analysis"))
    .catch((cause: unknown) => cause);
  await gate.started.promise;
  const stopping = h.bridge
    .cancelTask(
      h.operation,
      { taskId: "analysis", expectedAttempt: 1, reason: "Stop role" },
      "cancel",
    )
    .catch((cause: unknown) => cause);
  const redo = h.bridge
    .redo(h.operation, "analysis", "redo")
    .catch((cause: unknown) => cause);
  const replacement = h
    .schedule(h.selection("analysis", 2))
    .catch((cause: unknown) => cause);
  await gate.aborted.promise;
  gate.released.resolve();
  const results = await Promise.all([work, stopping, redo, replacement]);
  for (const result of results) expect(retains(result, failure)).toBe(true);
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 1,
  });
  expect(h.prepared).toHaveLength(1);
});

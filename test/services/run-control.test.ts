import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import type {
  OpenRunInput,
  RunState,
  RunView,
  TaskInstructionSnapshot,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { createRunService } from "../../src/services/run/index.js";
import type { RunAccess } from "../../src/contracts/run-access.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const paths: string[] = [];
const roots: DataRoot[] = [];
const TIME = "2024-07-01T12:00:00.000Z";
function definition(): OpenRunInput {
  return {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-06-30",
        cutoff: "2024-06-30T20:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        { id: "a", dependsOn: [], inputTasks: [] },
        { id: "b", dependsOn: [], inputTasks: [] },
        { id: "c", dependsOn: ["b"], inputTasks: ["b"] },
        { id: "d", dependsOn: ["a"], inputTasks: ["a"] },
      ].map((task) => ({
        ...task,
        executor: { kind: "role", role: "analyst", specialty: "research" },
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      })),
    },
    versions: {
      plugin: "1",
      mode: "1",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
}
function reopen(path: string) {
  const root = new DataRoot(path);
  roots.push(root);
  const store = new RunStore<RunState>(root);
  let clock = TIME;
  return {
    path,
    root,
    store,
    service: createRunService(store, () => clock),
    setTime: (value: string) => {
      clock = value;
    },
  };
}
function setup() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-run-control-"));
  paths.push(path);
  const context = reopen(path);
  const { runId } = context.service.open("owner", definition(), "open");
  return { ...context, runId, op: { runId, identity: "owner" } };
}
function content(body: string, inputRefs: ArtifactRef[] = []): ArtifactInput {
  return {
    kind: "analysis",
    title: "Analysis",
    body,
    inputRefs,
    claims: [],
    payload: {},
  };
}
function claim(
  service: Pick<RunAccess, "claim">,
  runId: string,
  taskId: string,
  requestId = `claim-${taskId}`,
): TaskOperation {
  const claimed = service.claim(
    { runId, identity: "owner" },
    taskId,
    requestId,
  );
  return {
    runId,
    identity: `worker-${taskId}`,
    taskId,
    attempt: claimed.attempt,
    sessionId: null,
  };
}
function complete(
  service: Pick<RunAccess, "claim" | "commitArtifact">,
  runId: string,
  taskId: string,
  body = taskId,
  inputs: ArtifactRef[] = [],
  suffix = "1",
) {
  const operation = claim(service, runId, taskId, `claim-${taskId}-${suffix}`);
  const artifact = content(body, inputs);
  const result = service.commitArtifact(
    operation,
    [artifact],
    `submit-${taskId}-${suffix}`,
  );
  return { operation, artifact, result, ref: result.refs[0]! };
}
function runDirectory(path: string, runId: string) {
  return join(path, "runs", "2024-06-30", `US_NVDA-quick-${runId}`);
}
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) root.close();
  for (const path of paths.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("run control transactions", () => {
  it("notifies only the subscribed run after a new transaction and not on reads, rejected claims or receipt replay", () => {
    const { service, op, runId } = setup();
    const snapshots: RunView[] = [];
    const release = service.subscribe(runId, () =>
      snapshots.push(service.view(op)),
    );
    const other = service.open("owner", definition(), "other-run");
    claim(service, other.runId, "a");
    expect(snapshots).toEqual([]);
    expect(() => claim(service, runId, "d")).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_READY" }),
    );
    service.view(op);
    expect(snapshots).toEqual([]);
    const a = claim(service, runId, "a");
    expect(snapshots.map(({ readyTasks }) => readyTasks)).toEqual([["b"]]);
    expect(claim(service, runId, "a")).toEqual(a);
    expect(snapshots).toHaveLength(1);
    service.commitArtifact(a, [content("a")], "submit-a");
    expect(snapshots.map(({ readyTasks }) => readyTasks)).toEqual([
      ["b"],
      ["b", "d"],
    ]);
    release();
    service.redo(op, "a", "redo-a");
    expect(snapshots).toHaveLength(2);
  });

  it("owns each subscription independently and old releases cannot remove a new subscriber", () => {
    const { service, op, runId } = setup();
    const events: string[] = [];
    const notify = () => {
      events.push("changed");
    };
    const first = service.subscribe(runId, notify);
    const second = service.subscribe(runId, notify);
    claim(service, runId, "a");
    expect(events).toHaveLength(2);
    first();
    claim(service, runId, "b");
    expect(events).toHaveLength(3);
    second();
    const latest = service.subscribe(runId, notify);
    first();
    second();
    service.redo(op, "a", "redo-a");
    expect(events).toHaveLength(4);
    latest();
  });

  it.each(["rename", "sync"] as const)(
    "invalidates observers after a %s failure during publication without treating notification as success",
    (failureAt) => {
      const { service, op, runId } = setup();
      claim(service, runId, "a");
      const snapshots: RunView[] = [];
      const release = service.subscribe(runId, () =>
        snapshots.push(service.view(op)),
      );
      const failure = new Error(`Fixture ${failureAt} failure`);
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      let published = false;
      vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
        if (failureAt === "rename") throw failure;
        rename(...args);
        if (String(args[1]).endsWith("/manifest.json")) published = true;
      });
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (published && fs.fstatSync(fd).isDirectory()) throw failure;
        sync(fd);
      });
      const input = { taskId: "a", expectedAttempt: 1, reason: "Stop" };
      expect(
        caught(() => service.cancelTask(op, input, "cancel-a")),
      ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
      vi.restoreAllMocks();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.tasks[0]!.status).toBe(
        failureAt === "sync" ? "cancelled" : "running",
      );
      service.cancelTask(op, input, "cancel-a");
      expect(snapshots).toHaveLength(failureAt === "sync" ? 1 : 2);
      release();
    },
  );

  it("cancels only unfinished work and preserves successful content and historical receipts", () => {
    const { service, store, op, runId, setTime, root, path } = setup();
    const successful = complete(service, runId, "a");
    const running = claim(service, runId, "b");
    service.failAttempt(
      claim(service, runId, "d"),
      { code: "FAILED", message: "Earlier failure" },
      "fail-d",
    );
    setTime("2024-07-01T13:00:00.000Z");
    const result = service.cancel(op, "cancel");
    expect(result).toEqual({
      runId,
      status: "cancelled",
      stopAttempts: [{ taskId: "b", attempt: 1 }],
    });
    const state = store.read(runId);
    expect(state.tasks.map(({ taskId, status }) => [taskId, status])).toEqual([
      ["a", "succeeded"],
      ["b", "cancelled"],
      ["c", "cancelled"],
      ["d", "cancelled"],
    ]);
    expect(state.tasks[1]!.attempts[0]).toMatchObject({
      status: "cancelled",
      endedAt: "2024-07-01T13:00:00.000Z",
    });
    expect(state.tasks[3]!.attempts[0]).toMatchObject({
      status: "failed",
      failure: { code: "FAILED", message: "Earlier failure" },
    });
    expect(service.readArtifact(successful.ref).content).toEqual(
      successful.artifact,
    );
    expect(
      service.commitArtifact(
        successful.operation,
        [successful.artifact],
        "submit-a-1",
      ),
    ).toEqual(successful.result);
    expect(service.cancel(op, "cancel")).toEqual(result);
    expect(store.read(runId)).toEqual(state);
    expect(() =>
      service.commitArtifact(running, [content("late")], "late"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    for (const action of [
      () => service.cancel(op, "new-cancel"),
      () =>
        service.cancelTask(
          op,
          { taskId: "a", expectedAttempt: 1, reason: "Stop" },
          "new-task-cancel",
        ),
      () =>
        service.block(
          op,
          [{ taskId: null, attempt: null, code: "blocked", message: "reason" }],
          "new-block",
        ),
      () =>
        service.resume(
          op,
          { resolvedReasonIds: [], instructions: [] },
          "new-resume",
        ),
      () => service.redo(op, "a", "new-redo"),
    ]) {
      expect(action).toThrowError(
        expect.objectContaining({ code: "ACCESS_DENIED" }),
      );
    }
    root.close();
    const restarted = reopen(path);
    expect(restarted.service.cancel(op, "cancel")).toEqual(result);
    expect(restarted.store.read(runId)).toEqual(state);
  });

  it("cancels an unclaimed branch without starting it or blocking independent work", () => {
    const { service, store, op, runId } = setup();
    const input = { taskId: "a", expectedAttempt: 0, reason: "Not needed" };
    const result = service.cancelTask(op, input, "cancel-a");
    expect(result).toEqual({
      runId,
      taskId: "a",
      attempt: 0,
      cancellationId: expect.any(String),
      status: "active",
      affectedTasks: ["a", "d"],
      stopAttempts: [],
      invalidatedRefs: [],
    });
    expect(service.view(op)).toMatchObject({
      status: "active",
      readyTasks: ["b"],
    });
    expect(store.read(runId).tasks[0]).toMatchObject({
      status: "cancelled",
      attempts: [],
      outputRefs: [],
    });
    expect(() => claim(service, runId, "a")).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_READY" }),
    );
    const saved = store.read(runId);
    expect(service.cancelTask(op, input, "cancel-a")).toEqual(result);
    expect(store.read(runId)).toEqual(saved);
    expect(() =>
      service.cancelTask(op, { ...input, reason: "Changed" }, "cancel-a"),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    service.redo(op, "a", "redo-a");
    expect(service.view(op).readyTasks).toEqual(["a", "b"]);
  });

  it("cancels the exact running attempt while an independent branch completes", () => {
    const { service, store, op, runId, setTime } = setup();
    const a = claim(service, runId, "a");
    const b = claim(service, runId, "b");
    setTime("2024-07-01T13:00:00.000Z");
    const result = service.cancelTask(
      op,
      { taskId: "a", expectedAttempt: 1, reason: "Reconsider this branch" },
      "cancel-a",
    );
    expect(result.stopAttempts).toEqual([{ taskId: "a", attempt: 1 }]);
    expect(store.read(runId).tasks[0]!.attempts[0]).toMatchObject({
      status: "cancelled",
      endedAt: "2024-07-01T13:00:00.000Z",
      failure: { code: "CANCELLED", message: "Reconsider this branch" },
    });
    expect(() =>
      service.commitArtifact(a, [content("late")], "late"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    service.commitArtifact(b, [content("independent")], "submit-b");
    expect(service.view(op)).toMatchObject({
      status: "active",
      readyTasks: ["c"],
    });
  });

  it("preserves a cancelled dynamic branch across restart and restores it only through explicit redo", () => {
    const { service, store, op, runId, root, path } = setup();
    const a = complete(service, runId, "a");
    const b = complete(service, runId, "b", "uses a", [a.ref]);
    const c = claim(service, runId, "c");
    const input = {
      taskId: "a",
      expectedAttempt: 1,
      reason: "Withdraw assumptions",
    };
    const result = service.cancelTask(op, input, "cancel-a");
    expect(result).toMatchObject({
      affectedTasks: ["a", "b", "c", "d"],
      stopAttempts: [{ taskId: "c", attempt: 1 }],
      invalidatedRefs: [a.ref, b.ref],
    });
    expect(store.read(runId).tasks.map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(service.view(op).readyTasks).toEqual([]);
    expect(service.readArtifact(a.ref).content.body).toBe("a");
    expect(
      fs.existsSync(join(runDirectory(path, runId), "reports", "a.md")),
    ).toBe(false);
    expect(
      fs.existsSync(join(runDirectory(path, runId), "reports", "b.md")),
    ).toBe(false);
    expect(() =>
      service.commitArtifact(c, [content("late")], "late"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    const saved = store.read(runId);
    root.close();
    const restarted = reopen(path);
    expect(restarted.service.cancelTask(op, input, "cancel-a")).toEqual(result);
    expect(restarted.store.read(runId)).toEqual(saved);
    const redone = restarted.service.redo(op, "a", "redo-a");
    expect(redone.affectedTasks).toEqual(["a", "b", "c", "d"]);
    expect(
      restarted.store
        .read(runId)
        .tasks.every(({ status }) => status === "pending"),
    ).toBe(true);
  });

  it("rejects stale cancellation and replays old cancellation without changing a new attempt", () => {
    const { service, store, op, runId } = setup();
    const first = claim(service, runId, "a");
    const before = store.read(runId);
    expect(() =>
      service.cancelTask(
        op,
        {
          taskId: "a",
          expectedAttempt: 0,
          reason: "Delayed pending cancellation",
        },
        "stale-pending",
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(store.read(runId)).toEqual(before);
    const input = {
      taskId: "a",
      expectedAttempt: first.attempt,
      reason: "Stop",
    };
    const result = service.cancelTask(op, input, "cancel-a");
    service.redo(op, "a", "redo-a");
    const replacement = complete(service, runId, "a", "replacement", [], "2");
    const saved = store.read(runId);
    expect(service.cancelTask(op, input, "cancel-a")).toEqual(result);
    expect(() =>
      service.cancelTask(op, input, "delayed-new-request"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(store.read(runId)).toEqual(saved);
    expect(service.view(op).tasks[0]!.outputRefs).toEqual([replacement.ref]);
  });

  it.each([false, true])(
    "keeps a separately cancelled dynamic branch stopped after explicit redo, with a replacement attempt: %s",
    (replace) => {
      const { service, store, op, runId } = setup();
      const a = complete(service, runId, "a");
      complete(service, runId, "b", "uses a", [a.ref]);
      service.cancelTask(
        op,
        { taskId: "a", expectedAttempt: 1, reason: "Stop original branch" },
        "cancel-a",
      );
      service.redo(op, "b", "redo-independent-b");
      if (replace)
        complete(service, runId, "b", "independent replacement", [], "2");
      service.cancelTask(
        op,
        {
          taskId: "b",
          expectedAttempt: replace ? 2 : 1,
          reason: "Keep independent branch stopped",
        },
        "cancel-independent-b",
      );
      expect(service.redo(op, "a", "redo-a").affectedTasks).toEqual(["a", "d"]);
      expect(
        store
          .read(runId)
          .tasks.slice(1, 3)
          .map(({ status }) => status),
      ).toEqual(["cancelled", "cancelled"]);
      expect(service.view(op).readyTasks).toEqual(["a"]);
    },
  );

  it("requires a reason to block, stops new claims, and lets an already claimed attempt submit", () => {
    const { service, store, op, runId } = setup();
    const running = claim(service, runId, "a");
    const before = store.read(runId);
    expect(() => service.block(op, [], "empty")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(store.read(runId)).toEqual(before);
    const result = service.block(
      op,
      [{ taskId: "a", attempt: 1, code: "WAIT", message: "Await review" }],
      "block",
    );
    expect(result.reasonIds).toHaveLength(1);
    expect(service.view({ runId })).toMatchObject({
      status: "blocked",
      readyTasks: [],
    });
    expect(() => claim(service, runId, "b")).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_READY" }),
    );
    service.commitArtifact(
      running,
      [content("completed while blocked")],
      "submit",
    );
    expect(store.read(runId)).toMatchObject({
      status: "blocked",
      tasks: [{ status: "succeeded" }, {}, {}, {}],
    });
  });

  it("rejects new control transitions after completion while replaying an existing final receipt", () => {
    const { service, store } = setup();
    const supplied = definition();
    supplied.definition.tasks = [
      {
        id: "final",
        executor: { kind: "service", service: "finalize" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["decision", "report"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ];
    const { runId } = service.open("owner", supplied, "open-final");
    const op = { runId, identity: "owner" };
    const operation = claim(service, runId, "final");
    const decision: ArtifactInput = {
      ...content("decision"),
      kind: "decision",
      payload: { rating: "buy" },
    };
    const report: ArtifactInput = { ...content("report"), kind: "report" };
    const result = service.finalize(operation, decision, report, "finalize");
    const saved = store.read(runId);
    for (const action of [
      () => service.cancel(op, "cancel"),
      () =>
        service.cancelTask(
          op,
          { taskId: "final", expectedAttempt: 1, reason: "Stop" },
          "cancel-final",
        ),
      () =>
        service.block(
          op,
          [{ taskId: null, attempt: null, code: "BLOCK", message: "Reason" }],
          "block",
        ),
      () =>
        service.resume(
          op,
          { resolvedReasonIds: [], instructions: [] },
          "resume",
        ),
      () => service.redo(op, "final", "redo"),
      () =>
        service.recoverInterrupted(
          op,
          [],
          { code: "INTERRUPTED", message: "Stopped" },
          "recover",
        ),
    ]) {
      expect(action).toThrowError(
        expect.objectContaining({ code: "ACCESS_DENIED" }),
      );
    }
    expect(service.finalize(operation, decision, report, "finalize")).toEqual(
      result,
    );
    expect(store.read(runId)).toEqual(saved);
  });

  it("resolves only selected reasons and persists two instruction versions with their chain across restart", () => {
    const { service, store, op, runId, root, path, setTime } = setup();
    const initial = store.read(runId);
    const blocked = service.block(
      op,
      [
        {
          taskId: null,
          attempt: null,
          code: "GLOBAL",
          message: "Global issue",
        },
        { taskId: "b", attempt: null, code: "TASK", message: "Task issue" },
      ],
      "block",
    );
    const firstInput = {
      resolvedReasonIds: [blocked.reasonIds[0]!],
      instructions: [{ taskId: "b", instruction: "First revision" }],
    };
    const first = service.resume(op, firstInput, "resume-1");
    expect(first).toMatchObject({
      status: "blocked",
      remainingReasonIds: [blocked.reasonIds[1]],
      revisedTasks: ["b"],
    });
    const firstState = store.read(runId);
    const firstRef = firstState.inputs.find(
      (item) => item.instruction?.version === 2,
    )!.ref;
    expect(service.readInput<TaskInstructionSnapshot>(runId, firstRef)).toEqual(
      {
        taskId: "b",
        instruction: "First revision",
        version: 2,
        previous: null,
        baseDefinition: initial.definitionRef,
        recordedAt: TIME,
      },
    );
    setTime("2024-07-01T14:00:00.000Z");
    const secondInput = {
      resolvedReasonIds: [blocked.reasonIds[1]!],
      instructions: [{ taskId: "b", instruction: "Second revision" }],
    };
    const second = service.resume(op, secondInput, "resume-2");
    const saved = store.read(runId);
    expect(second).toMatchObject({ status: "active", remainingReasonIds: [] });
    const secondRef = saved.inputs.find(
      (item) => item.instruction?.version === 3,
    )!.ref;
    expect(
      service.readInput<TaskInstructionSnapshot>(runId, secondRef),
    ).toEqual({
      taskId: "b",
      instruction: "Second revision",
      version: 3,
      previous: firstRef,
      baseDefinition: firstState.definitionRef,
      recordedAt: "2024-07-01T14:00:00.000Z",
    });
    expect(service.readInput(runId, initial.definitionRef)).toEqual(
      definition().definition,
    );
    root.close();
    const restarted = reopen(path);
    expect(restarted.service.resume(op, secondInput, "resume-2")).toEqual(
      second,
    );
    expect(restarted.store.read(runId)).toEqual(saved);
    const claimed = restarted.service.claim(op, "b", "claim-revised");
    expect(claimed).toMatchObject({
      instructionVersion: 3,
      instructionRef: secondRef,
    });
    expect(restarted.store.read(runId).tasks[1]!.attempts[0]).toMatchObject({
      instructionVersion: 3,
      instructionRef: secondRef,
    });
  });

  it("rejects an entire instruction batch before touching state if any task is running or succeeded", () => {
    const { service, store, op, runId } = setup();
    complete(service, runId, "a");
    claim(service, runId, "b");
    for (const taskId of ["a", "b"]) {
      const before = store.read(runId);
      expect(() =>
        service.resume(
          op,
          {
            resolvedReasonIds: [],
            instructions: [
              { taskId: "c", instruction: "Valid pending update" },
              { taskId, instruction: "Disallowed update" },
            ],
          },
          `bad-${taskId}`,
        ),
      ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
      expect(store.read(runId)).toEqual(before);
    }
  });

  it("replays a resolved block receipt without reintroducing its reason", () => {
    const { service, store, op, runId } = setup();
    const reasons = [
      { taskId: null, attempt: null, code: "WAIT", message: "Explicit review" },
    ];
    const blocked = service.block(op, reasons, "block");
    const resumed = service.resume(
      op,
      { resolvedReasonIds: blocked.reasonIds, instructions: [] },
      "resume",
    );
    expect(resumed.status).toBe("active");
    const saved = store.read(runId);
    expect(service.block(op, reasons, "block")).toEqual(blocked);
    expect(store.read(runId)).toEqual(saved);
    expect(service.view({ runId }).blockReasons).toEqual([]);
  });

  it("rejects unknown resolutions and stale attempt blockers without changing valid work", () => {
    const { service, store, op, runId } = setup();
    claim(service, runId, "a");
    const before = store.read(runId);
    expect(() =>
      service.resume(
        op,
        {
          resolvedReasonIds: ["unknown"],
          instructions: [{ taskId: "b", instruction: "must not apply" }],
        },
        "bad-resolution",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(store.read(runId)).toEqual(before);
    service.redo(op, "a", "redo");
    claim(service, runId, "a", "claim-a2");
    const current = store.read(runId);
    expect(() =>
      service.block(
        op,
        [{ taskId: "a", attempt: 1, code: "LATE", message: "Old execution" }],
        "stale-block",
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(store.read(runId)).toEqual(current);
  });

  it("cascades redo through static and disclosed dynamic dependencies and removes only attempt-specific reasons", () => {
    const { service, store, op, runId } = setup();
    const a = complete(service, runId, "a");
    const b = complete(service, runId, "b", "uses a", [a.ref]);
    claim(service, runId, "c");
    const reasons = service.block(
      op,
      [
        {
          taskId: "a",
          attempt: 1,
          code: "ATTEMPT",
          message: "Old attempt issue",
        },
        {
          taskId: "b",
          attempt: null,
          code: "TASK",
          message: "Task-wide issue",
        },
        {
          taskId: null,
          attempt: null,
          code: "GLOBAL",
          message: "Run-wide issue",
        },
      ],
      "block",
    );
    const result = service.redo(op, "a", "redo", "Re-evaluate");
    expect(result).toMatchObject({
      status: "blocked",
      affectedTasks: ["a", "b", "c", "d"],
      stopAttempts: [{ taskId: "c", attempt: 1 }],
      invalidatedRefs: [a.ref, b.ref],
    });
    const state = store.read(runId);
    expect(
      state.tasks.every(
        (task) => task.status === "pending" && task.outputRefs.length === 0,
      ),
    ).toBe(true);
    expect(
      state.tasks.slice(0, 3).map((task) => task.attempts[0]!.status),
    ).toEqual(["invalidated", "invalidated", "invalidated"]);
    expect(state.blockReasons.map(({ id }) => id)).toEqual(
      reasons.reasonIds.slice(1),
    );
    expect(service.readArtifact(a.ref).content.body).toBe("a");
    expect(service.readArtifact(b.ref).content.body).toBe("uses a");
  });

  it("replays redo and old submission receipts after new success without resetting the new state or views", () => {
    const { service, store, op, runId, path, root } = setup();
    const old = complete(service, runId, "a", "old");
    const redone = service.redo(op, "a", "redo");
    const current = complete(service, runId, "a", "new", [], "2");
    const saved = store.read(runId);
    expect(current.ref).toEqual({ ...old.ref, revision: 2 });
    root.close();
    const restarted = reopen(path);
    expect(restarted.service.redo(op, "a", "redo")).toEqual(redone);
    expect(
      restarted.service.commitArtifact(
        old.operation,
        [old.artifact],
        "submit-a-1",
      ),
    ).toEqual(old.result);
    expect(restarted.store.read(runId)).toEqual(saved);
    const view = fs.readFileSync(
      join(runDirectory(path, runId), "reports", "a.md"),
      "utf8",
    );
    expect(view).toContain("new");
    expect(view).not.toContain("\nold\n");
    expect(restarted.service.readArtifact(old.ref).content.body).toBe("old");
  });

  it.each(["redo", "cancel_task"] as const)(
    "rejects a newly disclosed input invalidated by %s after claim without creating files or state",
    (action) => {
      const { service, store, op, runId, path } = setup();
      const a = complete(service, runId, "a");
      const consumer = claim(service, runId, "b");
      if (action === "redo") service.redo(op, "a", "redo");
      else
        service.cancelTask(
          op,
          { taskId: "a", expectedAttempt: 1, reason: "Withdraw" },
          "cancel-a",
        );
      const saved = store.read(runId);
      const directory = runDirectory(path, runId);
      const files = fs.readdirSync(directory, { recursive: true });
      expect(() =>
        service.commitArtifact(
          consumer,
          [content("late dependency", [a.ref])],
          "late-submit",
        ),
      ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
      expect(store.read(runId)).toEqual(saved);
      expect(fs.readdirSync(directory, { recursive: true })).toEqual(files);
      expect(saved.tasks[1]!.status).toBe("running");
    },
  );

  it("permits references already historical at claim and does not treat them as dependencies on the current version", () => {
    const { service, store, op, runId } = setup();
    const old = complete(service, runId, "a");
    service.redo(op, "a", "redo-1");
    const current = complete(service, runId, "a", "a2", [], "2");
    const b = complete(service, runId, "b", "historical comparison", [old.ref]);
    const result = service.redo(op, "a", "redo-2");
    expect(result.affectedTasks).toEqual(["a", "d"]);
    expect(result.invalidatedRefs).toEqual([current.ref]);
    expect(store.read(runId).tasks[1]).toMatchObject({
      status: "succeeded",
      outputRefs: [b.ref],
    });
    expect(service.readArtifact(old.ref).content.body).toBe("a");
  });

  it("recovers only the specified still-running attempt and keeps replacements and successful work intact", () => {
    const { service, store, op, runId, root, path } = setup();
    complete(service, runId, "a");
    const b1 = claim(service, runId, "b");
    service.failAttempt(
      b1,
      { code: "FAILED", message: "old failure" },
      "fail-b",
    );
    claim(service, runId, "b", "claim-b2");
    claim(service, runId, "d");
    const targets = [
      { taskId: "a", attempt: 1 },
      { taskId: "b", attempt: 1 },
      { taskId: "d", attempt: 1 },
    ];
    const failure = {
      code: "INTERRUPTED",
      message: "Host execution no longer exists",
    };
    const result = service.recoverInterrupted(op, targets, failure, "recover");
    const saved = store.read(runId);
    expect(result.failedAttempts).toEqual([{ taskId: "d", attempt: 1 }]);
    expect(saved.tasks[0]!.status).toBe("succeeded");
    expect(saved.tasks[1]).toMatchObject({
      status: "running",
      attempts: [
        { number: 1, status: "failed" },
        { number: 2, status: "running" },
      ],
    });
    expect(saved.tasks[3]!.attempts[0]).toMatchObject({
      status: "failed",
      failure,
    });
    root.close();
    const restarted = reopen(path);
    expect(
      restarted.service.recoverInterrupted(op, targets, failure, "recover"),
    ).toEqual(result);
    expect(restarted.store.read(runId)).toEqual(saved);
    expect(claim(restarted.service, runId, "d", "retry-d").attempt).toBe(2);
  });

  it("keeps control state unchanged when manifest rename fails and permits a retry", () => {
    const { service, store, op, runId } = setup();
    claim(service, runId, "a");
    const saved = store.read(runId);
    const failure = new Error("manifest rename failed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    expect(caught(() => service.cancel(op, "cancel"))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: failure,
    });
    vi.restoreAllMocks();
    expect(store.read(runId)).toEqual(saved);
    expect(service.cancel(op, "cancel").stopAttempts).toEqual([
      { taskId: "a", attempt: 1 },
    ]);
    expect(
      store.read(runId).receipts.filter(({ action }) => action === "cancel"),
    ).toHaveLength(1);
  });

  it("replays redo published before directory fsync failed and cleans obsolete projections without another reset", () => {
    const { service, store, op, runId, path } = setup();
    complete(service, runId, "a");
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("directory sync failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      if (String(args[1]).endsWith("/manifest.json")) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(caught(() => service.redo(op, "a", "redo"))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: failure,
    });
    vi.restoreAllMocks();
    const saved = store.read(runId);
    expect(saved.tasks[0]!.status).toBe("pending");
    expect(
      fs.existsSync(join(runDirectory(path, runId), "reports", "a.md")),
    ).toBe(true);
    service.redo(op, "a", "redo");
    expect(store.read(runId)).toEqual(saved);
    expect(
      fs.existsSync(join(runDirectory(path, runId), "reports", "a.md")),
    ).toBe(false);
  });

  it.each(["redo", "cancel_task"] as const)(
    "retries obsolete-view deletion after %s from its receipt without duplicating the control transition",
    (action) => {
      const { service, store, op, runId, path } = setup();
      complete(service, runId, "a");
      const observed: string[] = [];
      const release = service.subscribe(runId, () => {
        observed.push(service.view(op).tasks[0]!.status);
      });
      const control = () =>
        action === "redo"
          ? service.redo(op, "a", "redo")
          : service.cancelTask(
              op,
              { taskId: "a", expectedAttempt: 1, reason: "Withdraw" },
              "cancel-a",
            );
      const unlink = fs.unlinkSync;
      const failure = new Error("view deletion failed");
      const view = join(runDirectory(path, runId), "reports", "a.md");
      vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (String(file) === view) throw failure;
        unlink(file);
      });
      expect(caught(control)).toMatchObject({
        code: "STORAGE_FAILED",
        cause: failure,
      });
      vi.restoreAllMocks();
      const saved = store.read(runId);
      expect(saved.tasks[0]!.status).toBe(
        action === "redo" ? "pending" : "cancelled",
      );
      expect(observed).toEqual([action === "redo" ? "pending" : "cancelled"]);
      expect(fs.existsSync(view)).toBe(true);
      control();
      expect(store.read(runId)).toEqual(saved);
      expect(fs.existsSync(view)).toBe(false);
      expect(observed).toHaveLength(1);
      release();
    },
  );
});

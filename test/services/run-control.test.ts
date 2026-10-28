import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import type {
  OpenRunInput,
  RunState,
  TaskInstructionSnapshot,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { RunService } from "../../src/services/runs.js";
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
    service: new RunService(store, () => clock),
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
  service: RunService,
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
  service: RunService,
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

  it("rejects a newly disclosed input invalidated after claim without creating files or state", () => {
    const { service, store, op, runId, path } = setup();
    const a = complete(service, runId, "a");
    const consumer = claim(service, runId, "b");
    service.redo(op, "a", "redo");
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
  });

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

  it("retries obsolete-view deletion from its receipt without duplicating the control transition", () => {
    const { service, store, op, runId, path } = setup();
    complete(service, runId, "a");
    const unlink = fs.unlinkSync;
    const failure = new Error("view deletion failed");
    const view = join(runDirectory(path, runId), "reports", "a.md");
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file) === view) throw failure;
      unlink(file);
    });
    expect(caught(() => service.redo(op, "a", "redo"))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: failure,
    });
    vi.restoreAllMocks();
    const saved = store.read(runId);
    expect(saved.tasks[0]!.status).toBe("pending");
    expect(fs.existsSync(view)).toBe(true);
    service.redo(op, "a", "redo");
    expect(store.read(runId)).toEqual(saved);
    expect(fs.existsSync(view)).toBe(false);
  });
});

import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactInput,
  ArtifactKind,
} from "../../src/contracts/artifacts.js";
import type {
  OpenRunInput,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const directories: string[] = [];
const roots: DataRoot[] = [];
const INITIAL_TIME = "2024-07-01T12:00:00.000Z";
function input(): OpenRunInput {
  return {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-06-30",
        cutoff: "2024-06-30T20:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        {
          id: "analysis",
          executor: {
            kind: "role",
            role: "analyst",
            specialty: "fundamentals",
          },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
        {
          id: "digest",
          executor: { kind: "service", service: "digest" },
          dependsOn: ["analysis"],
          inputTasks: ["analysis"],
          outputKinds: ["digest"],
          dataRequirements: [],
          instructionVersion: 2,
        },
        {
          id: "finalize",
          executor: { kind: "service", service: "finalize" },
          dependsOn: ["digest"],
          inputTasks: ["digest"],
          outputKinds: ["decision", "report"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    },
    versions: {
      plugin: "1",
      mode: "quick-1",
      prompts: { analyst: "1" },
      skills: {},
      adapters: { market: "1" },
      normalization: { market: "1" },
    },
    inputs: [
      {
        name: "instructions",
        content: { question: "Assess NVDA", preferences: ["long-term"] },
      },
    ],
  };
}
function artifact(
  kind: ArtifactKind,
  overrides: Partial<ArtifactInput> = {},
): ArtifactInput {
  return {
    kind,
    title: `${kind} title`,
    body: `${kind} body`,
    inputRefs: [],
    claims: [],
    payload: {},
    ...overrides,
  };
}
function setup(path?: string) {
  if (path === undefined) {
    path = fs.mkdtempSync(join(tmpdir(), "dsh-run-service-"));
    directories.push(path);
  }
  const root = new DataRoot(path);
  roots.push(root);
  const store = new RunStore<RunState>(root);
  let timestamp = INITIAL_TIME;
  const service = new RunService(store, () => timestamp);
  return {
    path,
    root,
    store,
    service,
    setTime: (value: string) => {
      timestamp = value;
    },
  };
}
function claim(
  service: RunService,
  runId: string,
  taskId: string,
  requestId = `claim-${taskId}`,
): TaskOperation {
  const result = service.claim(
    { runId, identity: "coordinator" },
    taskId,
    requestId,
  );
  return {
    runId,
    identity: `worker-${taskId}`,
    taskId,
    attempt: result.attempt,
    sessionId: `session-${taskId}-${result.attempt}`,
  };
}
function completeAnalysis(service: RunService, runId: string) {
  const op = claim(service, runId, "analysis");
  return service.commitArtifact(op, [artifact("analysis")], "submit-analysis");
}
function readyFinal(service: RunService, runId: string) {
  completeAnalysis(service, runId);
  const digest = claim(service, runId, "digest");
  service.commitArtifact(digest, [artifact("digest")], "submit-digest");
  return claim(service, runId, "finalize");
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
  for (const path of directories.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("run service transactions", () => {
  it("persists the definition, version and input snapshots with the initial readiness graph", () => {
    const { service, store } = setup();
    const supplied = input();
    const { runId } = service.open("coordinator", supplied, "open");
    const state = store.read(runId);
    expect(state).toMatchObject({
      stateVersion: 3,
      lineage: null,
      status: "active",
      scope: supplied.definition.scope,
      mode: "quick",
      versions: supplied.versions,
      createdAt: INITIAL_TIME,
      updatedAt: INITIAL_TIME,
      completedAt: null,
    });
    expect(store.readContent(runId, state.definitionRef)).toEqual(
      supplied.definition,
    );
    expect(store.readContent(runId, state.inputs[0]!.ref)).toEqual(
      supplied.inputs[0]!.content,
    );
    expect(service.view({ runId })).toMatchObject({
      scope: supplied.definition.scope,
      mode: "quick",
      readyTasks: ["analysis"],
      currentDigest: null,
    });
    expect(
      state.tasks.map(({ taskId, status, attempts }) => [
        taskId,
        status,
        attempts,
      ]),
    ).toEqual([
      ["analysis", "pending", []],
      ["digest", "pending", []],
      ["finalize", "pending", []],
    ]);
    supplied.definition.tasks[0]!.instructionVersion = 999;
    expect(store.read(runId).definition.tasks[0]!.instructionVersion).toBe(1);
  });

  it("replays open after restart, detects conflicting content, and isolates identity request scopes", () => {
    const { service, store, root, path } = setup();
    const opened = service.open("owner-a", input(), "same-id");
    const revision = store.read(opened.runId).revision;
    expect(service.open("owner-a", input(), "same-id")).toEqual(opened);
    expect(store.read(opened.runId).revision).toBe(revision);
    const changed = input();
    changed.inputs = [{ name: "instructions", content: "different" }];
    expect(() => service.open("owner-a", changed, "same-id")).toThrowError(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
    expect(service.open("owner-b", input(), "same-id").runId).not.toBe(
      opened.runId,
    );
    root.close();
    const reopened = setup(path);
    expect(reopened.service.open("owner-a", input(), "same-id")).toEqual(
      opened,
    );
    expect(reopened.store.list()).toHaveLength(2);
  });

  it("rejects unsatisfied dependencies and competing claims without creating another attempt", () => {
    const { service, store } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    expect(() => claim(service, runId, "digest")).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_READY" }),
    );
    const first = service.claim(
      { runId, identity: "coordinator" },
      "analysis",
      "claim",
    );
    const saved = store.read(runId);
    expect(
      service.claim({ runId, identity: "coordinator" }, "analysis", "claim"),
    ).toEqual(first);
    expect(store.read(runId).revision).toBe(saved.revision);
    expect(() =>
      service.claim({ runId, identity: "other" }, "analysis", "competing"),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    expect(() =>
      service.claim({ runId, identity: "coordinator" }, "digest", "claim"),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(store.read(runId).tasks[0]!.attempts).toHaveLength(1);
  });

  it("commits fixed artifact refs with task success and freezes downstream inputs", () => {
    const { service, store, setTime } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const op = claim(service, runId, "analysis");
    setTime("2024-07-01T13:00:00.000Z");
    const content = artifact("analysis");
    const result = service.commitArtifact(op, [content], "submit");
    const ref = result.refs[0]!;
    expect(ref).toMatchObject({
      runId,
      revision: 1,
      artifactId: expect.any(String),
    });
    expect(service.readArtifact(ref)).toEqual({
      ref,
      taskId: "analysis",
      attempt: 1,
      producerSessionId: "session-analysis-1",
      createdAt: "2024-07-01T13:00:00.000Z",
      schemaVersion: 1,
      content,
    });
    expect(store.read(runId).tasks[0]).toMatchObject({
      status: "succeeded",
      outputRefs: [ref],
      attempts: [
        {
          number: 1,
          status: "succeeded",
          outputRefs: [ref],
          endedAt: "2024-07-01T13:00:00.000Z",
        },
      ],
    });
    const downstream = service.claim(
      { runId, identity: "coordinator" },
      "digest",
      "claim-digest",
    );
    expect(downstream).toMatchObject({
      attempt: 1,
      instructionVersion: 2,
      inputRefs: [ref],
    });
    expect(service.readArtifact(downstream.inputRefs[0]!)).toMatchObject({
      content,
    });
  });

  it("keeps failed runs active and retries with a new attempt while rejecting old writes", () => {
    const { service, store } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const old = claim(service, runId, "analysis");
    const failure = { code: "SOURCE_UNAVAILABLE", message: "Provider offline" };
    service.failAttempt(old, failure, "failed");
    const beforeReplay = store.read(runId).revision;
    service.failAttempt(old, failure, "failed");
    expect(store.read(runId).revision).toBe(beforeReplay);
    expect(service.view({ runId })).toMatchObject({
      status: "active",
      readyTasks: ["analysis"],
    });
    const next = claim(service, runId, "analysis", "retry");
    expect(next.attempt).toBe(2);
    expect(() =>
      service.commitArtifact(old, [artifact("analysis")], "late"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    service.commitArtifact(next, [artifact("analysis")], "new-submit");
    expect(
      store
        .read(runId)
        .tasks[0]!.attempts.map(({ number, status, failure: reason }) => [
          number,
          status,
          reason,
        ]),
    ).toEqual([
      [1, "failed", failure],
      [2, "succeeded", null],
    ]);
  });

  it("replays equivalent commits without adding content and rejects conflicting requests", () => {
    const { service, store } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const op = claim(service, runId, "analysis");
    const content = artifact("analysis", { payload: { first: 1, second: 2 } });
    const result = service.commitArtifact(op, [content], "submit");
    const saved = store.read(runId);
    const equivalent = {
      payload: { second: 2, first: 1 },
      claims: [],
      inputRefs: [],
      body: content.body,
      title: content.title,
      kind: content.kind,
    };
    expect(service.commitArtifact(op, [equivalent], "submit")).toEqual(result);
    expect(store.read(runId)).toEqual(saved);
    expect(() =>
      service.commitArtifact(
        op,
        [artifact("analysis", { body: "changed" })],
        "submit",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(store.read(runId)).toEqual(saved);
  });

  it.each([
    { contents: [] },
    { contents: [artifact("analysis"), artifact("analysis")] },
    { contents: [artifact("report")] },
  ])(
    "rejects incomplete or duplicate required task outputs before success",
    ({ contents }) => {
      const { service, store } = setup();
      const { runId } = service.open("coordinator", input(), "open");
      const op = claim(service, runId, "analysis");
      const saved = store.read(runId);
      expect(() => service.commitArtifact(op, contents, "submit")).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
      expect(store.read(runId)).toEqual(saved);
      expect(service.view({ runId }).readyTasks).not.toContain("digest");
    },
  );

  it("requires the complete declared output set for a task with multiple kinds", () => {
    const { service, store } = setup();
    const supplied = input();
    supplied.definition.tasks = [
      {
        id: "manager",
        executor: { kind: "role", role: "manager", specialty: "planning" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["plan", "decision_draft"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ];
    const { runId } = service.open("coordinator", supplied, "open");
    const op = claim(service, runId, "manager");
    const saved = store.read(runId);
    expect(() =>
      service.commitArtifact(op, [artifact("plan")], "incomplete"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(store.read(runId)).toEqual(saved);
    const result = service.commitArtifact(
      op,
      [artifact("decision_draft"), artifact("plan")],
      "complete",
    );
    expect(
      result.refs.map((ref) => service.readArtifact(ref).content.kind),
    ).toEqual(["decision_draft", "plan"]);
    expect(store.read(runId).tasks[0]!.status).toBe("succeeded");
  });

  it("restricts finalization to its service task and waits for every other task", () => {
    const { service, store } = setup();
    const definition = input();
    definition.definition.tasks[2]!.dependsOn = [];
    definition.definition.tasks[2]!.inputTasks = [];
    const { runId } = service.open("coordinator", definition, "open");
    const analysis = claim(service, runId, "analysis");
    expect(() =>
      service.finalize(
        analysis,
        artifact("decision"),
        artifact("report"),
        "wrong-task",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    const final = claim(service, runId, "finalize");
    expect(() =>
      service.finalize(
        final,
        artifact("decision"),
        artifact("report"),
        "too-early",
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    expect(() =>
      service.commitArtifact(
        final,
        [artifact("decision"), artifact("report")],
        "wrong-entry",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(store.read(runId).status).toBe("active");
  });

  it("requires active status even when the final attempt and all dependencies are ready", () => {
    const { service, store } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const final = readyFinal(service, runId);
    store.commit(runId, (current) => ({ ...current, status: "blocked" }));
    expect(() =>
      service.finalize(
        final,
        artifact("decision"),
        artifact("report"),
        "blocked",
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    expect(store.read(runId).completedAt).toBeNull();
  });

  it("finalizes explicit ratings and replays old receipts after completion while repairing missing views", () => {
    const { service, store, path, setTime } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const final = readyFinal(service, runId);
    const decision = artifact("decision", {
      payload: { rating: "buy", rationale: "Reviewed evidence" },
    });
    const report = artifact("report", {
      inputRefs: store.read(runId).tasks[2]!.attempts[0]!.inputRefs,
    });
    setTime("2024-07-01T14:00:00.000Z");
    const result = service.finalize(final, decision, report, "final");
    const saved = store.read(runId);
    expect(saved).toMatchObject({
      status: "completed",
      completedAt: "2024-07-01T14:00:00.000Z",
    });
    expect(service.readArtifact(result.refs[0]!).content.payload).toEqual(
      decision.payload,
    );
    expect(service.view({ runId })).toMatchObject({
      status: "completed",
      readyTasks: [],
      currentDigest: expect.objectContaining({ runId, revision: 1 }),
    });
    const directory = runDirectory(path, runId);
    expect(
      JSON.parse(fs.readFileSync(join(directory, "decision.json"), "utf8")),
    ).toEqual(decision.payload);
    fs.unlinkSync(join(directory, "report.md"));
    expect(service.finalize(final, decision, report, "final")).toEqual(result);
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toContain(
      "report body",
    );
    expect(store.read(runId)).toEqual(saved);
    expect(() =>
      service.finalize(final, decision, report, "new-final"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(() =>
      service.claim(
        { runId, identity: "coordinator" },
        "analysis",
        "new-claim",
      ),
    ).toThrowError(expect.objectContaining({ code: "TASK_NOT_READY" }));
    service.repairProjections(runId);
    expect(store.read(runId)).toEqual(saved);
  });

  it("leaves no success receipt on manifest rename failure and permits the same request to retry", () => {
    const { service, store } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const op = claim(service, runId, "analysis");
    const saved = store.read(runId);
    const failure = new Error("manifest rename failed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    expect(
      caught(() =>
        service.commitArtifact(op, [artifact("analysis")], "submit"),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(store.read(runId)).toEqual(saved);
    const result = service.commitArtifact(op, [artifact("analysis")], "submit");
    expect(result.refs).toHaveLength(1);
    expect(store.read(runId).tasks[0]!.status).toBe("succeeded");
    expect(
      store
        .read(runId)
        .receipts.filter(({ action }) => action === "commit_artifact"),
    ).toHaveLength(1);
  });

  it("replays a receipt published before directory fsync failure without another artifact version", () => {
    const { service, store, path } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const op = claim(service, runId, "analysis");
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("manifest directory sync failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      if (String(args[1]).endsWith("/manifest.json")) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() =>
        service.commitArtifact(op, [artifact("analysis")], "submit"),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    const saved = store.read(runId);
    expect(saved.tasks[0]!.status).toBe("succeeded");
    const ref = saved.tasks[0]!.outputRefs[0]!;
    const versions = fs.readdirSync(
      join(runDirectory(path, runId), "artifacts", ref.artifactId),
    );
    const result = service.commitArtifact(op, [artifact("analysis")], "submit");
    expect(result.refs).toEqual([ref]);
    expect(store.read(runId)).toEqual(saved);
    expect(
      fs.readdirSync(
        join(runDirectory(path, runId), "artifacts", ref.artifactId),
      ),
    ).toEqual(versions);
  });

  it("repairs a failed projection on receipt replay without recommitting canonical state", () => {
    const { service, store, path } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const op = claim(service, runId, "analysis");
    const rename = fs.renameSync;
    const failure = new Error("view failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      if (String(args[1]).endsWith("/reports/analysis.md")) throw failure;
      rename(...args);
    });
    expect(
      caught(() =>
        service.commitArtifact(op, [artifact("analysis")], "submit"),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    const saved = store.read(runId);
    expect(saved.tasks[0]!.status).toBe("succeeded");
    const result = service.commitArtifact(op, [artifact("analysis")], "submit");
    expect(result.refs).toEqual(saved.tasks[0]!.outputRefs);
    expect(store.read(runId)).toEqual(saved);
    expect(
      fs.readFileSync(
        join(runDirectory(path, runId), "reports", "analysis.md"),
        "utf8",
      ),
    ).toContain("analysis body");
  });

  it("rejects operations after DataRoot closes", () => {
    const { root, service } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    root.close();
    expect(() => service.view({ runId })).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(() =>
      service.claim({ runId, identity: "coordinator" }, "analysis", "claim"),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
  });

  it("discovers a creation receipt after manifest publication reports a sync failure", () => {
    const { service, store } = setup();
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("initial manifest sync failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      if (String(args[1]).endsWith("/manifest.json")) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() => service.open("coordinator", input(), "open")),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    const saved = store.list();
    expect(saved).toHaveLength(1);
    expect(service.open("coordinator", input(), "open")).toEqual({
      runId: saved[0]!.runId,
    });
    expect(store.list()).toEqual(saved);
  });

  it("restores completed task state and fixed inputs before continuing after restart", () => {
    const { service, store, path, root } = setup();
    const { runId } = service.open("coordinator", input(), "open");
    const result = completeAnalysis(service, runId);
    const old = store.read(runId);
    root.close();
    const restored = setup(path);
    expect(restored.service.view({ runId }).readyTasks).toEqual(["digest"]);
    const op = {
      runId,
      identity: "worker-analysis",
      taskId: "analysis",
      attempt: 1,
      sessionId: "session-analysis-1",
    };
    expect(
      restored.service.commitArtifact(
        op,
        [artifact("analysis")],
        "submit-analysis",
      ),
    ).toEqual(result);
    expect(restored.store.read(runId)).toEqual(old);
    expect(
      restored.service.claim(
        { runId, identity: "coordinator" },
        "digest",
        "claim-digest",
      ).inputRefs,
    ).toEqual(result.refs);
  });

  it("keeps both debate and risk content in the single view of their shared task", () => {
    const { service, path } = setup();
    const supplied = input();
    supplied.definition.tasks = [
      {
        id: "discussion",
        executor: { kind: "role", role: "discussion", specialty: "risk" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["debate", "risk"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ];
    const { runId } = service.open("coordinator", supplied, "open");
    service.commitArtifact(
      claim(service, runId, "discussion"),
      [artifact("debate"), artifact("risk")],
      "submit",
    );
    const markdown = fs.readFileSync(
      join(runDirectory(path, runId), "debate", "discussion.md"),
      "utf8",
    );
    expect(markdown).toContain("debate body");
    expect(markdown).toContain("risk body");
  });
});

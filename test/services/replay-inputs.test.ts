import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import type {
  OpenRunInput,
  RunState,
  TaskInstructionSnapshot,
} from "../../src/contracts/runs.js";
import type {
  EvidenceInput,
  EvidenceQuery,
} from "../../src/contracts/task-data.js";
import { HostResearchAdapter } from "../../src/data/host-research.js";
import { RunStore } from "../../src/runs/store.js";
import { QueryService } from "../../src/services/query.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const cleanups: (() => void)[] = [];
const query: EvidenceQuery = {
  dataset: "market",
  provider: "fixture",
  parameters: { field: "close" },
};
function artifact(kind: ArtifactInput["kind"] = "analysis"): ArtifactInput {
  return {
    kind,
    title: "Replay fixture",
    body: "Stored fixture",
    inputRefs: [],
    claims: [],
    payload: {},
  };
}
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-replay-inputs-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const store = new RunStore<RunState>(root);
  let timestamp = "2024-01-03T00:00:00.000Z";
  const now = () => timestamp;
  const runs = new RunService(store, now);
  const input: OpenRunInput = {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-01-02",
        cutoff: "2024-01-02T21:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        ...["a", "b"].map((id) => ({
          id,
          executor: {
            kind: "role" as const,
            role: "analyst" as const,
            specialty: "market",
          },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis" as const],
          dataRequirements: [],
          instructionVersion: 1,
        })),
        {
          id: "finish",
          executor: { kind: "service", service: "finalize" },
          dependsOn: ["a", "b"],
          inputTasks: ["a", "b"],
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
      skills: { method: "1" },
      adapters: { fixture: "1" },
      normalization: { fixture: "1" },
    },
    inputs: [
      { name: "prompt:analyst", content: { text: "Saved analyst prompt" } },
      { name: "skill:method", content: "Saved method body" },
    ],
  };
  const { runId } = runs.open("owner", input, "source");
  const owner = { runId, identity: "owner" };
  function claim(taskId: string, id = taskId) {
    return {
      ...runs.claim(owner, taskId, `claim-${id}`),
      identity: "worker",
      sessionId: null,
    };
  }
  const data: EvidenceInput<{ price: number }> = {
    envelope: {
      dataset: "market",
      data: { price: 7 },
      source: {
        provider: "fixture",
        url: "https://example.com/replay-fixture",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: input.definition.scope.cutoff,
      availableAt: null,
      retrievedAt: timestamp,
      cutoff: input.definition.scope.cutoff,
      ageMs: 0,
      stale: false,
      historicalKnowledge: "unverified",
      gaps: [
        {
          code: "unverified_time",
          field: "/data",
          detail: "Synthetic replay fixture.",
        },
      ],
    },
    candidates: [
      {
        candidateId: "price",
        label: "Price",
        value: 7,
        unit: "USD/share",
        asOf: input.definition.scope.cutoff,
        selector: "/data/price",
      },
    ],
  };
  function replay(id = "replay") {
    return runs.open(
      "owner",
      { replay: { runId }, versions: input.versions },
      id,
    );
  }
  return {
    directory,
    root,
    store,
    runs,
    runId,
    owner,
    input,
    data,
    claim,
    replay,
    now,
    advance: () => {
      timestamp = "2024-01-04T00:00:00.000Z";
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("pinned replay run inputs", () => {
  it("creates a fresh task graph with copied actual inputs and fixed parent revision", () => {
    const context = setup();
    const operation = context.claim("a");
    const evidence = context.runs.recordEvidence(
      operation,
      query,
      context.data,
      "data",
    );
    const memory = context.runs.recordMemoryInput(
      operation,
      { scope: {}, parameters: { limit: 3 } },
      [],
      "memory",
    );
    const output = context.runs.commitArtifact(
      operation,
      [artifact()],
      "submit",
    );
    const source = context.store.read(context.runId);
    context.advance();
    const { runId } = context.replay();
    const target = context.store.read(runId);
    expect(runId).not.toBe(context.runId);
    expect(target).toMatchObject({
      stateVersion: 3,
      definition: source.definition,
      scope: source.scope,
      versions: source.versions,
      status: "active",
      createdAt: "2024-01-04T00:00:00.000Z",
      updatedAt: "2024-01-04T00:00:00.000Z",
      completedAt: null,
      evidence: [],
      artifacts: [],
    });
    expect(
      target.tasks.map(({ taskId, status, attempts, outputRefs }) => [
        taskId,
        status,
        attempts,
        outputRefs,
      ]),
    ).toEqual([
      ["a", "pending", [], []],
      ["b", "pending", [], []],
      ["finish", "pending", [], []],
    ]);
    expect(
      target.inputs.map(({ name, ref }) => [
        name,
        context.runs.readInput(runId, ref),
      ]),
    ).toEqual(context.input.inputs.map(({ name, content }) => [name, content]));
    expect(target.inputs[0]!.ref).not.toEqual(source.inputs[0]!.ref);
    expect(target.lineage).toMatchObject({
      sourceRunId: context.runId,
      sourceRevision: source.revision,
    });
    const snapshot = context.runs.replaySnapshot(runId)!;
    expect(snapshot).toMatchObject({
      sourceRunId: context.runId,
      sourceRevision: source.revision,
    });
    expect(snapshot.tasks[0]).toEqual({
      taskId: "a",
      attempt: 1,
      evidenceRefs: [evidence],
      memoryRefs: [memory.inputRef],
      outputRefs: output.refs,
      instructionRef: null,
    });
    expect(snapshot.tasks[1]).toEqual({
      taskId: "b",
      attempt: null,
      evidenceRefs: [],
      memoryRefs: [],
      outputRefs: [],
      instructionRef: null,
    });
    expect(context.runs.view({ runId }).lineage).toEqual(target.lineage);
    expect(context.store.read(context.runId)).toEqual(source);
    expect(context.runs.replaySnapshot(context.runId)).toBeNull();
  });

  it("keeps the captured catalog after parent redo and additional source queries", () => {
    const context = setup();
    const first = context.claim("a");
    const second = context.claim("b");
    context.runs.recordEvidence(first, query, context.data, "data");
    context.runs.commitArtifact(first, [artifact()], "submit");
    context.runs.recordEvidence(second, query, context.data, "data");
    const { runId } = context.replay();
    const captured = context.runs.replaySnapshot(runId);
    context.runs.redo(context.owner, "a", "redo");
    context.runs.recordEvidence(second, query, context.data, "later-data");
    expect(context.runs.replaySnapshot(runId)).toEqual(captured);
    const modified = context.runs.replaySnapshot(runId)!;
    modified.tasks[0]!.evidenceRefs.length = 0;
    expect(context.runs.replaySnapshot(runId)).toEqual(captured);
  });

  it("excludes invalidated attempts while retaining their physical history", () => {
    const context = setup();
    const operation = context.claim("a");
    const evidence = context.runs.recordEvidence(
      operation,
      query,
      context.data,
      "data",
    );
    context.runs.recordMemoryInput(
      operation,
      { scope: {}, parameters: {} },
      [],
      "memory",
    );
    context.runs.commitArtifact(operation, [artifact()], "submit");
    context.runs.redo(context.owner, "a", "redo");
    const { runId } = context.replay();
    expect(context.runs.replaySnapshot(runId)!.tasks[0]).toEqual({
      taskId: "a",
      attempt: null,
      evidenceRefs: [],
      memoryRefs: [],
      outputRefs: [],
      instructionRef: null,
    });
    expect(context.runs.readEvidence(evidence).envelope.data).toEqual({
      price: 7,
    });
  });

  it("selects only the latest noninvalidated attempt's evidence and memory", () => {
    const context = setup();
    const old = context.claim("a");
    context.runs.recordEvidence(old, query, context.data, "data");
    context.runs.recordMemoryInput(
      old,
      { scope: {}, parameters: {} },
      [],
      "memory",
    );
    context.runs.failAttempt(
      old,
      { code: "FIXTURE", message: "First attempt failed" },
      "fail",
    );
    const current = context.claim("a", "a-2");
    const evidence = context.runs.recordEvidence(
      current,
      query,
      context.data,
      "data",
    );
    const memory = context.runs.recordMemoryInput(
      current,
      { scope: {}, parameters: {} },
      [],
      "memory",
    );
    const { runId } = context.replay();
    expect(context.runs.replaySnapshot(runId)!.tasks[0]).toMatchObject({
      attempt: 2,
      evidenceRefs: [evidence],
      memoryRefs: [memory.inputRef],
      outputRefs: [],
    });
  });

  it("copies the effective instruction and rebases its local references", () => {
    const context = setup();
    context.runs.resume(
      context.owner,
      {
        resolvedReasonIds: [],
        instructions: [
          { taskId: "a", instruction: "Use the revised saved method" },
        ],
      },
      "revise",
    );
    const source = context.store.read(context.runId);
    const original = source.inputs.find(
      (entry) => entry.instruction?.taskId === "a",
    )!.ref;
    context.advance();
    const { runId } = context.replay();
    const target = context.store.read(runId);
    const claimed = context.runs.claim(
      { runId, identity: "owner" },
      "a",
      "claim-replay",
    );
    expect(claimed.instructionVersion).toBe(2);
    expect(claimed.instructionRef).not.toEqual(original);
    expect(
      context.runs.readInput<TaskInstructionSnapshot>(
        runId,
        claimed.instructionRef!,
      ),
    ).toEqual({
      taskId: "a",
      instruction: "Use the revised saved method",
      version: 2,
      previous: null,
      baseDefinition: target.definitionRef,
      recordedAt: "2024-01-04T00:00:00.000Z",
    });
    expect(
      context.runs.replaySnapshot(runId)!.tasks[0]!.instructionRef,
    ).toEqual(original);
    expect(target.definition).toEqual(source.definition);
  });

  it.each([
    "plugin",
    "mode",
    "prompts",
    "skills",
    "adapters",
    "normalization",
  ] as const)(
    "rejects an unavailable %s version before publishing a run",
    (group) => {
      const context = setup();
      const versions = structuredClone(context.input.versions);
      if (group === "plugin" || group === "mode")
        versions[group] = "unavailable";
      else versions[group] = {};
      const source = context.store.read(context.runId);
      expect(() =>
        context.runs.open(
          "owner",
          { replay: { runId: context.runId }, versions },
          "replay",
        ),
      ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
      expect(context.store.list()).toHaveLength(1);
      expect(context.store.read(context.runId)).toEqual(source);
    },
  );

  it("allows additional installed versions while retaining only the source's selected versions", () => {
    const context = setup();
    const versions = structuredClone(context.input.versions);
    versions.prompts.extra = "unused";
    const { runId } = context.runs.open(
      "owner",
      { replay: { runId: context.runId }, versions },
      "replay",
    );
    expect(context.store.read(runId).versions).toEqual(context.input.versions);
  });

  it.each(["cancelled", "completed"])(
    "can derive a new active run from a %s source",
    (status) => {
      const context = setup();
      const first = context.claim("a");
      context.runs.recordEvidence(first, query, context.data, "data");
      if (status === "cancelled") context.runs.cancel(context.owner, "cancel");
      else {
        context.runs.commitArtifact(first, [artifact()], "submit");
        context.runs.commitArtifact(context.claim("b"), [artifact()], "submit");
        context.runs.finalize(
          context.claim("finish"),
          artifact("decision"),
          artifact("report"),
          "finalize",
        );
      }
      const source = context.store.read(context.runId);
      const { runId } = context.replay();
      expect(context.runs.view({ runId }).status).toBe("active");
      expect(context.runs.replaySnapshot(runId)!.tasks[0]!.attempt).toBe(1);
      expect(
        context.runs.replaySnapshot(runId)!.tasks[0]!.evidenceRefs,
      ).toHaveLength(1);
      expect(context.store.read(context.runId)).toEqual(source);
    },
  );

  it("rebuilds replay creation receipts without recapturing a changed parent", () => {
    const context = setup();
    const { runId } = context.replay();
    const saved = context.store.read(runId);
    context.runs.resume(
      context.owner,
      {
        resolvedReasonIds: [],
        instructions: [
          { taskId: "a", instruction: "Later parent instruction" },
        ],
      },
      "later",
    );
    const restored = new RunService(
      new RunStore<RunState>(context.root),
      context.now,
    );
    expect(
      restored.open(
        "owner",
        { replay: { runId: context.runId }, versions: context.input.versions },
        "replay",
      ),
    ).toEqual({ runId });
    expect(context.store.read(runId)).toEqual(saved);
    expect(restored.replaySnapshot(runId)).toEqual(
      context.runs.replaySnapshot(runId),
    );
    expect(() => restored.open("owner", context.input, "replay")).toThrowError(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
    expect(context.store.list()).toHaveLength(2);
  });

  it("recovers a published replay creation whose response was lost", () => {
    const context = setup();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith("/manifest.json"))
        throw new Error("Lost replay creation response");
    });
    expect(() => context.replay()).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    vi.restoreAllMocks();
    const saved = context.store
      .list()
      .find((entry) => entry.runId !== context.runId)!;
    const restored = new RunService(
      new RunStore<RunState>(context.root),
      context.now,
    );
    expect(
      restored.open(
        "owner",
        { replay: { runId: context.runId }, versions: context.input.versions },
        "replay",
      ),
    ).toEqual({ runId: saved.runId });
    expect(restored.replaySnapshot(saved.runId)).toMatchObject({
      sourceRunId: context.runId,
    });
    expect(context.store.list()).toHaveLength(2);
  });

  it("fails missing replay inputs before fetching live data or reading the cache", async () => {
    const context = setup();
    const { runId } = context.replay();
    const operation = {
      ...context.runs.claim({ runId, identity: "owner" }, "a", "claim"),
      identity: "worker",
      sessionId: null,
    };
    const search = vi.fn(async () => ({ sources: [], truncated: false }));
    const cache = new SqliteCache({ path: ":memory:", maxEntries: 8 });
    const get = vi.spyOn(cache, "get");
    const queries = new QueryService(
      { research: new HostResearchAdapter(search) },
      cache,
      context.runs,
      { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 60_000 },
    );
    try {
      await expect(
        queries.queryForTask(
          operation,
          {
            dataset: "research",
            provider: "dsh-web",
            parameters: { query: "fixture", maxResults: 1 },
          },
          "research",
        ),
      ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
      expect(search).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(context.store.read(runId).evidence).toEqual([]);
      expect(
        context.runs.memoryInputForCall(
          operation,
          { scope: {}, parameters: {} },
          "memory",
        ).lineage,
      ).toEqual(context.store.read(runId).lineage);
    } finally {
      try {
        await queries.close();
      } finally {
        cache.close();
      }
    }
  });
});

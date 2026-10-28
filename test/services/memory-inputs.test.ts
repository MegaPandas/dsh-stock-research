import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryState,
  QueryMemoryReturns,
  RecallQuery,
} from "../../src/contracts/memory-service.js";
import type { MemoryRef } from "../../src/contracts/memory.js";
import type { OpenRunInput, RunState } from "../../src/contracts/runs.js";
import { MemoryStore } from "../../src/memory/store.js";
import { RunStore } from "../../src/runs/store.js";
import { MemoryService } from "../../src/services/memory.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const cleanups: (() => Promise<void>)[] = [];
const query: RecallQuery = { runId: null, text: null, limit: 10 };
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-memory-inputs-"));
  const root = new DataRoot(directory);
  let timestamp = "2024-01-01T12:00:00.000Z";
  const now = () => timestamp;
  const runStore = new RunStore<RunState>(root);
  const runs = new RunService(runStore, now);
  const input: OpenRunInput = {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T22:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        {
          id: "a",
          executor: { kind: "role", role: "analyst", specialty: "research" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
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
  const { runId } = runs.open("owner", input, "open");
  const owner = { runId, identity: "owner" };
  const scope = input.definition.scope;
  const store = new MemoryStore<MemoryState>(root, () => ({
    stateVersion: 1,
    receipts: [],
  }));
  const returns = vi
    .fn<QueryMemoryReturns>()
    .mockRejectedValue(new Error("Returns must not be queried"));
  const memory = new MemoryService(store, runs, returns, now);
  cleanups.push(async () => {
    await memory.close();
    root.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function claim(target = runId, request = "claim") {
    return {
      ...runs.claim({ runId: target, identity: "owner" }, "a", request),
      identity: "worker",
      sessionId: null,
    };
  }
  const operation = claim();
  let writes = 0;
  async function remember(note: string, previous: MemoryRef | null = null) {
    return memory.remember(
      { ...owner, scope },
      {
        previous,
        outcome: "Reviewed",
        note,
        evidence: [],
        returns: {
          kind: "unavailable",
          gaps: [
            {
              code: "missing",
              field: "/data",
              detail: "No return observation",
            },
          ],
        },
      },
      `remember-${writes++}`,
    );
  }
  let replays = 0;
  function derive() {
    const target = runs.open(
      "owner",
      { replay: { runId }, versions: input.versions },
      `replay-${replays++}`,
    );
    return claim(target.runId);
  }
  return {
    directory,
    root,
    store,
    runStore,
    runs,
    memory,
    returns,
    runId,
    owner,
    scope,
    operation,
    remember,
    derive,
    setTime: (value: string) => {
      timestamp = value;
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MemoryService task inputs", () => {
  it("inherits the task cutoff and stores complete selected revisions", async () => {
    const c = setup();
    const original = await c.remember("Original content");
    c.setTime("2024-01-04T00:00:00.000Z");
    await c.remember("Future revision", original);
    await c.remember("Future entry");
    const snapshot = c.memory.recallForTask(c.operation, query, "memory");
    expect(snapshot).toEqual({
      runId: c.runId,
      taskId: "a",
      attempt: 1,
      scope: c.scope,
      request: {
        scope: { runId: null },
        parameters: { text: null, limit: 10 },
      },
      recordedAt: "2024-01-04T00:00:00.000Z",
      entries: [{ ref: original, content: c.memory.read(original) }],
    });
    expect(c.returns).not.toHaveBeenCalled();
  });

  it("registers an empty list as a successful immutable result", async () => {
    const c = setup();
    const snapshot = c.memory.recallForTask(c.operation, query, "empty");
    await c.remember("Added later");
    expect(snapshot.entries).toEqual([]);
    expect(c.memory.recallForTask(c.operation, query, "empty")).toEqual(
      snapshot,
    );
    expect(c.runStore.read(c.runId).inputs).toHaveLength(1);
  });

  it("keeps the old call fixed after additions and revisions while a new call reselects", async () => {
    const c = setup();
    const original = await c.remember("Original");
    const snapshot = c.memory.recallForTask(c.operation, query, "first");
    c.setTime("2024-01-02T12:00:00.000Z");
    const revised = await c.remember("Revised", original);
    const added = await c.remember("Added");
    expect(c.memory.recallForTask(c.operation, query, "first")).toEqual(
      snapshot,
    );
    expect(
      c.memory.recallForTask(c.operation, query, "second").entries,
    ).toEqual(
      [revised, added]
        .sort((a, b) => a.entryId.localeCompare(b.entryId))
        .map((ref) => ({ ref, content: c.memory.read(ref) })),
    );
  });

  it("rejects changed query content for an already registered call", () => {
    const c = setup();
    c.memory.recallForTask(c.operation, query, "memory");
    for (const changed of [
      { ...query, limit: 1 },
      { ...query, text: "other" },
      { ...query, runId: c.runId },
    ]) {
      expect(() =>
        c.memory.recallForTask(c.operation, changed, "memory"),
      ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    }
    expect(c.runStore.read(c.runId).inputs).toHaveLength(1);
  });

  it.each(["redo", "cancel"] as const)(
    "reads an existing receipt after %s and rejects a new old-attempt call",
    (transition) => {
      const c = setup();
      const snapshot = c.memory.recallForTask(c.operation, query, "memory");
      if (transition === "redo") c.runs.redo(c.owner, "a", "redo");
      else c.runs.cancel(c.owner, "cancel");
      const saved = c.runStore.read(c.runId);
      expect(c.memory.recallForTask(c.operation, query, "memory")).toEqual(
        snapshot,
      );
      expect(() =>
        c.memory.recallForTask(c.operation, query, "new"),
      ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
      expect(c.runStore.read(c.runId)).toEqual(saved);
    },
  );

  it.each([false, true])(
    "replays only the source snapshot when empty=%s without consulting live memory",
    async (empty) => {
      const c = setup();
      if (!empty) await c.remember("Source memory");
      const source = c.memory.recallForTask(c.operation, query, "memory");
      const target = c.derive();
      await c.remember("Current memory");
      vi.spyOn(c.store, "readIndex").mockImplementation(() => {
        throw new Error("Live memory must not be read");
      });
      const copied = c.memory.recallForTask(target, query, "replayed");
      expect(copied.entries).toEqual(source.entries);
      expect(copied.scope).toEqual(source.scope);
      expect(copied.replayedFrom).toEqual({
        runId: c.runId,
        inputRef: c.runStore.read(c.runId).inputs[0]!.ref,
      });
      expect(c.returns).not.toHaveBeenCalled();
    },
  );

  it("fails explicitly when the derived run has no matching source snapshot", async () => {
    const c = setup();
    await c.remember("Available only in live memory");
    const target = c.derive();
    expect(() => c.memory.recallForTask(target, query, "missing")).toThrowError(
      expect.objectContaining({ code: "DATA_INSUFFICIENT" }),
    );
    expect(c.runStore.read(target.runId).inputs).toEqual([]);
  });

  it("uses an explicit source to disambiguate saved snapshots and binds it to the call", async () => {
    const c = setup();
    c.memory.recallForTask(c.operation, query, "empty");
    await c.remember("Selected memory");
    const selected = c.memory.recallForTask(c.operation, query, "selected");
    const registrations = c.runStore
      .read(c.runId)
      .inputs.map((value) => ({ runId: c.runId, inputRef: value.ref }));
    const target = c.derive();
    expect(() =>
      c.memory.recallForTask(target, query, "ambiguous"),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    expect(
      c.memory.recallForTask(
        target,
        query,
        "explicit",
        undefined,
        registrations[1]!,
      ).entries,
    ).toEqual(selected.entries);
    expect(() =>
      c.memory.recallForTask(
        target,
        query,
        "explicit",
        undefined,
        registrations[0]!,
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
  });

  it.each([
    { field: "stateVersion", value: 2, code: "VERSION_UNAVAILABLE" },
    { field: "receipts", value: {}, code: "STORAGE_FAILED" },
    { field: "entries", value: {}, code: "STORAGE_FAILED" },
  ])(
    "rejects persisted $field corruption when restoring the service",
    async ({ field, value, code }) => {
      const c = setup();
      await c.remember("Persisted memory");
      const path = join(c.directory, "memory", "index.json");
      const index = JSON.parse(fs.readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      index[field] = value;
      fs.writeFileSync(path, JSON.stringify(index));
      expect(
        () =>
          new MemoryService(
            new MemoryStore<MemoryState>(c.root, () => ({
              stateVersion: 1,
              receipts: [],
            })),
            c.runs,
            c.returns,
            () => "2024-01-04T00:00:00.000Z",
          ),
      ).toThrowError(expect.objectContaining({ code }));
    },
  );

  it("rejects a malformed persisted entry instead of returning partial task input", async () => {
    const c = setup();
    const ref = await c.remember("Persisted memory");
    const path = join(
      c.directory,
      "memory",
      "entries",
      ref.entryId,
      `${ref.revision}.json`,
    );
    const entry = JSON.parse(fs.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    entry.returns = { kind: "unavailable", gaps: [] };
    fs.writeFileSync(path, JSON.stringify(entry));
    expect(() =>
      c.memory.recallForTask(c.operation, query, "corrupt"),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    expect(c.runStore.read(c.runId).inputs).toEqual([]);
  });

  it("rejects persisted evidence that belongs to another run", async () => {
    const c = setup();
    const ref = await c.remember("Persisted memory");
    expect(c.memory.read(ref).runId).toBe(c.runId);
    const path = join(
      c.directory,
      "memory",
      "entries",
      ref.entryId,
      `${ref.revision}.json`,
    );
    const entry = JSON.parse(fs.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    entry.evidence = [
      { runId: "another-run", evidenceId: "saved-evidence", selector: "/data" },
    ];
    fs.writeFileSync(path, JSON.stringify(entry));
    expect(() => c.memory.read(ref)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("rejects persisted return scope that names another security", async () => {
    const c = setup();
    const request = {
      dataset: "returns" as const,
      provider: "yahoo" as const,
      parameters: {
        historyStartDate: "2024-01-01",
        startDate: "2024-01-02",
        endDate: "2024-01-03",
        maxAgeMs: 60000,
        comparable: false,
      },
    };
    c.returns.mockResolvedValue({
      dataset: "returns",
      data: {
        market: { currency: "USD", adjustment: "split_adjusted", bars: [] },
        algorithmVersion: "1",
        requestedStartDate: "2024-01-02",
        requestedEndDate: "2024-01-03",
        start: null,
        end: null,
        comparable: false,
        value: null,
        unit: "ratio",
      },
      source: {
        provider: "yahoo",
        url: "https://example.com/returns",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: "2024-01-03T21:00:00.000Z",
      availableAt: null,
      retrievedAt: "2024-01-04T00:00:00.000Z",
      cutoff: c.scope.cutoff,
      ageMs: 3600000,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [],
    });
    const ref = await c.memory.remember(
      { ...c.owner, scope: c.scope },
      {
        previous: null,
        outcome: "Reviewed",
        note: "Saved returns",
        evidence: [],
        returns: { kind: "query", request },
      },
      "recorded-returns",
    );
    const entry = c.memory.read(ref);
    if (entry.returns.kind !== "recorded")
      throw new Error("Expected recorded returns");
    expect(entry.returns.snapshot.scope.security.id).toBe(c.scope.security.id);
    entry.returns.snapshot.scope.security.id = "US:OTHER";
    const path = join(
      c.directory,
      "memory",
      "entries",
      ref.entryId,
      `${ref.revision}.json`,
    );
    fs.writeFileSync(path, JSON.stringify(entry));
    expect(() => c.memory.read(ref)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });
});

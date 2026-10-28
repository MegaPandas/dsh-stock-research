import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { ArtifactInput } from "../../src/contracts/artifacts.js";
import type { MarketData, SourceRef } from "../../src/contracts/data.js";
import type {
  MarketIndicatorsData,
  MarketIndicatorsQuery,
  MarketSourceQuery,
} from "../../src/contracts/query.js";
import type { OpenRunInput, RunState } from "../../src/contracts/runs.js";
import type {
  EvidenceInput,
  MemoryInputQuery,
  MemoryInputSnapshot,
  MemorySnapshotEntry,
} from "../../src/contracts/task-data.js";
import { HttpClient } from "../../src/data/http.js";
import { YahooMarketAdapter } from "../../src/data/yahoo-market.js";
import { RunStore } from "../../src/runs/store.js";
import { QueryService } from "../../src/services/query.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const http = new HttpClient({
  timeoutMs: 1000,
  maxConcurrency: 1,
  minIntervalMs: 0,
});
const capability = new YahooMarketAdapter(http).capability;
afterAll(() => http.close());
const cleanups: (() => void | Promise<void>)[] = [];
const query: MarketSourceQuery = {
  dataset: "market",
  provider: "yahoo",
  parameters: { startDate: "2024-01-02", maxAgeMs: 60_000 },
};
const memoryQuery: MemoryInputQuery = {
  scope: { securityId: "US:NVDA" },
  parameters: { limit: 3 },
};
function artifact(sources: SourceRef[] = []): ArtifactInput {
  return {
    kind: "analysis",
    title: "Saved fixture",
    body: "Fixture",
    inputRefs: [],
    claims: sources.map((source, index) => ({
      id: `p${index}`,
      kind: "observed",
      value: 12,
      unit: "USD/share",
      source,
    })),
    payload: {},
  };
}
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-replay-data-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const store = new RunStore<RunState>(root);
  let timestamp = "2024-01-04T00:00:00.000Z";
  const now = () => timestamp;
  const runs = new RunService(store, now);
  const input: OpenRunInput = {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T22:00:00.000Z",
      },
      mode: "quick",
      tasks: ["a", "b"].map((id) => ({
        id,
        executor: { kind: "role", role: "analyst", specialty: "market" },
        dependsOn: [],
        inputTasks: [],
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
      adapters: { yahoo: "2" },
      normalization: { yahoo: "1" },
    },
    inputs: [],
  };
  const { runId } = runs.open("owner", input, "source");
  const scope = input.definition.scope;
  function claim(taskId = "a", target = runId, callId = `claim-${taskId}`) {
    return {
      ...runs.claim({ runId: target, identity: "owner" }, taskId, callId),
      identity: "worker",
      sessionId: null,
    };
  }
  function data(close = 12): EvidenceInput<MarketData> {
    return {
      envelope: {
        dataset: "market",
        data: {
          currency: "USD",
          adjustment: "split_adjusted",
          bars: [10, close].map((value, index) => ({
            date: `2024-01-0${index + 2}`,
            asOf: `2024-01-0${index + 2}T21:00:00.000Z`,
            availableAt: null,
            sessionComplete: true,
            open: value,
            high: value + 1,
            low: value - 1,
            close: value,
            volume: 100,
          })),
        },
        source: {
          provider: "yahoo",
          url: "https://example.com/saved-market",
          adapterVersion: "2",
          normalizationVersion: "1",
        },
        asOf: "2024-01-03T21:00:00.000Z",
        availableAt: null,
        retrievedAt: "2024-01-04T00:00:00.000Z",
        cutoff: scope.cutoff,
        ageMs: 3_600_000,
        stale: true,
        historicalKnowledge: "unverified",
        gaps: [
          {
            code: "unverified_time",
            field: "/data",
            detail: "Saved synthetic fixture.",
          },
        ],
      },
      candidates: [
        {
          candidateId: "saved.close",
          label: "Original close",
          value: close,
          unit: "USD/share",
          asOf: "2024-01-03T21:00:00.000Z",
          selector: "/data/bars/1/close",
        },
      ],
    };
  }
  let replayId = 0;
  function derive(source = runId) {
    timestamp = "2024-01-05T00:00:00.000Z";
    const target = runs.open(
      "owner",
      { replay: { runId: source }, versions: input.versions },
      `replay-${replayId++}`,
    );
    return { ...target, operation: claim("a", target.runId) };
  }
  function queries(service = runs) {
    const cache = new SqliteCache({
      path: join(directory, "cache.sqlite"),
      maxEntries: 10,
    });
    const get = vi.spyOn(cache, "get");
    const set = vi.spyOn(cache, "set");
    const fetch = vi
      .fn<YahooMarketAdapter["query"]>()
      .mockRejectedValue(new Error("Replay must not invoke a source"));
    const queryService = new QueryService(
      { yahoo: { capability, query: fetch } },
      cache,
      service,
      { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 60_000 },
    );
    cleanups.push(async () => {
      try {
        await queryService.close();
      } finally {
        cache.close();
      }
    });
    return { service: queryService, get, set, fetch };
  }
  const runDirectory = (target: string) =>
    join(directory, "runs", "2024-01-03", `US_NVDA-quick-${target}`);
  const evidenceFile = (ref: SourceRef) =>
    join(runDirectory(ref.runId), "evidence", `${ref.evidenceId}.json`);
  return {
    root,
    store,
    runs,
    runId,
    input,
    scope,
    data,
    claim,
    derive,
    queries,
    runDirectory,
    evidenceFile,
    now,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("offline evidence replay", () => {
  it("copies the selected immutable snapshot, preserves metadata and rebinds original candidates", async () => {
    const c = setup();
    const original = c.runs.recordEvidence(c.claim(), query, c.data(), "data");
    const source = c.runs.readEvidence(original);
    const derived = c.derive();
    const q = c.queries();
    const result = await q.service.queryForTask(
      derived.operation,
      query,
      "replay",
    );
    expect(result.sourceRef.runId).toBe(derived.runId);
    expect(result.sourceRef.evidenceId).not.toBe(original.evidenceId);
    expect(result.envelope.data).toEqual(source.envelope.data);
    expect(result.envelope).toMatchObject({
      source: source.envelope.source,
      asOf: source.envelope.asOf,
      availableAt: null,
      retrievedAt: "2024-01-04T00:00:00.000Z",
      cutoff: c.scope.cutoff,
      ageMs: 3_600_000,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: source.envelope.gaps,
    });
    expect(result.envelope.candidateClaims).toEqual([
      {
        candidateId: "saved.close",
        label: "Original close",
        value: 12,
        unit: "USD/share",
        asOf: "2024-01-03T21:00:00.000Z",
        source: { ...result.sourceRef, selector: "/data/bars/1/close" },
      },
    ]);
    expect(c.runs.readEvidence(result.sourceRef)).toMatchObject({
      taskId: "a",
      attempt: 1,
      recordedAt: "2024-01-05T00:00:00.000Z",
      replayedFrom: original,
    });
    expect(c.runs.readEvidence(original)).toEqual(source);
    expect(c.store.read(derived.runId).receipts.at(-1)!.action).toBe(
      "replay_evidence",
    );
    expect(q.get).not.toHaveBeenCalled();
    expect(q.set).not.toHaveBeenCalled();
    expect(q.fetch).not.toHaveBeenCalled();
  });

  it("prefers evidence actually cited by an effective output over same-query alternatives", async () => {
    const c = setup();
    const op = c.claim();
    const used = c.runs.recordEvidence(op, query, c.data(), "used");
    const other = c.runs.recordEvidence(op, query, c.data(20), "other");
    c.runs.commitArtifact(op, [artifact([used])], "submit");
    const d = c.derive();
    const q = c.queries();
    const automatic = await q.service.queryForTask(d.operation, query, "auto");
    expect(c.runs.readEvidence(automatic.sourceRef).replayedFrom).toEqual(used);
    const explicit = await q.service.replayForTask(
      d.operation,
      query,
      "explicit",
      other,
    );
    expect(explicit.envelope.data.bars[1]!.close).toBe(20);
    await expect(
      q.service.replayForTask(d.operation, query, "explicit", used),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });

  it("traces calculated artifact inputs to their exact source claim", () => {
    const c = setup();
    const b = c.claim("b");
    const cited = c.runs.recordEvidence(b, query, c.data(), "b-data");
    const bOutput = c.runs.commitArtifact(b, [artifact([cited])], "b-submit")
      .refs[0]!;
    const a = c.claim();
    c.runs.recordEvidence(a, query, c.data(20), "a-data");
    c.runs.commitArtifact(
      a,
      [
        {
          ...artifact(),
          inputRefs: [bOutput],
          claims: [
            {
              id: "ratio",
              kind: "calculated",
              value: 0,
              unit: "ratio",
              operation: "simple_return",
              inputs: [
                { kind: "artifact", artifact: bOutput, claimId: "p0" },
                { kind: "artifact", artifact: bOutput, claimId: "p0" },
              ],
            },
          ],
        },
      ],
      "submit",
    );
    const d = c.derive();
    const copied = c.runs.replayEvidence(d.operation, query, "data");
    expect(c.runs.readEvidence(copied).replayedFrom).toEqual(cited);
  });

  it("deduplicates repeated observed and estimated references to one physical snapshot", () => {
    const c = setup();
    const a = c.claim();
    const original = c.runs.recordEvidence(a, query, c.data(), "data");
    const content = artifact([original, original]);
    content.claims.push({
      id: "estimate",
      kind: "estimated",
      value: 10,
      unit: "USD/share",
      method: "Fixture estimate",
      assumptions: ["Fixture assumption"],
      evidence: [original],
    });
    c.runs.commitArtifact(a, [content], "submit");
    const d = c.derive();
    expect(
      c.runs.readEvidence(c.runs.replayEvidence(d.operation, query, "data"))
        .replayedFrom,
    ).toEqual(original);
  });

  it("fails ambiguous matching without guessing, and permits an explicit eligible snapshot", () => {
    const c = setup();
    const a = c.claim();
    c.runs.recordEvidence(a, query, c.data(), "first");
    const second = c.runs.recordEvidence(a, query, c.data(20), "second");
    const d = c.derive();
    expect(() =>
      c.runs.replayEvidence(d.operation, query, "auto"),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    const result = c.runs.replayEvidence(
      d.operation,
      query,
      "explicit",
      second,
    );
    expect(c.runs.readEvidence(result).replayedFrom).toEqual(second);
    expect(() =>
      c.runs.replayEvidence(
        d.operation,
        { ...query, parameters: { ...query.parameters, maxAgeMs: 1 } },
        "explicit",
        second,
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
  });

  it("does not hide multiple cited matches behind an uncited alternative", () => {
    const c = setup();
    const a = c.claim();
    const first = c.runs.recordEvidence(a, query, c.data(), "first");
    const second = c.runs.recordEvidence(a, query, c.data(20), "second");
    const content = artifact([first, second]);
    content.claims[1]!.value = 20;
    c.runs.commitArtifact(a, [content], "submit");
    const d = c.derive();
    expect(() =>
      c.runs.replayEvidence(d.operation, query, "auto"),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    expect(c.store.read(d.runId).evidence).toEqual([]);
  });

  it("rejects a directory-excluded attempt and another task's uncited source", () => {
    const c = setup();
    const a = c.claim();
    const old = c.runs.recordEvidence(a, query, c.data(), "old");
    c.runs.redo({ runId: c.runId, identity: "owner" }, "a", "redo");
    const unrelated = c.runs.recordEvidence(
      c.claim("b"),
      query,
      c.data(),
      "b-data",
    );
    const d = c.derive();
    for (const source of [old, unrelated])
      expect(() =>
        c.runs.replayEvidence(d.operation, query, "data", source),
      ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    expect(c.store.read(d.runId).evidence).toEqual([]);
  });

  it("requires the complete research scope when following a cited cross-run source", () => {
    const c = setup();
    const foreignInput = structuredClone(c.input);
    foreignInput.definition.scope.cutoff = "2024-01-03T23:00:00.000Z";
    const foreign = c.runs.open("owner", foreignInput, "foreign");
    const foreignData = c.data();
    foreignData.envelope.cutoff = foreignInput.definition.scope.cutoff;
    foreignData.envelope.ageMs = 7_200_000;
    const wrongScope = c.runs.recordEvidence(
      c.claim("a", foreign.runId),
      query,
      foreignData,
      "foreign-data",
    );
    const a = c.claim();
    const sameScope = c.runs.recordEvidence(
      a,
      query,
      c.data(20),
      "current-data",
    );
    c.runs.commitArtifact(a, [artifact([wrongScope])], "submit");
    const d = c.derive();
    expect(
      c.runs.readEvidence(c.runs.replayEvidence(d.operation, query, "data"))
        .replayedFrom,
    ).toEqual(sameScope);
    expect(() =>
      c.runs.replayEvidence(d.operation, query, "foreign", wrongScope),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
  });

  it("uses the pinned catalog after the original task is redone", () => {
    const c = setup();
    const original = c.runs.recordEvidence(c.claim(), query, c.data(), "old");
    const d = c.derive();
    c.runs.redo({ runId: c.runId, identity: "owner" }, "a", "redo");
    c.runs.recordEvidence(
      c.claim("a", c.runId, "claim-2"),
      query,
      c.data(20),
      "new",
    );
    expect(
      c.runs.readEvidence(c.runs.replayEvidence(d.operation, query, "data"))
        .replayedFrom,
    ).toEqual(original);
  });

  it("keeps metadata aligned when cited evidence is interleaved across runs", () => {
    const c = setup();
    const a = c.claim();
    const first = c.runs.recordEvidence(a, query, c.data(), "first");
    const thirdQuery = {
      ...query,
      parameters: { ...query.parameters, maxAgeMs: 2 },
    };
    const third = c.runs.recordEvidence(a, thirdQuery, c.data(), "third");
    const foreign = c.runs.open("owner", c.input, "foreign-batch");
    const second = c.runs.recordEvidence(
      c.claim("a", foreign.runId),
      { ...query, parameters: { ...query.parameters, maxAgeMs: 1 } },
      c.data(),
      "second",
    );
    c.runs.commitArtifact(a, [artifact([first, second, third])], "submit");
    const d = c.derive();
    expect(
      c.runs.readEvidence(
        c.runs.replayEvidence(d.operation, thirdQuery, "data"),
      ).replayedFrom,
    ).toEqual(third);
  });

  it("loads only selected evidence bodies and avoids unrelated outputs for an explicit registered source", () => {
    const c = setup();
    const a = c.claim();
    const selected = c.runs.recordEvidence(a, query, c.data(), "selected");
    const irrelevant = c.runs.recordEvidence(
      a,
      { ...query, parameters: { ...query.parameters, maxAgeMs: 1 } },
      c.data(20),
      "irrelevant",
    );
    const output = c.runs.commitArtifact(a, [artifact([selected])], "submit")
      .refs[0]!;
    const d = c.derive();
    fs.unlinkSync(c.evidenceFile(irrelevant));
    fs.unlinkSync(
      join(
        c.runDirectory(c.runId),
        "artifacts",
        output.artifactId,
        `${output.revision}.json`,
      ),
    );
    const copied = c.runs.replayEvidence(d.operation, query, "data", selected);
    expect(c.runs.readEvidence(copied).replayedFrom).toEqual(selected);
  });

  it("fails missing selected evidence without querying a live source or cache", async () => {
    const c = setup();
    const source = c.runs.recordEvidence(c.claim(), query, c.data(), "data");
    const d = c.derive();
    const q = c.queries();
    fs.unlinkSync(c.evidenceFile(source));
    await expect(
      q.service.queryForTask(d.operation, query, "data"),
    ).rejects.toMatchObject({ code: "STORAGE_FAILED" });
    expect(q.fetch).not.toHaveBeenCalled();
    expect(q.get).not.toHaveBeenCalled();
    expect(c.store.read(d.runId).evidence).toEqual([]);
  });

  it("matches request metadata before loading the selected body", () => {
    const c = setup();
    const a = c.claim();
    const selected = c.runs.recordEvidence(a, query, c.data(), "selected");
    const irrelevant = c.runs.recordEvidence(
      a,
      { ...query, parameters: { ...query.parameters, maxAgeMs: 1 } },
      c.data(20),
      "irrelevant",
    );
    const d = c.derive();
    fs.unlinkSync(c.evidenceFile(irrelevant));
    expect(
      c.runs.readEvidence(c.runs.replayEvidence(d.operation, query, "data"))
        .replayedFrom,
    ).toEqual(selected);
  });

  it("keeps saved calculations and candidate identities without recomputing them", async () => {
    const c = setup();
    const base = c.data();
    const request: MarketIndicatorsQuery = {
      ...query,
      parameters: {
        ...query.parameters,
        indicators: [{ kind: "sma", period: 2 }],
      },
    };
    const data: EvidenceInput<MarketIndicatorsData> = {
      envelope: {
        ...base.envelope,
        data: {
          ...base.envelope.data,
          indicators: {
            algorithmVersion: "1",
            series: [
              { kind: "sma", period: 2, unit: "USD/share", values: [null, 11] },
            ],
          },
        },
      },
      candidates: [
        {
          candidateId: "saved.sma",
          label: "Saved SMA",
          value: 11,
          unit: "USD/share",
          asOf: base.envelope.asOf,
          selector: "/data/indicators/series/0/values/1",
        },
      ],
    };
    c.runs.recordEvidence(c.claim(), request, data, "data");
    const d = c.derive();
    const q = c.queries();
    const copied = await q.service.queryForTask(d.operation, request, "data");
    expect(copied.envelope.data.indicators).toEqual(
      data.envelope.data.indicators,
    );
    expect(
      copied.envelope.candidateClaims.map(({ candidateId }) => candidateId),
    ).toEqual(["saved.sma"]);
  });

  it("reads copied calls after cancellation and original file loss, rejecting new calls", async () => {
    const c = setup();
    const original = c.runs.recordEvidence(c.claim(), query, c.data(), "data");
    const d = c.derive();
    const copied = c.runs.replayEvidence(d.operation, query, "data");
    c.runs.cancel({ runId: d.runId, identity: "owner" }, "cancel");
    fs.unlinkSync(c.evidenceFile(original));
    const restored = new RunService(new RunStore<RunState>(c.root), c.now);
    const q = c.queries(restored);
    expect(
      (await q.service.queryForTask(d.operation, query, "data")).sourceRef,
    ).toEqual(copied);
    await expect(
      q.service.queryForTask(d.operation, query, "new"),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
  });

  it("honors a pre-aborted caller and the query service lifetime before writing", async () => {
    const c = setup();
    c.runs.recordEvidence(c.claim(), query, c.data(), "data");
    const d = c.derive();
    const q = c.queries();
    const controller = new AbortController();
    const reason = new Error("Cancelled replay");
    controller.abort(reason);
    await expect(
      q.service.replayForTask(
        d.operation,
        query,
        "aborted",
        null,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    await q.service.close();
    await expect(
      q.service.queryForTask(d.operation, query, "closed"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(c.store.read(d.runId).evidence).toEqual([]);
  });
});

describe("offline memory and receipt replay", () => {
  it.each([
    { entries: [] },
    {
      entries: [
        {
          ref: { entryId: "memory-entry", revision: 1 },
          content: {
            text: "Original remembered content",
            recordedAt: "2024-01-01T00:00:00.000Z",
          },
        },
      ],
    },
  ] satisfies { entries: MemorySnapshotEntry<unknown>[] }[])(
    "copies the complete saved memory list: $entries",
    ({ entries }) => {
      const c = setup();
      const original = c.runs.recordMemoryInput(
        c.claim(),
        memoryQuery,
        entries,
        "memory",
      );
      const d = c.derive();
      const copied = c.runs.replayMemoryInput(
        d.operation,
        memoryQuery,
        "memory",
      );
      const record = c.runs.readInput<MemoryInputSnapshot<unknown>>(
        d.runId,
        copied.inputRef,
      );
      expect(record).toMatchObject({
        runId: d.runId,
        taskId: "a",
        attempt: 1,
        scope: c.scope,
        request: memoryQuery,
        entries,
        replayedFrom: original,
        recordedAt: "2024-01-05T00:00:00.000Z",
      });
      expect(
        c.runs.memoryInputForCall(d.operation, memoryQuery, "memory").inputRef,
      ).toEqual(copied.inputRef);
    },
  );

  it("requires unique memory matching and includes the explicit selection in call identity", () => {
    const c = setup();
    const a = c.claim();
    const first = c.runs.recordMemoryInput(a, memoryQuery, [], "first");
    const second = c.runs.recordMemoryInput(
      a,
      memoryQuery,
      [{ ref: { entryId: "m", revision: 1 }, content: "Saved content" }],
      "second",
    );
    const d = c.derive();
    expect(() =>
      c.runs.replayMemoryInput(d.operation, memoryQuery, "ambiguous"),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    const copied = c.runs.replayMemoryInput(
      d.operation,
      memoryQuery,
      "explicit",
      second,
    );
    expect(
      c.runs.readInput<MemoryInputSnapshot<unknown>>(d.runId, copied.inputRef)
        .entries[0]!.content,
    ).toBe("Saved content");
    expect(() =>
      c.runs.replayMemoryInput(d.operation, memoryQuery, "explicit", first),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(() =>
      c.runs.replayMemoryInput(
        d.operation,
        { ...memoryQuery, parameters: { limit: 4 } },
        "different",
        first,
      ),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
  });

  it("preserves copied empty memory after source loss and target cancellation", () => {
    const c = setup();
    const original = c.runs.recordMemoryInput(
      c.claim(),
      memoryQuery,
      [],
      "memory",
    );
    const d = c.derive();
    const copied = c.runs.replayMemoryInput(d.operation, memoryQuery, "memory");
    c.runs.cancel({ runId: d.runId, identity: "owner" }, "cancel");
    fs.unlinkSync(
      join(c.runDirectory(c.runId), "inputs", `${original.inputRef.id}.json`),
    );
    const restored = new RunService(new RunStore<RunState>(c.root), c.now);
    expect(
      restored.replayMemoryInput(d.operation, memoryQuery, "memory"),
    ).toEqual(copied);
    expect(
      restored.readInput<MemoryInputSnapshot<unknown>>(d.runId, copied.inputRef)
        .entries,
    ).toEqual([]);
    expect(() =>
      restored.replayMemoryInput(d.operation, memoryQuery, "new"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
  });

  it("replays copied evidence and memory into another generation with immediate provenance", () => {
    const c = setup();
    const a = c.claim();
    c.runs.recordEvidence(a, query, c.data(), "data");
    c.runs.recordMemoryInput(a, memoryQuery, [], "memory");
    const first = c.derive();
    const evidence = c.runs.replayEvidence(first.operation, query, "data");
    const memory = c.runs.replayMemoryInput(
      first.operation,
      memoryQuery,
      "memory",
    );
    const second = c.derive(first.runId);
    const copied = c.runs.replayEvidence(second.operation, query, "data");
    expect(c.runs.readEvidence(copied).replayedFrom).toEqual(evidence);
    const remembered = c.runs.replayMemoryInput(
      second.operation,
      memoryQuery,
      "memory",
    );
    expect(
      c.runs.readInput<MemoryInputSnapshot<unknown>>(
        second.runId,
        remembered.inputRef,
      ).replayedFrom,
    ).toEqual(memory);
  });

  it("keeps fresh and replay registration paths distinct", () => {
    const c = setup();
    const a = c.claim();
    expect(() => c.runs.replayEvidence(a, query, "data")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() =>
      c.runs.replayMemoryInput(a, memoryQuery, "memory"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const d = c.derive();
    expect(() =>
      c.runs.recordEvidence(d.operation, query, c.data(), "data"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() =>
      c.runs.recordMemoryInput(d.operation, memoryQuery, [], "memory"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(c.store.read(d.runId).evidence).toEqual([]);
  });

  it("recovers a replay receipt published before its response failed", () => {
    const c = setup();
    const original = c.runs.recordEvidence(c.claim(), query, c.data(), "data");
    const d = c.derive();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith("/manifest.json"))
        throw new Error("Replay response lost");
    });
    expect(() =>
      c.runs.replayEvidence(d.operation, query, "data"),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    vi.restoreAllMocks();
    const saved = c.store.read(d.runId);
    fs.unlinkSync(c.evidenceFile(original));
    const restored = new RunService(new RunStore<RunState>(c.root), c.now);
    const result = restored.replayEvidence(d.operation, query, "data");
    expect(c.store.read(d.runId).revision).toBe(saved.revision);
    expect(c.store.read(d.runId).evidence).toHaveLength(1);
    expect(restored.readEvidence(result).replayedFrom).toEqual(original);
  });
});

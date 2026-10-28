import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import type {
  MarketSourceQuery,
  QuerySnapshot,
  PriceReturnsQuery,
} from "../../src/contracts/query.js";
import type { RunState } from "../../src/contracts/runs.js";
import { marketCapability } from "../../src/data/market.js";
import { QueryService } from "../../src/services/query.js";
import { selectQuerySnapshot } from "../../src/services/query-snapshot.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { MARKET_FIXTURE, US_SECURITY } from "../fixtures/market.js";

const scope: ResearchScope = {
  security: US_SECURITY,
  date: "2024-01-08",
  cutoff: "2024-01-08T22:00:00.000Z",
};
const request: MarketSourceQuery = {
  dataset: "market",
  provider: "yahoo",
  parameters: { startDate: "2024-01-02", maxAgeMs: 7_200_000 },
};
function snapshot(): QuerySnapshot<MarketSourceQuery> {
  const envelope = structuredClone(MARKET_FIXTURE);
  envelope.source = {
    ...envelope.source,
    provider: "yahoo",
    adapterVersion: "2",
  };
  envelope.cutoff = "2024-01-08T21:30:00.000Z";
  envelope.retrievedAt = "2024-01-08T21:25:00.000Z";
  envelope.availableAt = null;
  envelope.historicalKnowledge = "unverified";
  envelope.ageMs = 1_800_000;
  for (const bar of envelope.data.bars) bar.availableAt = null;
  envelope.gaps = [
    {
      code: "unverified_time",
      field: "/data/bars",
      detail:
        "The source does not establish the publication time of these values.",
    },
  ];
  return {
    scope: { ...structuredClone(scope), cutoff: envelope.cutoff },
    request: structuredClone(request),
    envelope,
  };
}
const contexts: {
  directory: string;
  root: DataRoot;
  cache: SqliteCache;
  service: QueryService;
}[] = [];
function setup(cutoff = scope.cutoff, date = scope.date) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-query-snapshots-"));
  const root = new DataRoot(directory);
  const store = new RunStore<RunState>(root);
  const runs = new RunService(store, () => "2024-01-09T00:00:00.000Z");
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 10,
  });
  let sourceCalls = 0;
  const service = new QueryService(
    {
      yahoo: {
        capability: { ...marketCapability("yahoo", "US"), adapterVersion: "2" },
        query: async () => {
          sourceCalls++;
          throw new Error("A captured snapshot must not query the source.");
        },
      },
    },
    cache,
    runs,
    { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 60_000 },
  );
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope: { ...scope, cutoff, date },
        mode: "quick",
        tasks: [
          {
            id: "analysis",
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
    },
    "open",
  );
  const operation = {
    ...runs.claim({ runId, identity: "owner" }, "analysis", "claim"),
    identity: "worker",
    sessionId: null,
  };
  const context = {
    directory,
    root,
    store,
    runs,
    cache,
    service,
    operation,
    sourceCalls: () => sourceCalls,
  };
  contexts.push(context);
  return context;
}
afterEach(async () => {
  for (const c of contexts.splice(0)) {
    await c.service.close();
    c.cache.close();
    c.root.close();
    fs.rmSync(c.directory, { recursive: true, force: true });
  }
});

describe("precollected task query snapshots", () => {
  it("derives return endpoints from the same captured history without a second source request", async () => {
    const c = setup();
    const captured = snapshot();
    const before = structuredClone(captured);
    const returns: PriceReturnsQuery = {
      dataset: "returns",
      provider: "yahoo",
      parameters: {
        historyStartDate: "2024-01-02",
        startDate: "2024-01-03",
        endDate: "2024-01-08",
        maxAgeMs: 7_200_000,
        comparable: false,
      },
    };
    const selected = selectQuerySnapshot(returns, [captured]);
    const result = await c.service.queryForTask(
      c.operation,
      returns,
      "returns",
      undefined,
      selected,
    );
    expect(result.envelope.data.start?.price).toBe(12);
    expect(result.envelope.data.end?.price).toBe(13);
    expect(result.envelope.data.value).toBeNull();
    expect(result.envelope.gaps).toContainEqual(
      expect.objectContaining({ code: "incomparable" }),
    );
    expect(result.envelope.retrievedAt).toBe(captured.envelope.retrievedAt);
    expect(result.envelope.source).toEqual(captured.envelope.source);
    expect(result.envelope.candidateClaims).toContainEqual(
      expect.objectContaining({
        value: 13,
        source: expect.objectContaining({
          evidenceId: result.sourceRef.evidenceId,
          selector: "/data/end/price",
        }),
      }),
    );
    expect(captured).toEqual(before);
    expect(c.sourceCalls()).toBe(0);
    for (const unsupported of [
      { ...returns, provider: "tencent" as const },
      {
        ...returns,
        parameters: { ...returns.parameters, historyStartDate: "2024-01-01" },
      },
      {
        ...returns,
        parameters: { ...returns.parameters, endDate: "2024-01-05" },
      },
    ])
      expect(selectQuerySnapshot(unsupported, [captured])).toBeUndefined();
  });
  it("registers captured values and candidates without querying, and reuses the receipt", async () => {
    const c = setup();
    const captured = snapshot();
    const before = structuredClone(captured);
    const first = await c.service.queryForTask(
      c.operation,
      request,
      "data",
      undefined,
      captured,
    );
    expect(c.sourceCalls()).toBe(0);
    expect(first.envelope).toMatchObject({
      ...before.envelope,
      cutoff: scope.cutoff,
      ageMs: 3_600_000,
    });
    expect(first.envelope.candidateClaims.length).toBeGreaterThan(0);
    expect(
      first.envelope.candidateClaims.every(
        (claim) => claim.source.evidenceId === first.sourceRef.evidenceId,
      ),
    ).toBe(true);
    expect(captured).toEqual(before);
    const replacement = snapshot();
    replacement.envelope.data.bars[0]!.close = 999;
    const repeated = await c.service.queryForTask(
      c.operation,
      request,
      "data",
      undefined,
      replacement,
    );
    expect(repeated).toEqual(first);
    expect(c.store.read(c.operation.runId).evidence).toHaveLength(1);
    expect(c.sourceCalls()).toBe(0);
  });

  it.each([
    "security",
    "date",
    "request",
    "cutoff",
    "source",
    "envelope_cutoff",
  ] as const)(
    "rejects a mismatched %s without querying or registering evidence",
    async (field) => {
      const c = setup();
      const captured = snapshot();
      if (field === "security")
        captured.scope.security = {
          ...US_SECURITY,
          id: "US:AAPL",
          symbol: "AAPL",
        };
      if (field === "date") captured.scope.date = "2024-01-07";
      if (field === "request") captured.request.parameters.maxAgeMs = 1;
      if (field === "cutoff") {
        captured.scope.cutoff = "2024-01-08T23:00:00.000Z";
        captured.envelope.cutoff = captured.scope.cutoff;
      }
      if (field === "source") captured.envelope.source.provider = "tencent";
      if (field === "envelope_cutoff") captured.envelope.cutoff = scope.cutoff;
      await expect(
        c.service.queryForTask(
          c.operation,
          request,
          "data",
          undefined,
          captured,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(c.sourceCalls()).toBe(0);
      expect(c.store.read(c.operation.runId).evidence).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps freshness restrictions when cutoff advances (already stale=%s)",
    async (alreadyStale) => {
      const cutoff = "2024-01-09T21:00:00.000Z";
      const c = setup(cutoff, "2024-01-09");
      const captured = snapshot();
      captured.scope.date = "2024-01-09";
      captured.scope.cutoff = "2024-01-09T20:59:59.999Z";
      captured.envelope.cutoff = captured.scope.cutoff;
      captured.envelope.retrievedAt = "2024-01-09T20:58:00.000Z";
      captured.envelope.ageMs = 86_399_999;
      captured.envelope.stale = alreadyStale;
      if (alreadyStale)
        captured.envelope.gaps.push({
          code: "stale",
          field: "/asOf",
          detail: "The source marked this observation stale.",
        });
      const before = structuredClone(captured);
      const result = await c.service.queryForTask(
        c.operation,
        request,
        "data",
        undefined,
        captured,
      );
      expect(result.envelope).toMatchObject({
        cutoff,
        ageMs: 86_400_000,
        stale: true,
      });
      expect(result.envelope.gaps).toEqual(
        expect.arrayContaining(before.envelope.gaps),
      );
      expect(result.envelope.gaps.some((gap) => gap.code === "stale")).toBe(
        true,
      );
      expect(result.envelope.data).toEqual(before.envelope.data);
      expect(result.envelope.retrievedAt).toBe(before.envelope.retrievedAt);
      expect(captured).toEqual(before);
      expect(c.sourceCalls()).toBe(0);
    },
  );

  it("adopts a Friday capture before Monday close without treating closed dates as stale", async () => {
    const cutoff = "2024-01-08T20:30:00.000Z";
    const c = setup(cutoff);
    const captured = snapshot();
    captured.scope.cutoff = "2024-01-08T20:00:00.000Z";
    captured.envelope.cutoff = captured.scope.cutoff;
    captured.envelope.data.bars = captured.envelope.data.bars.filter(
      (bar) => bar.date <= "2024-01-05",
    );
    captured.envelope.asOf = "2024-01-05T21:00:00.000Z";
    captured.envelope.retrievedAt = "2024-01-08T19:59:00.000Z";
    const before = structuredClone(captured);
    const result = await c.service.queryForTask(
      c.operation,
      request,
      "data",
      undefined,
      captured,
    );
    expect(result.envelope.ageMs).toBe(257400000);
    expect(result.envelope.stale).toBe(false);
    expect(result.envelope.gaps).toEqual(before.envelope.gaps);
    expect(captured).toEqual(before);
    expect(c.sourceCalls()).toBe(0);
  });
});

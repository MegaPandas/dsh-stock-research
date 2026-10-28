import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateIndicators,
  calculatePriceReturn,
  createCacheKey,
  HttpClient,
  HttpStatusError,
  parseISOTime,
  parseLocalDate,
  ResearchError,
  SqliteCache,
  YahooMarketAdapter,
  EastmoneyMarketAdapter,
  TencentMarketAdapter,
  SecConceptAdapter,
  EastmoneyIncomeAdapter,
  SinaIncomeAdapter,
  FredCsvAdapter,
  HostResearchAdapter,
  DataRoot,
  RunStore,
  MemoryStore,
  MemoryService,
  renderArtifact,
  validateRunDefinition,
  RunService,
  QueryService,
  NumberService,
  ArtifactService,
  DecisionService,
  DigestService,
  NUMBER_CHECK_VERSION,
  INDICATORS_ALGORITHM_VERSION,
  PRICE_RETURN_ALGORITHM_VERSION,
  agentReportSchemas,
  parseAgentReport,
  renderAgentReport,
} from "@megapandas/dsh-stock-research/core";
import { openDecisionSample } from "./decision-sample.mjs";
import { openDigestSample, sampleDigestReply } from "./digest-sample.mjs";

assert.equal(parseISOTime("2024-01-02T21:00:00Z"), "2024-01-02T21:00:00.000Z");
assert.equal(parseLocalDate("2024-02-29"), "2024-02-29");
assert.throws(() => parseLocalDate("2023-02-29"), { code: "INVALID_INPUT" });
assert.ok(new ResearchError("INVALID_INPUT", "sample") instanceof Error);
const answer = parseAgentReport("ask", {
  summary: "收盘价来自固定快照。",
  content: { explanation: [], limitations: [] },
});
assert.equal(renderAgentReport("ask", answer), `${answer.summary}\n`);
assert.equal(agentReportSchemas.ask.additionalProperties, false);
const definition = {
  scope: {
    security: {
      id: "US:NVDA",
      market: "US",
      symbol: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      timeZone: "America/New_York",
    },
    date: "2024-01-02",
    cutoff: "2024-01-02T21:00:00.000Z",
  },
  mode: "quick",
  tasks: [
    {
      id: "analysis",
      executor: { kind: "role", role: "analyst", specialty: "market" },
      dependsOn: [],
      inputTasks: [],
      outputKinds: ["analysis"],
      dataRequirements: [],
      instructionVersion: 1,
    },
  ],
};
assert.equal(validateRunDefinition(definition), undefined);
const http = new HttpClient({
  timeoutMs: 1_000,
  maxConcurrency: 1,
  minIntervalMs: 0,
});
assert.deepEqual(
  [YahooMarketAdapter, EastmoneyMarketAdapter, TencentMarketAdapter].map(
    (Adapter) => new Adapter(http).capability.provider,
  ),
  ["yahoo", "eastmoney", "tencent"],
);
assert.equal(
  new SecConceptAdapter(http, "CedarResearch/0.1").capability.provider,
  "sec",
);
assert.equal(
  new EastmoneyIncomeAdapter(http).capability.dataset,
  "fundamentals",
);
assert.equal(new SinaIncomeAdapter(http).capability.provider, "sina");
assert.equal(new FredCsvAdapter(http).capability.dataset, "macro");
assert.equal(
  new HostResearchAdapter(async () => ({ sources: [], truncated: false }))
    .capability.provider,
  "dsh-web",
);
await http.close();
const dataDirectory = mkdtempSync(join(tmpdir(), "dsh-stock-package-"));
let dataRoot;
try {
  dataRoot = new DataRoot(dataDirectory);
  const runs = new RunStore(dataRoot);
  const run = runs.create(
    { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
    (runId, writer) => {
      const evidence = writer.evidence((id) => ({ id, runId, value: 7 }));
      const artifact = writer.artifact(null, () => ({
        kind: "analysis",
        title: "Package sample",
        body: "Price: {{number:price}}.",
        claims: [
          {
            id: "price",
            kind: "observed",
            value: 7,
            unit: "USD/share",
            source: { runId, evidenceId: evidence.id, selector: "/value" },
          },
        ],
        inputRefs: [],
        payload: {},
      }));
      return { evidence, artifact };
    },
  );
  assert.equal(runs.readContent(run.runId, run.evidence).value, 7);
  const batch = runs.readContents(run.runId, [run.evidence, run.artifact]);
  assert.equal(batch[0].value, 7);
  assert.equal(batch[1].title, "Package sample");
  const markdown = renderArtifact(runs.readContent(run.runId, run.artifact));
  runs.syncProjections(run.runId, run.revision, [
    { target: { filename: "report.md" }, content: markdown },
  ]);
  assert.match(markdown, /Price: 7 USD\/share\./);
  assert.equal(
    readFileSync(
      join(
        dataDirectory,
        "runs",
        "2024-01-02",
        `US_NVDA-quick-${run.runId}`,
        "report.md",
      ),
      "utf8",
    ),
    markdown,
  );
  const memory = new MemoryStore(dataRoot, () => ({ last: null }));
  const remembered = memory.commit((_current, writer) => ({
    last: writer.entry(null, (ref) => ({ ref, note: "package sample" })),
  }));
  assert.equal(memory.readEntry(remembered.last).note, "package sample");
} finally {
  try {
    dataRoot?.close();
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}
assert.ok(
  new HttpStatusError(new globalThis.Response(null, { status: 503 })) instanceof
    ResearchError,
);
const serviceDirectory = mkdtempSync(
  join(tmpdir(), "dsh-stock-service-package-"),
);
let serviceRoot;
try {
  serviceRoot = new DataRoot(serviceDirectory);
  const service = new RunService(
    new RunStore(serviceRoot),
    () => "2024-01-03T00:00:00.000Z",
  );
  const versions = {
    plugin: "0.1.0-dev.1",
    mode: "package-fixture",
    prompts: {},
    skills: {},
    adapters: {},
    normalization: {},
  };
  const { runId } = service.open(
    "package",
    {
      definition,
      versions,
      inputs: [{ name: "instruction", content: "Package entry verification" }],
    },
    "open",
  );
  const claimed = service.claim(
    { runId, identity: "package" },
    "analysis",
    "claim",
  );
  const taskOperation = {
    runId,
    identity: "package-task",
    taskId: "analysis",
    attempt: claimed.attempt,
    sessionId: null,
  };
  const memories = new MemoryService(
    new MemoryStore(serviceRoot, () => ({ stateVersion: 1, receipts: [] })),
    service,
    async () => {
      throw new Error("Package memory fixture must not query returns.");
    },
    () => definition.scope.cutoff,
  );
  try {
    const note = "Package memory note with unavailable returns";
    const ref = await memories.remember(
      { runId, identity: "package", scope: definition.scope },
      {
        previous: null,
        outcome: "Package fixture reviewed",
        note,
        evidence: [],
        returns: {
          kind: "unavailable",
          gaps: [
            {
              code: "missing",
              field: "/returns",
              detail: "Synthetic package fixture has no return observations.",
            },
          ],
        },
      },
      "remember-package",
    );
    const snapshot = memories.recallForTask(
      taskOperation,
      { runId, text: "Package memory note", limit: 1 },
      "memory-service-package",
    );
    assert.equal(snapshot.entries.length, 1);
    assert.equal(ref.revision, 1);
    assert.equal(snapshot.entries[0].content.note, note);
    assert.deepEqual(snapshot.entries[0].ref, ref);
    assert.deepEqual(snapshot.entries[0].content.ref, ref);
    assert.equal(snapshot.entries[0].content.returns.kind, "unavailable");
  } finally {
    await memories.close();
  }
  const query = {
    dataset: "market",
    provider: "package-fixture",
    parameters: {},
  };
  assert.equal(
    service.evidenceForCall(taskOperation, query, "data").sourceRef,
    null,
  );
  const source = service.recordEvidence(
    taskOperation,
    query,
    {
      envelope: {
        dataset: "market",
        data: { price: 7 },
        source: {
          provider: "package-fixture",
          url: "https://example.com/package-sample",
          adapterVersion: "1",
          normalizationVersion: "1",
        },
        asOf: definition.scope.cutoff,
        retrievedAt: "2024-01-03T00:00:00.000Z",
        availableAt: null,
        cutoff: definition.scope.cutoff,
        ageMs: 0,
        stale: false,
        historicalKnowledge: "unverified",
        gaps: [
          {
            code: "unverified_time",
            field: "/data",
            detail: "Synthetic package fixture",
          },
        ],
      },
      candidates: [
        {
          candidateId: "price",
          label: "Price",
          value: 7,
          unit: "USD/share",
          asOf: definition.scope.cutoff,
          selector: "/data/price",
        },
      ],
    },
    "data",
  );
  assert.deepEqual(
    service.readEvidence(source).envelope.candidateClaims[0].source,
    { ...source, selector: "/data/price" },
  );
  const memory = service.recordMemoryInput(
    taskOperation,
    { scope: { securityId: "US:NVDA" }, parameters: {} },
    [],
    "recall",
  );
  assert.deepEqual(service.readInput(runId, memory.inputRef).entries, []);
  const queryCache = new SqliteCache({ path: ":memory:", maxEntries: 8 });
  let searches = 0;
  let marketCalls = 0;
  let savedMarket;
  const marketRequest = {
    dataset: "market",
    provider: "yahoo",
    parameters: {
      startDate: "2024-01-02",
      maxAgeMs: 60_000,
      indicators: [{ kind: "sma", period: 1 }],
    },
  };
  const queries = new QueryService(
    {
      yahoo: {
        capability: new YahooMarketAdapter(http).capability,
        async query(input) {
          marketCalls++;
          assert.equal(input.startDate, "2024-01-02");
          assert.equal(input.scope.date, "2024-01-02");
          return {
            dataset: "market",
            data: {
              currency: "USD",
              adjustment: "split_adjusted",
              bars: [
                {
                  date: "2024-01-02",
                  asOf: definition.scope.cutoff,
                  availableAt: null,
                  sessionComplete: true,
                  open: 7,
                  high: 8,
                  low: 6,
                  close: 7,
                  volume: 100,
                },
              ],
            },
            source: {
              provider: "yahoo",
              url: "https://example.com/package-market",
              adapterVersion: "2",
              normalizationVersion: "1",
            },
            asOf: definition.scope.cutoff,
            availableAt: null,
            retrievedAt: "2024-01-03T00:00:00.000Z",
            cutoff: definition.scope.cutoff,
            ageMs: 0,
            stale: false,
            historicalKnowledge: "unverified",
            gaps: [
              {
                code: "unverified_time",
                field: "/data",
                detail: "Synthetic package fixture.",
              },
            ],
          };
        },
      },
      research: new HostResearchAdapter(async (request, signal) => {
        searches++;
        assert.deepEqual(request, { query: "NVDA earnings", maxResults: 1 });
        assert.ok(signal instanceof globalThis.AbortSignal);
        return {
          sources: [{ url: "https://example.com/earnings", snippet: "Sample" }],
          truncated: false,
        };
      }),
    },
    queryCache,
    service,
    { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 60_000 },
  );
  try {
    const request = {
      dataset: "research",
      provider: "dsh-web",
      parameters: { query: "NVDA earnings", maxResults: 1 },
    };
    const ordinary = await queries.query(definition.scope, request);
    const registered = await queries.queryForTask(
      taskOperation,
      request,
      "search",
    );
    assert.equal(registered.sourceRef.runId, runId);
    assert.deepEqual(registered.envelope.data, ordinary.data);
    assert.equal(registered.envelope.retrievedAt, ordinary.retrievedAt);
    assert.deepEqual(registered.envelope.candidateClaims, []);
    assert.deepEqual(
      await queries.queryForTask(taskOperation, request, "search"),
      registered,
    );
    assert.equal(queries.health(definition.scope).sources.length, 8);
    assert.equal(searches, 1);
    const market = await queries.query(definition.scope, marketRequest);
    savedMarket = market;
    assert.equal(
      market.data.indicators.algorithmVersion,
      INDICATORS_ALGORITHM_VERSION,
    );
    assert.deepEqual(market.data.indicators.series[0].values, [7]);
    const priceReturn = await queries.queryForTask(
      taskOperation,
      {
        dataset: "returns",
        provider: "yahoo",
        parameters: {
          historyStartDate: "2024-01-02",
          startDate: "2024-01-02",
          endDate: "2024-01-02",
          maxAgeMs: 60_000,
          comparable: true,
        },
      },
      "returns",
    );
    assert.equal(
      priceReturn.envelope.data.algorithmVersion,
      PRICE_RETURN_ALGORITHM_VERSION,
    );
    assert.equal(priceReturn.envelope.data.value, 0);
    assert.equal(
      priceReturn.envelope.candidateClaims.at(-1).source.selector,
      "/data/value",
    );
    assert.equal(marketCalls, 1);
  } finally {
    try {
      await queries.close();
    } finally {
      queryCache.close();
    }
  }
  const artifactService = new ArtifactService(
    service,
    new NumberService(service),
  );
  const result = artifactService.submitArtifact(
    taskOperation,
    [
      {
        kind: "analysis",
        title: "Sample",
        body: "Package sample",
        inputRefs: [],
        claims: [],
        payload: {
          findings: [{ text: "Package sample", evidence: [], numbers: [] }],
          risks: [],
          gaps: [],
        },
      },
    ],
    "submit",
  );
  assert.equal(
    service.readArtifact(result.refs[0]).content.body,
    "Package sample",
  );
  assert.equal(service.view({ runId }).tasks[0].status, "succeeded");
  const digestSample = openDigestSample(service, "digest-sample", 1);
  const digestResult = await new DigestService(
    service,
    artifactService,
    async (input, _signal, _operation, submit) =>
      submit(sampleDigestReply(input)),
  ).makeDigest(digestSample.operation, digestSample.taskId, "digest");
  const digestContent = service.readArtifact(digestResult.refs[0]).content;
  assert.equal(digestContent.payload.numbers.length, 1);
  assert.equal(digestContent.payload.gaps[0].kind, "source");
  assert.match(digestContent.body, /100 USD\/share/);
  const sample = openDecisionSample(service, "decision-sample");
  const decided = new DecisionService(
    service,
    () => "2024-01-04T00:00:00.000Z",
  ).decide(sample.operation, sample.taskId, "decide");
  assert.equal(service.view(sample.operation).status, "completed");
  assert.equal(
    service.readArtifact(decided.refs[0]).content.payload.rating,
    "buy",
  );
  assert.equal(
    service.readArtifact(decided.refs[1]).content.payload.gaps.length,
    0,
  );
  const operation = { runId, identity: "package" };
  assert.deepEqual(service.redo(operation, "analysis", "redo").affectedTasks, [
    "analysis",
  ]);
  const blocked = service.block(
    operation,
    [
      {
        taskId: null,
        attempt: null,
        code: "REVIEW",
        message: "Package fixture",
      },
    ],
    "block",
  );
  service.resume(
    operation,
    {
      resolvedReasonIds: blocked.reasonIds,
      instructions: [
        { taskId: "analysis", instruction: "Revised package sample" },
      ],
    },
    "resume",
  );
  const next = service.claim(operation, "analysis", "claim-2");
  assert.equal(next.instructionVersion, 2);
  assert.equal(
    service.readInput(runId, next.instructionRef).instruction,
    "Revised package sample",
  );
  const nextOperation = { ...taskOperation, attempt: next.attempt };
  const originalMarket = service.recordEvidence(
    nextOperation,
    marketRequest,
    { envelope: savedMarket, candidates: [] },
    "market",
  );
  const numbers = new NumberService(service);
  const numericContent = {
    kind: "analysis",
    title: "Numeric package fixture",
    body: "Price: {{number:price}}.",
    inputRefs: [],
    claims: [
      {
        id: "price",
        kind: "observed",
        value: 7,
        unit: "USD/share",
        source: { ...originalMarket, selector: "/data/bars/0/close" },
      },
    ],
    payload: {},
  };
  const lateCheck = numbers.checkNumbers(operation, {
    kind: "pending",
    contentId: "late",
    content: numericContent,
  });
  assert.equal(lateCheck.passed, false);
  assert.equal(lateCheck.claims[0].issues[0].code, "time");
  // A separate synthetic early capture proves known-by without clearing its time gaps.
  const capturedMarket = globalThis.structuredClone(savedMarket);
  capturedMarket.retrievedAt = definition.scope.cutoff;
  const capturedSource = service.recordEvidence(
    nextOperation,
    {
      ...marketRequest,
      parameters: { ...marketRequest.parameters, maxAgeMs: 30_000 },
    },
    { envelope: capturedMarket, candidates: [] },
    "early-market",
  );
  numericContent.claims[0].source = {
    ...capturedSource,
    selector: "/data/bars/0/close",
  };
  const earlyCheck = numbers.checkNumbers(operation, {
    kind: "pending",
    contentId: "early",
    content: numericContent,
  });
  assert.equal(earlyCheck.checkerVersion, NUMBER_CHECK_VERSION);
  assert.equal(earlyCheck.passed, true);
  assert.equal(earlyCheck.claims[0].warnings[0].gap.code, "unverified_time");
  const replayMemoryQuery = {
    scope: { securityId: "US:NVDA" },
    parameters: {},
  };
  const originalMemory = service.recordMemoryInput(
    nextOperation,
    replayMemoryQuery,
    [],
    "memory",
  );
  assert.deepEqual(service.cancel(operation, "cancel").stopAttempts, [
    { taskId: "analysis", attempt: 2 },
  ]);
  const derived = service.open(
    "package",
    { replay: { runId }, versions },
    "replay",
  );
  assert.equal(service.view(derived).scope.cutoff, definition.scope.cutoff);
  assert.equal(service.view(derived).lineage.sourceRunId, runId);
  assert.equal(service.replaySnapshot(derived.runId).tasks[0].attempt, 2);
  const replayClaim = service.claim(
    { ...derived, identity: "package" },
    "analysis",
    "claim",
  );
  assert.equal(replayClaim.instructionVersion, 2);
  assert.equal(
    service.readInput(derived.runId, replayClaim.instructionRef).instruction,
    "Revised package sample",
  );
  const replayOperation = {
    ...replayClaim,
    identity: "package-task",
    sessionId: null,
  };
  const offlineCache = new SqliteCache({ path: ":memory:", maxEntries: 8 });
  const offline = new QueryService({}, offlineCache, service, {
    market: 60_000,
    fundamentals: 60_000,
    macro: 60_000,
    research: 60_000,
  });
  try {
    const result = await offline.replayForTask(
      replayOperation,
      marketRequest,
      "market",
    );
    assert.deepEqual(result.envelope.data, savedMarket.data);
    assert.deepEqual(result.envelope.candidateClaims, []);
    assert.deepEqual(
      service.readEvidence(result.sourceRef).replayedFrom,
      originalMarket,
    );
    const remembered = service.replayMemoryInput(
      replayOperation,
      replayMemoryQuery,
      "memory",
    );
    const snapshot = service.readInput(derived.runId, remembered.inputRef);
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.replayedFrom, originalMemory);
  } finally {
    try {
      await offline.close();
    } finally {
      offlineCache.close();
    }
  }
} finally {
  try {
    serviceRoot?.close();
  } finally {
    rmSync(serviceDirectory, { recursive: true, force: true });
  }
}
const cache = new SqliteCache({ path: ":memory:", maxEntries: 1 });
const key = {
  provider: "fixture",
  securityId: "US:NVDA",
  dataset: "market",
  cutoff: "2024-01-02T21:00:00.000Z",
  parameters: {},
  adapterVersion: "1",
  normalizationVersion: "1",
};
try {
  assert.equal(typeof createCacheKey(key), "string");
  assert.equal(cache.get(key), undefined);
} finally {
  cache.close();
}
assert.deepEqual(
  calculateIndicators({ currency: "USD", adjustment: "unadjusted", bars: [] }, [
    { kind: "sma", period: 3 },
  ])[0].values,
  [],
);
assert.equal(
  calculatePriceReturn({
    requestedStartDate: "2024-01-02",
    requestedEndDate: "2024-01-03",
    comparable: true,
    start: {
      date: "2024-01-02",
      price: 100,
      currency: "USD",
      adjustment: "unadjusted",
    },
    end: {
      date: "2024-01-03",
      price: 125,
      currency: "USD",
      adjustment: "unadjusted",
    },
  }).value,
  0.25,
);

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataRoot,
  ArtifactService,
  DecisionService,
  DigestService,
  MemoryService,
  MemoryStore,
  NumberService,
  QueryService,
  RunService,
  RunStore,
  SqliteCache,
  YahooMarketAdapter,
} from "dsh-stock-research/core";
import {
  createDataTools,
  createReadTools,
  createWriteTools,
  SessionBindings,
} from "dsh-stock-research/tools";
import { openDecisionSample } from "./decision-sample.mjs";

const directory = mkdtempSync(join(tmpdir(), "dsh-stock-tools-package-"));
let root;
let cache;
let queries;
let memory;
try {
  root = new DataRoot(directory);
  const runs = new RunService(
    new RunStore(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  const { operation } = openDecisionSample(runs, "read-tools");
  const initial = runs.view(operation);
  const scope = initial.scope;
  const managerRef = initial.tasks.find((task) => task.taskId === "manager")
    .outputRefs[0];
  const canonical = runs.readEvidence(
    runs.readArtifact(managerRef).content.claims[0].source,
  ).envelope;
  const capability = new YahooMarketAdapter({
    getText: async () => {
      throw new Error("No package fixture HTTP requests");
    },
  }).capability;
  let sourceCalls = 0;
  cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 1,
  });
  queries = new QueryService(
    {
      yahoo: {
        capability,
        query: async (request) => {
          assert.deepEqual(request.scope, scope);
          sourceCalls++;
          return globalThis.structuredClone({
            ...canonical,
            source: {
              ...canonical.source,
              provider: "yahoo",
              adapterVersion: capability.adapterVersion,
              normalizationVersion: capability.normalizationVersion,
            },
          });
        },
      },
    },
    cache,
    runs,
    {
      market: 60_000,
      fundamentals: 0,
      macro: 0,
      research: 0,
    },
  );
  memory = new MemoryService(
    new MemoryStore(root, () => ({ stateVersion: 1, receipts: [] })),
    runs,
    (scope, request, signal) => queries.query(scope, request, signal),
    () => "2024-01-04T00:00:00.000Z",
  );
  const bindings = new SessionBindings();
  const agent = { id: "package-coordinator" };
  bindings.bind(agent, { kind: "coordinator", runIds: [operation.runId] });
  const numbers = new NumberService(runs);
  const artifacts = new ArtifactService(runs, numbers);
  const digests = new DigestService(runs, artifacts, async () => {
    throw new Error("No package fixture model requests");
  });
  const decisions = new DecisionService(runs, () => "2024-01-04T00:00:00.000Z");
  const policy = {
    freshness: {
      market: 86_400_000,
      fundamentals: 86_400_000,
      macro: 86_400_000,
    },
    secCiks: {},
  };
  const tools = [
    ...createReadTools({ runs, queries, memory, numbers }, bindings),
    ...createDataTools({ runs, queries }, bindings, policy),
    ...createWriteTools(
      { artifacts, memory, digests, decisions },
      bindings,
      policy,
    ),
  ];
  assert.equal(tools.length, 13);
  const invoke = (name, args, caller = agent) =>
    tools
      .find((tool) => tool.name === name)
      .execute(args, {
        agent: caller,
        callId: name,
        signal: new globalThis.AbortController().signal,
      });
  const viewed = await invoke("stock_read", {
    kind: "run_view",
    runId: operation.runId,
  });
  assert.equal(viewed.view.runId, operation.runId);
  const ref = viewed.view.tasks.find((task) => task.taskId === "manager")
    .outputRefs[0];
  const checked = await invoke("stock_check_numbers", {
    kind: "artifact",
    ref,
  });
  assert.equal(checked.passed, true);
  assert.equal(checked.claims.length, 2);
  const health = await invoke("stock_data_health", { runId: operation.runId });
  assert.ok(health.sources.every((source) => source.sourceCalls === 0));
  const asker = { id: "package-ask" };
  bindings.bind(asker, { kind: "ask", scope });
  const recalled = await invoke(
    "stock_recall",
    { relatedRunId: null, text: null, limit: 1 },
    asker,
  );
  assert.deepEqual(recalled.entries, []);
  await assert.rejects(
    () =>
      invoke("stock_read", { kind: "run_view", runId: operation.runId }, asker),
    { code: "ACCESS_DENIED" },
  );
  const market = await invoke(
    "stock_get_market",
    { provider: "yahoo", startDate: scope.date },
    asker,
  );
  assert.equal(market.envelope.data.bars[0].close, 100);
  const returned = await invoke(
    "stock_get_returns",
    {
      provider: "yahoo",
      historyStartDate: scope.date,
      startDate: scope.date,
      endDate: scope.date,
    },
    asker,
  );
  assert.equal(returned.envelope.data.start.price, 100);
  assert.equal(returned.envelope.data.value, null);
  assert.ok(returned.envelope.gaps.some((gap) => gap.code === "incomparable"));
  assert.equal(sourceCalls, 1);
  await invoke("stock_decide", {
    runId: operation.runId,
    taskId: "final",
    requestId: "decide",
  });
  assert.equal(runs.view(operation).status, "completed");
  const reviewer = { id: "package-reviewer" };
  bindings.bind(reviewer, {
    kind: "review",
    runId: operation.runId,
    scope: { ...scope, date: "2024-01-04", cutoff: "2024-01-04T00:00:00.000Z" },
  });
  const before = runs.view(operation);
  const remembered = await invoke(
    "stock_remember",
    {
      requestId: "remember",
      input: {
        previous: null,
        outcome: "Synthetic review",
        note: "Public tools package sample",
        evidence: [managerRef],
        returns: {
          kind: "unavailable",
          gaps: [
            {
              code: "missing",
              field: "/returns",
              detail: "No review return requested",
            },
          ],
        },
      },
    },
    reviewer,
  );
  assert.equal(remembered.revision, 1);
  assert.deepEqual(runs.view(operation), before);
  const target = runs.open(
    "package",
    {
      definition: {
        scope,
        mode: "quick",
        tasks: [
          {
            id: "analysis",
            executor: { kind: "role", role: "analyst", specialty: "synthetic" },
            dependsOn: [],
            inputTasks: [],
            outputKinds: ["analysis"],
            dataRequirements: [],
            instructionVersion: 1,
          },
        ],
      },
      versions: {
        plugin: "0.1.0-dev.1",
        mode: "synthetic",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "writer",
  );
  const claim = runs.claim(
    { ...target, identity: "package" },
    "analysis",
    "writer-claim",
  );
  const writer = { id: "package-writer" };
  bindings.bind(writer, {
    kind: "task",
    runId: target.runId,
    taskId: "analysis",
    attempt: claim.attempt,
  });
  const saved = await invoke(
    "stock_save_report",
    {
      requestId: "save",
      contents: [
        {
          kind: "analysis",
          title: "Sample",
          body: "Synthetic package sample",
          claims: [],
          inputRefs: [],
          payload: {
            findings: [{ text: "Sample", evidence: [], numbers: [] }],
            risks: [],
            gaps: [],
          },
        },
      ],
    },
    writer,
  );
  assert.equal(saved.refs.length, 1);
  assert.equal(runs.view(target).tasks[0].status, "succeeded");
  console.log(
    JSON.stringify({
      fixture:
        "synthetic package data, real local storage/cache; no network or model",
      tools: tools.length,
      nativeSchemaBytes: Buffer.byteLength(
        JSON.stringify(
          tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        ),
      ),
      sourceCalls,
      modelCalls: 0,
    }),
  );
} finally {
  try {
    await memory?.close();
  } finally {
    try {
      await queries?.close();
    } finally {
      try {
        cache?.close();
      } finally {
        try {
          root?.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
}

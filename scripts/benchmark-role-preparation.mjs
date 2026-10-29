import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { SessionId } from "@deepseek-ai/dsh-session";

// An optional built checkout allows the same workload to compare frozen versions.
const packageRoot =
  process.argv[2] === undefined
    ? fileURLToPath(new URL("../", import.meta.url))
    : resolve(process.argv[2]);
const { createResearchPlugin, Config } = await import(
  pathToFileURL(join(packageRoot, "dist/runtime.mjs")).href
);
const { createQuickInput, prepareResearchRole } = await import(
  pathToFileURL(join(packageRoot, "dist/application.mjs")).href
);
const directory = mkdtempSync(join(tmpdir(), "dsh-role-preparation-bench-"));
const ctx = new Context();
const iterations = 100;
const batches = 9;
const measurements = [];
function measure(label, prepare) {
  for (let i = 0; i < 30; i++) prepare();
  const samples = [];
  for (let batch = 0; batch < batches; batch++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) prepare();
    samples.push((performance.now() - started) / iterations);
  }
  const provision = prepare();
  const sorted = [...samples].sort((a, b) => a - b);
  measurements.push({
    label,
    iterations,
    batches,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    batchMeansMs: samples,
    tools: provision.tools.map(({ name }) => name),
    promptBytes: Buffer.byteLength(JSON.stringify(provision.prompt)),
  });
}
try {
  await mountAgentLoopTestDependencies(ctx, {
    workingDirectory: true,
    tools: { mode: "native" },
  });
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  await ctx.plugin(AgentPresetRegistry, { default: "benchmark-research" });
  await ctx.agentPresets.register({ id: "benchmark-research", plugins: [] });
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(SubagentRuntime, {});
  await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
  await ctx.plugin(
    createResearchPlugin((context, parent) =>
      prepareResearchRole(ctx.stockResearch, context, parent),
    ),
    Config({
      dataRoot: directory,
      enabledSources: ["sina", "tencent"],
      http: { timeoutMs: 1000, maxConcurrency: 1, minIntervalMs: 1000 },
      cache: {
        maxEntries: 10,
        ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
      },
      policy: {
        freshness: { market: 0, fundamentals: 0, macro: 0 },
        secCiks: {},
      },
    }),
  );
  const runtime = ctx.stockResearch;
  const scope = {
    security: {
      id: "CN:002594.SZ",
      market: "CN",
      symbol: "002594.SZ",
      exchange: "SZ",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
    date: "2026-10-29",
    cutoff: "2026-10-29T15:59:59.999Z",
  };
  const input = createQuickInput(scope, runtime.policy, []);
  const { runId } = runtime.runs.open("benchmark", input, "open");
  const operation = { runId, identity: "benchmark" };
  for (const taskId of ["analysis.market", "analysis.fundamentals"]) {
    const context = runtime.runs.dispatchForCall(operation, taskId, taskId);
    measure(taskId, () => prepareResearchRole(runtime, context));
    if (taskId !== "analysis.fundamentals") continue;
    const handle = await runtime.createAgent(
      { sessionId: SessionId("benchmark-calculations") },
      { kind: "task", runId, taskId, attempt: context.claim.attempt },
      [],
    );
    try {
      const calculate = runtime.tools.find(
        ({ name }) => name === "stock_calculate_valuation",
      );
      const request = {
        methodId: "comparable_multiples",
        purpose: "valuation",
        amountUnit: "hundred_million",
        shares: { value: 10, unit: "hundred_million" },
        inputs: { multipleType: "ps", revenue: 450, multiples: [0.3, 0.5] },
        assumptions: ["Synthetic benchmark inputs"],
        provenance: [
          { path: "/inputs", kind: "assumed", basis: "Synthetic scenario" },
          { path: "/shares", kind: "assumed", basis: "Synthetic scenario" },
        ],
        sensitivities: [],
      };
      for (let i = 0; i < 10; i++) {
        const result = await calculate.execute(request, {
          agent: handle.agent,
          callId: `calculation-${i}`,
          signal: new globalThis.AbortController().signal,
        });
        assert.deepEqual(result.result.perShareValues, [13.5, 22.5]);
      }
      measure("analysis.fundamentals/10-calculations", () =>
        prepareResearchRole(runtime, context),
      );
    } finally {
      await handle.dispose();
    }
  }
  assert.ok(
    runtime.queries
      .health(scope)
      .sources.every(({ sourceCalls }) => sourceCalls === 0),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        packageRoot,
        workload:
          "Real runtime and local storage; synthetic fixed inputs; role construction only; no models or source requests",
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await ctx.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

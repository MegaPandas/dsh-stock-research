import assert from "node:assert/strict";
import console from "node:console";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { DataRoot } from "@megapandas/dsh-stock-research/core";
import {
  Config,
  createResearchPlugin,
} from "@megapandas/dsh-stock-research/runtime";
import * as Ask from "@megapandas/dsh-stock-research/ask";
import * as Review from "@megapandas/dsh-stock-research/review";
import {
  createQuickInput,
  prepareResearchRole,
} from "@megapandas/dsh-stock-research/application";
import * as Role from "@megapandas/dsh-stock-research/role";

// Resolve from each consuming SDK package, rather than assume a hoisted copy.
for (const dependency of [
  "dsh-agent-loop",
  "dsh-llm",
  "dsh-tools",
  "dsh-subagent",
  "dsh-agent-preset-registry",
]) {
  const sdkRequire = createRequire(
    import.meta.resolve(`@deepseek-ai/${dependency}`),
  );
  const resolved = sdkRequire.resolve("zod/package.json");
  assert.equal(JSON.parse(readFileSync(resolved, "utf8")).version, "4.6.6");
}

const directory = mkdtempSync(join(tmpdir(), "dsh-stock-runtime-package-"));
const ctx = new Context();
let plugin;
try {
  await mountAgentLoopTestDependencies(ctx, {
    workingDirectory: true,
    tools: { mode: "native" },
  });
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  await ctx.plugin(AgentPresetRegistry, { default: "package-research" });
  await ctx.agentPresets.register({ id: "package-research", plugins: [] });
  const presetRoster = await ctx.agentPresets.remoteExportList();
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(SubagentRuntime, {});
  await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
  const config = Config({
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
    digestModel: { provider: "unused", model: "unused" },
  });
  plugin = ctx.plugin(
    createResearchPlugin((context, parent) =>
      prepareResearchRole(ctx.stockResearch, context, parent),
    ),
    config,
  );
  await plugin;
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), presetRoster);
  const runtime = ctx.stockResearch;
  assert.equal(runtime.tools.length, 23);
  assert.deepEqual(
    ctx.tools.schemas().filter(({ name }) => name.startsWith("stock_")),
    [],
  );
  const scope = {
    security: {
      id: "CN:002594.SZ",
      market: "CN",
      symbol: "002594.SZ",
      exchange: "SZ",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
    date: "2024-01-03",
    cutoff: "2024-01-03T08:00:00.000Z",
  };
  const handle = await runtime.createAgent(
    { sessionId: SessionId("runtime-package") },
    { kind: "ask", scope },
    runtime.tools.filter((tool) => tool.name === "stock_data_health"),
  );
  await ctx.plugin(CommandRuntime);
  const ask = ctx.plugin(Ask, { provider: "unused", model: "unused" });
  await ask;
  assert.equal(ctx.commands.find(handle.agent, "stock-ask").name, "stock-ask");
  const review = ctx.plugin(Review, { provider: "unused", model: "unused" });
  await review;
  assert.equal(
    ctx.commands.find(handle.agent, "stock-review").name,
    "stock-review",
  );
  const result = await ctx.tools.execute({
    agent: handle.agent,
    name: "stock_data_health",
    arguments: {},
    callId: ToolCallId("package-health"),
    signal: new globalThis.AbortController().signal,
  });
  assert.equal(result.isError, false);
  assert.equal(result.value.sources.length, 8);
  assert.deepEqual(
    result.value.sources
      .filter((source) => source.capability !== null)
      .map((source) => `${source.dataset}/${source.provider}`)
      .sort(),
    ["fundamentals/sina", "market/tencent"],
  );
  assert.ok(result.value.sources.every((source) => source.sourceCalls === 0));
  const input = createQuickInput(scope, runtime.policy, result.value.sources);
  const manifest = createRequire(import.meta.url)(
    "@megapandas/dsh-stock-research/package.json",
  );
  assert.equal(input.versions.plugin, manifest.version);
  assert.equal(input.versions.prompts.roles, "31");
  assert.equal(input.versions.prompts.digest, "12");
  assert.equal(input.definition.tasks.length, 12);
  assert.equal(input.instructions.length, 12);
  const { runId } = runtime.runs.open("package-owner", input, "open");
  const provision = prepareResearchRole(
    runtime,
    runtime.runs.dispatchForCall(
      { runId, identity: "package-owner" },
      "analysis.market",
      "claim",
    ),
  );
  assert.deepEqual(
    provision.tools.map((tool) => tool.name).sort(),
    [
      "stock_read_report_draft",
      "stock_submit",
      "stock_write_handoff",
      "stock_write_report",
    ].sort(),
  );
  assert.ok(provision.systemPrompt.length > 0);
  const publicProvision = prepareResearchRole(
    runtime,
    runtime.runs.dispatchForCall(
      { runId, identity: "package-owner" },
      "analysis.public",
      "public-claim",
    ),
  );
  assert.deepEqual(publicProvision.tools.map((tool) => tool.name).sort(), [
    "stock_read_report_draft",
    "stock_search_public",
    "stock_submit",
    "stock_write_handoff",
    "stock_write_report",
  ]);
  assert.equal(provision.agentPreset, undefined);
  assert.equal(publicProvision.agentPreset, undefined);
  assert.deepEqual(Role.Config({ role: "analyst" }), { role: "analyst" });
  await review.dispose();
  assert.equal(ctx.commands.find(handle.agent, "stock-review"), undefined);
  await ask.dispose();
  assert.equal(ctx.commands.find(handle.agent, "stock-ask"), undefined);
  await plugin.dispose();
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), presetRoster);
  assert.equal(ctx.get("stockResearch"), undefined);
  assert.equal(ctx.agents.get(handle.agent.id), undefined);
  const reopened = new DataRoot(directory);
  reopened.close();
  console.log(
    "Runtime/ask/review/application/role public entries: 23 internal tool definitions, no global tools, ask/review commands, real SDK Agent health call, quick plan and recorded role preparation, zero source/model requests, ordered teardown; consuming SDKs resolve Zod 4.6.6.",
  );
} finally {
  await plugin?.dispose();
  await ctx.fiber.dispose();
  rmSync(directory, { recursive: true, force: true });
}

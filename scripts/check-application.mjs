import assert from "node:assert/strict";
import console from "node:console";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import {
  applyEntryPatches,
  entryListSchema,
} from "@deepseek-ai/cordis-plugin-include";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import WebRuntime from "@deepseek-ai/dsh-web";
import { DataRoot } from "@megapandas/dsh-stock-research/core";
import {
  createDeepInput,
  DEEP_MODE_VERSION,
} from "@megapandas/dsh-stock-research/application";

const require = createRequire(import.meta.url);
const manifest = require("@megapandas/dsh-stock-research/package.json");
const includeRequire = createRequire(
  import.meta.resolve("@deepseek-ai/cordis-plugin-include"),
);
// Use the Include package's actual YAML parser and exported dialect.
const yaml = includeRequire("js-yaml");
const patches = yaml.load(
  readFileSync(
    new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url),
    "utf8",
  ),
  { schema: entryListSchema },
);
const entries = applyEntryPatches([], patches, (message) => {
  throw new Error(message);
});
const directory = mkdtempSync(join(tmpdir(), "dsh-stock-application-"));
const researchDirectory = join(directory, "stock-research");
const environmentKeys = [
  "STOCK_RESEARCH_DATA_ROOT",
  "STOCK_RESEARCH_PROVIDER",
  "STOCK_RESEARCH_MODEL",
];
const previous = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
for (const key of environmentKeys) delete process.env[key];
const ctx = new Context();
ctx.provide("dshHomePath", (...segments) => join(directory, ...segments));
try {
  await mountAgentLoopTestDependencies(ctx, {
    workingDirectory: true,
    tools: { mode: "native" },
  });
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  await ctx.plugin(AgentPresetRegistry, { default: "application-user" });
  await ctx.agentPresets.register({ id: "application-user", plugins: [] });
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(LocalJobRegistry, {});
  await ctx.plugin(SubagentRuntime, {});
  await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(WebRuntime, {});
  ctx.commands.register({
    name: "host-ping",
    description: "Host marker",
    handler: () => ({ kind: "success", text: "pong" }),
  });
  const outside = await ctx.agents.create({
    sessionId: SessionId("application-user"),
    meta: { cwd: directory },
  });
  const userPresets = await ctx.agentPresets.remoteExportList();
  await ctx.loader.root.update(entries);
  await ctx.loader.await();
  assert.ok(ctx.get("stockResearch"));
  assert.ok(existsSync(join(researchDirectory, "cache.sqlite")));
  const commands = [
    "stock-ask",
    "stock-review",
    "stock-quick",
    "stock-deep",
    "stock-status",
    "stock-resume",
    "stock-redo",
    "stock-cancel",
    "stock-recover",
    "stock-replay",
    "stock-gc",
  ];
  for (const name of commands)
    assert.equal(ctx.commands.find(outside.agent, name).name, name);
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), userPresets);
  assert.equal(ctx.stockResearch.tools.length, 17);
  const mainAgentTools = [
    "stock_start_research",
    "stock_review_stage",
    "stock_research_control",
  ];
  for (const name of mainAgentTools)
    assert.ok(
      ctx.tools.schemas(outside.agent).some((tool) => tool.name === name),
      `The current main Agent must discover ${name}`,
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
  const health = ctx.stockResearch.queries.health(scope);
  const deep = createDeepInput(scope, ctx.stockResearch.policy, health.sources);
  assert.equal(deep.definition.mode, "deep");
  assert.equal(deep.definition.tasks.length, 22);
  assert.equal(deep.versions.mode, DEEP_MODE_VERSION);
  assert.equal(deep.versions.prompts.roles, "22");
  assert.equal(deep.versions.prompts.digest, "12");
  assert.ok(health.sources.every((source) => source.sourceCalls === 0));
  // Removed entries disappear from Loader.await(); retain the actual disposal.
  const unloading = ctx.loader.resolve("stock-research").fiber.dispose();
  await ctx.loader.root.update([]);
  await unloading;
  await ctx.loader.await();
  assert.equal(ctx.get("stockResearch"), undefined);
  for (const name of commands)
    assert.equal(ctx.commands.find(outside.agent, name), undefined);
  for (const name of mainAgentTools)
    assert.ok(
      !ctx.tools.schemas(outside.agent).some((tool) => tool.name === name),
      `Application unload must remove ${name}`,
    );
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), userPresets);
  assert.equal(ctx.agents.get(outside.agent.id), outside.agent);
  assert.equal(ctx.commands.find(outside.agent, "host-ping").name, "host-ping");
  const root = new DataRoot(researchDirectory);
  root.close();
  console.log(
    "Application bundle: no STOCK_RESEARCH environment variables, DSH home data directory, official patch dialect/semantics and Loader, unchanged user preset roster, current-main-Agent research tools and command shortcuts, public deep plan, zero source/model requests, ordered unload retains host capabilities.",
  );
} finally {
  await ctx.fiber.dispose();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}

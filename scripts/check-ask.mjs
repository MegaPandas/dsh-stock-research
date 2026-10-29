import assert from "node:assert/strict";
import console from "node:console";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { parseEnv } from "node:util";
import { URL } from "node:url";
import { parse } from "yaml";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { createResearchPlugin } from "@megapandas/dsh-stock-research/runtime";
import * as Ask from "@megapandas/dsh-stock-research/ask";

const [profilePath, envPath, model, date] = process.argv.slice(2);
if ([profilePath, envPath, model, date].some((value) => value === undefined)) {
  console.error(
    "Usage: npm run check:ask -- <profile-patch.yml> <env-file> <model-id> <research-date>",
  );
  process.exit(2);
}

function profiles(node) {
  if (node === null || typeof node !== "object") return [];
  if (node.id === "llm-pi-ai" && node.config?.providers?.magpie !== undefined)
    return [node.config.providers.magpie];
  return Object.values(node).flatMap(profiles);
}

const directory = mkdtempSync(join(tmpdir(), "dsh-stock-real-ask-"));
const ctx = new Context();
const startedAt = performance.now();
const calls = new Map();
const toolCalls = new Map();
const observations = [];
const nativeFetch = globalThis.fetch;
const allowedTools = new Set([
  "stock_describe_collection",
  "stock_read_collection",
  "stock_recall",
]);
let tencentRequests = 0;
let stage = "profile";
let runtime;
let caller;
let answer;
let collectionFailures = [];
try {
  // Parse expressions as data; the existing profile is never mounted or rewritten.
  const patch = parse(readFileSync(profilePath, "utf8"), {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
  });
  const candidates = profiles(patch);
  assert.equal(candidates.length, 1, "Expected one configured magpie profile");
  const profile = candidates[0];
  assert.ok(
    profile.models.some((entry) => entry.id === model),
    "Model must exist in the operator's configured profile",
  );
  ctx.provide(
    "launchEnvironment",
    createLaunchEnvironmentSnapshot([
      { source: "process", values: process.env },
      {
        source: "user-env",
        path: envPath,
        values: parseEnv(readFileSync(envPath, "utf8")),
      },
    ]),
  );
  stage = "host";
  await mountAgentLoopTestDependencies(ctx, {
    workingDirectory: true,
    tools: { mode: "native" },
  });
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  await ctx.plugin(AgentPresetRegistry, { default: "real-ask-host" });
  await ctx.agentPresets.register({ id: "real-ask-host", plugins: [] });
  await ctx.plugin(PiAi, { providers: { magpie: profile } });
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(SubagentRuntime, {});
  await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(
    createResearchPlugin(() => {
      throw new Error("This ask acceptance case has no formal role tasks");
    }),
    {
      dataRoot: directory,
      enabledSources: ["tencent"],
      http: { timeoutMs: 20_000, maxConcurrency: 1, minIntervalMs: 2000 },
      cache: {
        maxEntries: 10,
        ttl: { market: 3_600_000, fundamentals: 0, macro: 0, research: 0 },
      },
      policy: {
        freshness: { market: 7 * 86_400_000, fundamentals: 0, macro: 0 },
        secCiks: {},
      },
    },
  );
  runtime = ctx.stockResearch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(
      input instanceof globalThis.Request ? input.url : String(input),
    );
    if (
      url.origin === "https://web.ifzq.gtimg.cn" &&
      url.pathname === "/appstock/app/fqkline/get"
    )
      tencentRequests++;
    return nativeFetch(input, options);
  };
  const collect = runtime.collection.collect.bind(runtime.collection);
  runtime.collection.collect = async (...args) => {
    const snapshot = await collect(...args);
    collectionFailures = snapshot.failures.map(({ id, provider, code }) => ({
      id,
      provider,
      code,
    }));
    const packet = snapshot.packets.find(
      (entry) => entry.id === "market.daily",
    );
    if (packet !== undefined) {
      const envelope = packet.envelope;
      observations.push({
        latest: envelope.data.rows.at(-1),
        currency: envelope.data.currency,
        adjustment: envelope.data.adjustment,
        source: envelope.source,
        gaps: envelope.gaps,
      });
    }
    return snapshot;
  };
  await ctx.plugin(Ask, { provider: "magpie", model });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (frame.type === "start") {
      const route = agent.session.requestHeader().config;
      calls.set(frame.attemptId, {
        provider: route.provider,
        model: route.model,
        sessionId: agent.id,
        usage: null,
        finish: null,
      });
    } else if (frame.type === "chunk") {
      const record = calls.get(frame.attemptId);
      if (frame.chunk.type === "usage") {
        const usage = frame.chunk.usage;
        record.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          cacheWriteTokens: usage.cacheWriteTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
        };
      }
      if (frame.chunk.type === "finish")
        record.finish = frame.chunk.reason.kind;
    }
  });
  ctx.on("session/event", (_session, event) => {
    if (event.type === "tool/call" && allowedTools.has(event.data.name))
      toolCalls.set(event.data.callId, {
        name: event.data.name,
        outcome: null,
        errorCode: null,
        errorReason: null,
      });
    if (event.type !== "tool/result") return;
    const tool = toolCalls.get(event.data.message.source.callId);
    if (tool === undefined) return;
    tool.outcome = event.data.message.isError ? "failed" : "succeeded";
    tool.errorCode = event.data.error?.code ?? null;
    tool.errorReason =
      event.data.error?.code === "INVALID_INPUT"
        ? (event.data.error.reason ?? null)
        : null;
  });
  caller = await ctx.agents.create({
    sessionId: SessionId("real-ask-caller"),
    agentOptions: { provider: "magpie", model },
    meta: { cwd: directory },
  });
  const command = `/stock-ask SZ.002594 ${date} 根据本次预采集快照，回答最近已完成交易日的收盘价、YYYY-MM-DD交易日期和未复权口径。`;
  stage = "command";
  const execution = await ctx.commands.execute(
    caller.agent,
    command,
    [],
    globalThis.AbortSignal.timeout(180_000),
  );
  answer = execution.result.text;
  stage = "acceptance";
  assert.equal(execution.result.kind, "success");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].source.provider, "tencent");
  assert.ok(Number.isFinite(observations[0].latest.values.close));
  assert.ok(
    answer.includes(String(observations[0].latest.values.close)),
    "The answer must use the observed latest close",
  );
  assert.ok(
    answer.includes(observations[0].latest.date),
    "The answer must identify the captured trading date",
  );
  assert.equal(tencentRequests, 1, "Exactly one Tencent HTTP source request");
  assert.ok(
    [...calls.values()].every(
      (call) => call.provider === "magpie" && call.model === model,
    ),
  );
  assert.ok(calls.size > 0);
  console.log(
    JSON.stringify(
      {
        case: "real ask through deterministic collection and offline SDK tools",
        target: "SZ.002594",
        date,
        durationMs: performance.now() - startedAt,
        calls: [...calls.values()],
        toolCalls: [...toolCalls.values()],
        observations,
        sourceRequests: { tencent: tencentRequests },
        collectionFailures,
        answer: execution.result.text,
      },
      null,
      2,
    ),
  );
} catch (cause) {
  // Keep credentials, provider config and raw transport responses out of tool output.
  console.error(
    JSON.stringify({
      case: "real ask",
      target: "SZ.002594",
      date,
      model,
      outcome: "failed",
      stage,
      code: cause?.code ?? cause?.name ?? "UNKNOWN",
      assertion: cause?.code === "ERR_ASSERTION" ? cause.message : undefined,
      calls: [...calls.values()],
      toolCalls: [...toolCalls.values()],
      observations,
      sourceRequests: { tencent: tencentRequests },
      collectionFailures,
      answer,
      durationMs: performance.now() - startedAt,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await caller?.dispose();
    await runtime?.close();
    await ctx.fiber.dispose();
  } finally {
    globalThis.fetch = nativeFetch;
    rmSync(directory, { recursive: true, force: true });
  }
}

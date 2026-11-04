import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv, promisify } from "node:util";
import { parse } from "yaml";
import { satisfies } from "semver";

const [
  installAnchor,
  profilePath,
  envPath,
  model,
  date,
  outputDirectory,
  existingDataRoot,
  resumeRunId,
  selection,
  reviewQuestion,
] = process.argv.slice(2);
const reviewMode = selection === "--review";
const backgroundMode = existingDataRoot === "--followup-policy-background";
const policyMode = existingDataRoot === "--followup-policy" || backgroundMode;
const followupMode = existingDataRoot === "--followup" || policyMode;
const fixtureRoute = {
  provider: "acceptance-fixture",
  model: "public-followup-policy",
};
const probeTaskId = followupMode
  ? "analysis.public"
  : reviewMode
    ? undefined
    : selection;
if (
  [installAnchor, profilePath, envPath, model, date, outputDirectory].some(
    (value) => value === undefined,
  ) ||
  (followupMode && process.argv.slice(2).length !== 7) ||
  (!followupMode &&
    (existingDataRoot === undefined) !== (resumeRunId === undefined)) ||
  (selection !== undefined && resumeRunId === undefined) ||
  (selection?.startsWith("--") && !reviewMode) ||
  (reviewQuestion !== undefined && !reviewMode) ||
  process.argv.slice(2).length > 10
) {
  console.error(
    "Usage: npm run check:quick -- <dsh-package.json> <profile-patch.yml> <env-file> <model-id> <research-date> <new-output-directory> [--followup|--followup-policy|--followup-policy-background|<existing-data-root> <source-run-id> [<probe-task-id>|--review [<review-question>]]]",
  );
  process.exit(2);
}
const execute = promisify(execFile);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(installAnchor);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const startedAt = performance.now();
const calls = new Map();
const agentInstances = new WeakMap();
let nextAgentInstance = 0;
const tools = new Map();
const streamedArguments = new Map();
const artifactTools = new Set([
  "stock_save_report",
  "stock_check_numbers",
  "stock_check_pending_numbers",
  "stock_submit",
  "stock_remember",
  "stock_review_stage",
]);
const nativeFetch = globalThis.fetch;
const fetches = { market: 0, fundamentals: 0, macro: 0, search: 0, model: 0 };
const record = {
  case: backgroundMode
    ? "background public approval with fixture-driven child model, real DSH + real search"
    : policyMode
      ? "fixture-driven model, real DSH + real search through official profile boot"
      : followupMode
        ? "real-model BYD transport and draft smoke through official profile boot"
        : `live BYD ${reviewMode ? "review" : "quick"} through official profile boot`,
  target: "SZ.002594",
  date,
  provider: policyMode ? fixtureRoute.provider : "magpie",
  model: policyMode ? fixtureRoute.model : model,
  ...(followupMode
    ? {
        workload: backgroundMode
          ? "Fixture-driven model; real DSH, native approval in separate parent turns and real public search; approval-only turns make no model requests, native settled-notice turns are counted separately; synthetic qualitative report; user UI is not covered."
          : policyMode
            ? "Fixture-driven model; real DSH, native approval and real public search; synthetic qualitative report; no live model calls."
            : "Real-model transport and draft smoke; real DSH and one free public search; approval-policy behavior is not covered.",
      }
    : {}),
  ...(policyMode ? { bootstrapModel: { provider: "magpie", model } } : {}),
  mode: reviewMode
    ? "review"
    : backgroundMode
      ? "role-followup-policy-background"
      : policyMode
        ? "role-followup-policy"
        : followupMode
          ? "role-followup-smoke"
          : probeTaskId !== undefined
            ? "role-probe"
            : resumeRunId === undefined
              ? "fresh"
              : "resume",
  outcome: "pending",
  stage: "configuration",
};
let directory;
let ctx;
let shutdown;
let caller;
let runId = resumeRunId;
let mainFailure;
let lastReply;
let lastReplySeq;
let finalizedSeq;
const controller = new globalThis.AbortController();
const cancel = () => {
  if (ctx?.get("stockResearch") === undefined) {
    controller.abort(
      new globalThis.DOMException(
        "Acceptance cancelled by operator.",
        "AbortError",
      ),
    );
    return;
  }
  record.operatorStopped = true;
  // Stop SDK turns without cancelling the invocation or its canonical run.
  for (const agent of ctx.agents.list()) agent.cancel({ kind: "user" });
};

function configurations(node, id) {
  if (node === null || typeof node !== "object") return [];
  if (node.id === id) return [node.config];
  return Object.values(node).flatMap((value) => configurations(value, id));
}
function diagnostic(cause) {
  return {
    name: cause.name,
    code: cause.code ?? null,
    ...(cause.cause === undefined ? {} : { cause: diagnostic(cause.cause) }),
  };
}
function progress(event) {
  const line = JSON.stringify(event);
  writeFileSync(join(outputDirectory, "events.jsonl"), `${line}\n`, {
    flag: "a",
    mode: 0o600,
  });
  console.log(line);
}
function runDirectory(dataRoot, id) {
  const runs = join(dataRoot, "runs");
  const manifest = readdirSync(runs, {
    recursive: true,
    encoding: "utf8",
  }).find((path) => path.endsWith(`-${id}/manifest.json`));
  assert.ok(manifest, "The selected source run must exist");
  return dirname(join(runs, manifest));
}
function runFiles(dataRoot, id) {
  const root = runDirectory(dataRoot, id);
  return new Map(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => statSync(join(root, path)).isFile())
      .sort()
      .map((path) => [path, readFileSync(join(root, path))]),
  );
}

// A new directory retains the actual run and source captures even when acceptance fails.
mkdirSync(outputDirectory, { mode: 0o700 });
process.once("SIGUSR2", cancel);
try {
  const manifest = JSON.parse(
    readFileSync(join(project, "package.json"), "utf8"),
  );
  assert.ok(
    satisfies(
      require("@deepseek-ai/dsh/package.json").version,
      manifest.engines.dsh,
      { includePrerelease: true },
    ),
    "The DSH host must satisfy the declared support range.",
  );
  assert.ok(
    satisfies(
      require("@deepseek-ai/cordis/package.json").version,
      manifest.peerDependencies["@deepseek-ai/cordis"],
      { includePrerelease: true },
    ),
    "Cordis must satisfy the declared peer range.",
  );
  const patch = parse(readFileSync(profilePath, "utf8"), {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
  });
  const modelConfigs = configurations(patch, "llm-pi-ai");
  assert.equal(
    modelConfigs.length,
    1,
    "Expected one operator model configuration",
  );
  const provider = modelConfigs[0].providers.magpie;
  assert.ok(
    provider.models.some((entry) => entry.id === model),
    "Selected model must be configured by the operator",
  );
  const webConfigs = configurations(patch, "web");
  assert.equal(webConfigs.length, 1);
  assert.equal(webConfigs[0].searchProvider, "deepseek-search-api");

  record.stage = "archive";
  directory = mkdtempSync(join(tmpdir(), "dsh-stock-quick-profile-"));
  const profileDirectory = join(directory, "profile");
  const packageDirectory = join(
    profileDirectory,
    "node_modules/@megapandas/dsh-stock-research",
  );
  mkdirSync(packageDirectory, { recursive: true });
  const packed = await execute(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    { cwd: project },
  );
  const archive = JSON.parse(packed.stdout)[manifest.name];
  record.archive = join(outputDirectory, archive.filename);
  cpSync(join(directory, archive.filename), record.archive);
  await execute("tar", [
    "-xzf",
    join(directory, archive.filename),
    "--strip-components=1",
    "-C",
    packageDirectory,
  ]);
  writeFileSync(
    join(profileDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { [manifest.name]: manifest.version },
      dsh: { profile: { bundles: [manifest.name] } },
    }),
  );
  const services = [
    "llm",
    "session",
    "session-projection",
    "session-query-sqlite",
    "system-prompt",
    "tools",
    "agent",
    "fs-local",
    "working-directory",
    "agent-loop",
    "jobs-local",
    "subagent",
    "subagent-spawn-in-process",
    "commands",
    "agent-preset-registry",
    "web",
    "tool-web",
    ...(followupMode ? ["session-persistence-jsonl", "user-approval"] : []),
  ].map((service) => ({
    id: `host-${service}`,
    name: `@deepseek-ai/dsh-${service}`,
    ...(service === "agent-loop" ? { config: { agents: [] } } : {}),
    ...(service === "subagent-spawn-in-process"
      ? { config: { providerName: "spawn" } }
      : {}),
    ...(service === "agent-preset-registry"
      ? { config: { default: "quick-acceptance-host" } }
      : {}),
    ...(service === "web"
      ? { config: { searchProvider: "deepseek-search-api" } }
      : {}),
    ...(service === "tool-web"
      ? { config: { search: true, fetch: false, searchMaxResults: 3 } }
      : {}),
    ...(service === "session-query-sqlite"
      ? {
          config: {
            path: join(outputDirectory, "session-query.sqlite"),
            openAt: "never",
          },
        }
      : {}),
    ...(service === "session-persistence-jsonl"
      ? {
          config: {
            root: join(outputDirectory, "sessions"),
            compression: "none",
          },
        }
      : {}),
    ...(service === "user-approval"
      ? { config: { policy: policyMode ? "ask" : "never" } }
      : {}),
  }));
  process.env.DSH_HOME = join(directory, "home");
  const dataRoot =
    !followupMode && probeTaskId === undefined && !reviewMode
      ? (existingDataRoot ?? join(outputDirectory, "data"))
      : join(outputDirectory, "data");
  if (!followupMode && (probeTaskId !== undefined || reviewMode))
    cpSync(existingDataRoot, dataRoot, { recursive: true });
  record.dataRoot = dataRoot;
  const { applyEntryPatches, entryListSchema } = await load(
    "@deepseek-ai/cordis-plugin-include",
  );
  const includeRequire = createRequire(
    require.resolve("@deepseek-ai/cordis-plugin-include"),
  );
  const yaml = includeRequire("js-yaml");
  const bundleEntries = applyEntryPatches(
    [],
    yaml.load(
      readFileSync(join(packageDirectory, manifest.dsh.bundle.patch), "utf8"),
      { schema: entryListSchema },
    ),
    (message) => {
      throw new Error(message);
    },
  );
  const bundleConfig = bundleEntries.find(
    (entry) => entry.id === "stock-research",
  ).config;
  const route = { provider: "magpie", model };
  writeFileSync(
    join(profileDirectory, "cordis.patch.yml"),
    JSON.stringify([
      { insert: services },
      {
        id: "stock-research",
        config: {
          ...bundleConfig,
          model: route,
          runtime: { ...bundleConfig.runtime, dataRoot },
        },
      },
    ]),
  );
  const { runProfile } = await load("@deepseek-ai/dsh/profile-boot");
  const { loadProfileDirectory } = await load("@deepseek-ai/dsh-app-boot");
  const { createLaunchEnvironmentSnapshot } = await load(
    "@deepseek-ai/dsh-launch-environment",
  );
  const profile = loadProfileDirectory(
    "quick-acceptance",
    profileDirectory,
    installAnchor,
  );
  assert.deepEqual(profile.skippedBundles, []);
  record.stage = "boot";
  ({ ctx, shutdown } = await runProfile({
    profile: "quick-acceptance",
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [],
    environment: createLaunchEnvironmentSnapshot([
      { source: "process", values: process.env },
      {
        source: "user-env",
        path: envPath,
        values: parseEnv(readFileSync(envPath, "utf8")),
      },
    ]),
  }));
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), { presets: [] });
  await ctx.agentPresets.register({
    id: "quick-acceptance-host",
    plugins: [],
  });
  const presetRoster = await ctx.agentPresets.remoteExportList();
  record.host = {};
  const pluginURL = pathToFileURL(
    join(packageDirectory, "dist/index.mjs"),
  ).href;
  for (const name of [
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/dsh-web",
    "@deepseek-ai/schemastery",
  ]) {
    const selected = ctx.pluginPackages.packageOf(name, pluginURL);
    assert.equal(
      selected.dir,
      dirname(require.resolve(`${name}/package.json`)),
      "Official SDK must use one installation",
    );
    assert.ok(
      satisfies(selected.version, manifest.peerDependencies[name], {
        includePrerelease: true,
      }),
      `${name} must satisfy the declared peer range.`,
    );
    record.host[name] = selected.version;
  }
  if (followupMode) {
    for (const name of [
      "@deepseek-ai/dsh-session-persistence-jsonl",
      "@deepseek-ai/dsh-user-approval",
    ]) {
      const selected = ctx.pluginPackages.packageOf(name, pluginURL);
      assert.equal(
        selected.dir,
        dirname(require.resolve(`${name}/package.json`)),
      );
      assert.equal(
        selected.version,
        require("@deepseek-ai/dsh/package.json").version,
        "Follow-up services must use the selected DSH installation version",
      );
      record.host[name] = selected.version;
    }
  }
  record.stage = "host-ready";
  assert.ok(
    ctx.get("stockResearch"),
    "The official profile must initialize stockResearch before model calls.",
  );
  if (followupMode)
    assert.ok(
      ctx.tools.get("web_search"),
      "The public follow-up probe requires the host's native web_search tool.",
    );
  const { LocalCredentialProvider } = await load(
    "@deepseek-ai/dsh-credentials-local",
  );
  await ctx.plugin(LocalCredentialProvider, {
    path: join(dirname(envPath), ".credentials.yaml"),
    watch: false,
  });
  const credential = await ctx.credentials.describe("DEEPSEEK_API_KEY");
  assert.equal(credential.configured, true);
  const piAi = await load("@deepseek-ai/dsh-llm-pi-ai");
  const deepseek = await load("@deepseek-ai/dsh-web-deepseek-api");
  await ctx.plugin(piAi, { providers: { magpie: provider } });
  await ctx.plugin(deepseek, {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    count: 3,
    sendOriginalQuestion: false,
  });
  const stock = await import(
    pathToFileURL(join(packageDirectory, "dist/core.mjs")).href
  );
  record.runtimePrompts = { digest: stock.DIGEST_HANDOFF_VERSION };
  const researchDate = stock.parseLocalDate(date);
  if (followupMode) {
    record.stage = "public-probe-input";
    assert.equal(
      researchDate,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
      }).format(new Date()),
      "The public-only follow-up probe requires today's date; historical search requires saved snapshots.",
    );
  }
  record.policy = ctx.stockResearch.policy;

  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const kind =
      url.hostname === "web.ifzq.gtimg.cn"
        ? "market"
        : url.hostname === "quotes.sina.cn"
          ? "fundamentals"
          : url.hostname === "fred.stlouisfed.org"
            ? "macro"
            : url.href === `${deepseek.DEEPSEEK_WEB_API_BASE_URL}/search`
              ? "search"
              : "model";
    assert.ok(
      !policyMode || kind !== "model",
      "The fixture-driven policy probe must not call a real model endpoint",
    );
    fetches[kind]++;
    progress({ event: "request", kind, count: fetches[kind] });
    return nativeFetch(input, init);
  };
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    // Attempt IDs restart when the same persisted session gets a new Agent.
    if (!agentInstances.has(agent))
      agentInstances.set(agent, ++nextAgentInstance);
    const streamKey = `${agentInstances.get(agent)}:${frame.attemptId}`;
    if (frame.type === "start") {
      const route = agent.session.requestHeader().config;
      calls.set(streamKey, {
        attemptId: frame.attemptId,
        agentInstance: agentInstances.get(agent),
        provider: route.provider,
        model: route.model,
        sessionId: agent.id,
        turn: frame.turn,
        step: frame.step,
        usage: null,
        finish: null,
      });
      streamedArguments.set(streamKey, new Map());
      progress({
        event: "model",
        call: calls.size,
        provider: route.provider,
        model: route.model,
      });
    } else if (frame.type === "chunk") {
      const call = calls.get(streamKey);
      const chunk = frame.chunk;
      const blocks = streamedArguments.get(streamKey);
      if (chunk.type === "block-start" && chunk.blockType === "tool-call")
        blocks.set(chunk.index, []);
      if (chunk.type === "tool-call-delta")
        blocks.get(chunk.index).push(chunk.argumentsDelta);
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
        if (artifactTools.has(chunk.block.name)) {
          writeFileSync(
            join(outputDirectory, "tool-arguments.jsonl"),
            `${JSON.stringify({
              sessionId: agent.id,
              attemptId: frame.attemptId,
              callId: chunk.block.id,
              name: chunk.block.name,
              streamedArguments: blocks.get(chunk.index).join(""),
              finalArguments: chunk.block.arguments,
            })}\n`,
            { flag: "a", mode: 0o600 },
          );
        }
        blocks.delete(chunk.index);
      }
      if (frame.chunk.type === "usage") {
        const usage = frame.chunk.usage;
        call.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
        };
      }
      if (frame.chunk.type === "finish") call.finish = frame.chunk.reason.kind;
    } else {
      streamedArguments.delete(streamKey);
    }
  });
  ctx.on("agent/error", ({ agent, error }) => {
    if (agent === caller?.agent) mainFailure ??= error;
  });
  ctx.on("session/event", (session, event) => {
    if (session === caller?.agent.session) {
      if (event.type === "assistant/message") {
        const text = event.data.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text.trim().length > 0) {
          lastReply = text;
          lastReplySeq = event.seq;
        }
      }
      if (
        event.type === "job/registered" &&
        event.data.kind === "stock-research"
      ) {
        (record.jobIds ??= []).push(event.data.jobId);
        progress({
          event: "operation",
          jobId: event.data.jobId,
          label: event.data.label,
        });
      }
    }
    if (event.type === "tool/call")
      tools.set(event.data.callId, {
        name: event.data.name,
        outcome: null,
        code: null,
        arguments: event.data.arguments,
      });
    if (event.type !== "tool/result") return;
    const tool = tools.get(event.data.message.source.callId);
    tool.outcome = event.data.message.isError ? "failed" : "succeeded";
    tool.code = event.data.error?.code ?? null;
    if (event.data.message.isError) {
      tool.errorText = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      writeFileSync(
        join(outputDirectory, "tool-errors.jsonl"),
        `${JSON.stringify(tool)}\n`,
        { flag: "a", mode: 0o600 },
      );
      if (
        probeTaskId !== undefined &&
        artifactTools.has(tool.name) &&
        tool.arguments === "{}"
      )
        controller.abort(
          new Error("Captured the first empty artifact argument failure."),
        );
    }
    if (!event.data.message.isError && !artifactTools.has(tool.name))
      delete tool.arguments;
    if (!event.data.message.isError && tool.name === "stock_start_research") {
      const text = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      runId = JSON.parse(text).runId;
    }
    if (
      session === caller?.agent.session &&
      !event.data.message.isError &&
      tool.name === "stock_decide"
    )
      finalizedSeq = event.seq;
    progress({
      event: "tool",
      name: tool.name,
      outcome: tool.outcome,
      code: tool.code,
    });
  });
  caller = await ctx.agents.create({
    sessionId: "real-quick-caller",
    agentOptions: { provider: "magpie", model },
    meta: { cwd: outputDirectory },
  });
  record.stage = "command";
  const signal = globalThis.AbortSignal.any([
    controller.signal,
    globalThis.AbortSignal.timeout(
      reviewMode
        ? 5 * 60_000
        : probeTaskId === undefined
          ? 30 * 60_000
          : followupMode
            ? 6 * 60_000
            : 120_000,
    ),
  ]);
  if (reviewMode) {
    const runtime = ctx.stockResearch;
    const before = runFiles(dataRoot, runId);
    const definition = runtime.runs.readDefinition(runId);
    assert.equal(definition.scope.security.id, "CN:002594.SZ");
    record.sourceRunId = runId;
    const question =
      reviewQuestion ??
      "对照原研究判断与后续观察，说明哪些驱动仍成立、哪些条件已变化，提炼后续行动。";
    const remember = runtime.memory.remember;
    runtime.memory.remember = async (...args) => {
      const ref = await remember.apply(runtime.memory, args);
      record.memoryRef = ref;
      return ref;
    };
    let execution;
    try {
      execution = await ctx.commands.execute(
        caller.agent,
        `/stock-review ${runId} ${date} ${question}`,
        [],
        signal,
      );
    } finally {
      runtime.memory.remember = remember;
    }
    record.command = execution.result;
    record.stage = "review-acceptance";
    assert.equal(
      execution.result.kind,
      "success",
      "Review must save its canonical memory",
    );
    assert.ok(record.memoryRef, "A submitted MemoryRef is required");
    record.memory = runtime.memory.read(record.memoryRef);
    assert.equal(record.memory.runId, runId);
    assert.equal(record.memory.securityId, definition.scope.security.id);
    assert.ok(execution.result.text.includes(record.memory.note));
    assert.ok(execution.result.text.includes(record.memory.outcome));
    assert.deepEqual(
      runFiles(dataRoot, runId),
      before,
      "Review must leave the source run unchanged",
    );
    record.sourceFilesComparedUnchanged = before.size;
    writeFileSync(
      join(outputDirectory, "review.md"),
      `${record.memory.outcome}\n\n${record.memory.note}\n`,
    );
    assert.ok(calls.size > 0);
    assert.ok(
      [...calls.values()].every(
        (call) => call.provider === "magpie" && call.model === model,
      ),
      "No implicit model fallback",
    );
    record.outcome = "review-passed";
  } else if (probeTaskId !== undefined) {
    const runtime = ctx.stockResearch;
    const publicSearchLimit = 1;
    const probeQueries = {
      free: "比亚迪 王朝 海洋 产品 竞争 2026",
      firstRejected: "比亚迪 2026年11月 销量 竞争",
      paused: "比亚迪 海外市场 关税 2026年11月",
      resumed: "比亚迪 2026年11月 新品 价格 竞争格局",
    };
    record.taskId = probeTaskId;
    if (followupMode) {
      const { createQuickInput } = await import(
        pathToFileURL(join(packageDirectory, "dist/application.mjs")).href
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
        date: researchDate,
        cutoff: new Date().toISOString(),
      };
      const input = createQuickInput(
        scope,
        runtime.policy,
        [],
        [],
        publicSearchLimit,
      );
      input.definition.tasks = input.definition.tasks.filter(
        ({ id }) => id === probeTaskId,
      );
      input.instructions = input.instructions.filter(
        ({ taskId }) => taskId === probeTaskId,
      );
      input.instructions[0].instruction = [
        policyMode
          ? "本次仅验证公开信息角色及原会话修订；只执行下面指定的两次公开查询，不补充或重复查询。"
          : "本次仅验证公开信息角色报告及原会话修订；只执行下面指定的一次免费公开查询，不补充或重复查询。",
        `先调用 stock_search_public，query 必须为：${probeQueries.free}。这是唯一一次免费查询，等待其成功返回后再继续。`,
        ...(policyMode
          ? [
              `再调用 stock_search_public，query 必须为：${probeQueries.firstRejected}。该次申请会被验收操作者拒绝。`,
              "收到拒绝后不要重试，基于已有公开结果提交简洁完整中文报告；未知项如实写入缺口，不臆造数字。检查草稿，确认 stageHandoff 后调用 stock_submit 提交。",
            ]
          : [
              "免费查询完成后不再申请搜索。基于已有公开结果提交简洁完整中文报告；未知项如实写入缺口，不臆造数字。检查草稿，确认 stageHandoff 后调用 stock_submit 提交。",
            ]),
      ].join("\n");
      runId = runtime.runs.open(
        "real-quick-role-probe",
        input,
        randomUUID(),
      ).runId;
      record.runId = runId;
    } else {
      const definition = runtime.runs.readDefinition(resumeRunId);
      const task = definition.tasks.find((item) => item.id === probeTaskId);
      assert.equal(definition.scope.security.id, "CN:002594.SZ");
      assert.equal(definition.scope.date, date);
      assert.equal(task.executor.kind, "role");
      record.sourceRunId = resumeRunId;
    }
    if (policyMode) {
      const llm = await load("@deepseek-ai/dsh-llm");
      const { createFollowupPolicyAdapter } =
        await import("./fixtures/followup-policy.mjs");
      ctx.llm.registerAdapter(
        [fixtureRoute.provider],
        createFollowupPolicyAdapter(llm, probeQueries, backgroundMode),
      );
    }
    let parent;
    const runProbe = async (activeSignal) => {
      if (!followupMode) {
        const view = runtime.runs.view({ runId });
        record.resolvedReasons = view.blockReasons;
        runtime.runs.resume(
          { runId, identity: parent.agent.id },
          {
            resolvedReasonIds: view.blockReasons.map((reason) => reason.id),
            instructions: [],
          },
          randomUUID(),
        );
      }
      record.probe = await runtime.dispatch.dispatch(
        parent.agent,
        runId,
        probeTaskId,
        randomUUID(),
        activeSignal,
        backgroundMode,
      );
      assert.equal(
        record.probe.status,
        "succeeded",
        "The isolated role must commit its actual artifact",
      );
      if (followupMode) {
        const readArtifacts = (receipt) =>
          receipt.refs.map((ref) => runtime.runs.readArtifact(ref));
        const searchTimes = (artifacts) =>
          artifacts.map(
            ({ content }) => content.payload.publicSearchAsOf ?? null,
          );
        let previous = record.probe;
        const originals = globalThis.structuredClone(readArtifacts(previous));
        if (!policyMode) {
          assert.equal(fetches.search, 1);
          assert.ok(
            searchTimes(originals).every((time) => typeof time === "string"),
            "The model smoke must save the result of its free public search",
          );
        }
        const preserved = [...originals];
        record.followupRounds = [
          { ...previous, publicSearchAsOf: searchTimes(originals) },
        ];
        for (const round of [2, 3]) {
          record.stage = `role-followup-${round}`;
          assert.equal(
            ctx.agents.get(previous.sessionId),
            undefined,
            "The prior child Agent must be released before cold restoration",
          );
          assert.equal(
            ctx.sessions.get(previous.sessionId),
            undefined,
            "The prior child Session must be released before cold restoration",
          );
          const marker = `followup-round-${round}`;
          const resumeSearch = round === 3;
          const searchesBefore = fetches.search;
          const message = [
            ...(policyMode
              ? resumeSearch
                ? [
                    `搜索已显式恢复：调用 stock_search_public，query 必须为：${probeQueries.resumed}。本次申请将获得单次批准；只执行这次指定查询，不新增或重复查询。用结果核对已有判断，保留使用量与原额度。`,
                  ]
                : [
                    `本轮不恢复搜索，但需要调用 stock_search_public 申请另一条指定查询，query 必须为：${probeQueries.paused}。该申请将被拒绝并触发暂停；被拒后不重试，基于已有材料完成摘要修订。`,
                  ]
              : ["本轮只修订已有报告和交接，不申请或新增任何搜索。"]),
            (policyMode ? "等待上述查询成功或被拒后，" : "") +
              "使用已有草稿，仅更新 summary 和 content.handoff，其他正文逐项保持不变。在 summary 以及 content.handoff.limitations 中均包含验收标记：" +
              marker +
              "。在交接中如实记录本次新材料或缺口；其他正文留待后续任务评估，不在本轮重写。",
            "检查草稿，在最后一次修改后重新确认 stageHandoff，然后调用 stock_submit 提交。",
          ].join("\n");
          const next = await runtime.dispatch.followup(
            parent.agent,
            runId,
            probeTaskId,
            message,
            randomUUID(),
            resumeSearch,
            activeSignal,
            backgroundMode,
          );
          record.followupRounds.push({
            ...next,
            searchRequests: fetches.search - searchesBefore,
          });
          assert.equal(next.status, "succeeded");
          assert.equal(next.attempt, previous.attempt + 1);
          assert.equal(next.sessionId, record.probe.sessionId);
          assert.equal(next.refs.length, previous.refs.length);
          const artifacts = readArtifacts(next);
          for (const [index, ref] of next.refs.entries()) {
            assert.equal(ref.artifactId, previous.refs[index].artifactId);
            assert.equal(ref.revision, previous.refs[index].revision + 1);
            const report = artifacts[index].content.payload.report;
            assert.ok(report.summary.includes(marker));
            const { handoff, ...body } = report.content;
            const originalBody = {
              ...originals[index].content.payload.report.content,
            };
            delete originalBody.handoff;
            assert.deepEqual(
              body,
              originalBody,
              "Summary and handoff revisions must preserve every other report section",
            );
            assert.ok(
              handoff.limitations.some((text) => text.includes(marker)),
              "The explicitly requested handoff revision must be saved",
            );
          }
          for (const artifact of preserved)
            assert.deepEqual(
              runtime.runs.readArtifact(artifact.ref),
              artifact,
              "Follow-up must preserve every prior artifact version",
            );
          if (policyMode && resumeSearch) {
            assert.ok(
              fetches.search > searchesBefore,
              "The resumed public role must execute its requested real search",
            );
            assert.ok(
              searchTimes(artifacts).some(
                (time) =>
                  time !== null && !searchTimes(originals).includes(time),
              ),
              "The resumed search must advance the saved public search time",
            );
          } else {
            assert.equal(
              fetches.search,
              searchesBefore,
              "This revision must not add an HTTP search",
            );
            assert.deepEqual(
              searchTimes(artifacts),
              record.followupRounds.at(-2).publicSearchAsOf,
              "A revision without a completed search must retain its saved public search time",
            );
          }
          record.followupRounds.at(-1).publicSearchAsOf =
            searchTimes(artifacts);
          preserved.push(...globalThis.structuredClone(artifacts));
          previous = next;
        }
      }
    };
    let probeWork;
    let probeFailure;
    const probeTool = {
      name: "stock_acceptance_followup",
      description:
        "Run the isolated public-role acceptance once, including the original report and two revisions. Return passed or failed and end this turn.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: { type: "string", enum: ["passed", "failed"] },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(_value, exec) {
        probeWork ??= runProbe(
          globalThis.AbortSignal.any([signal, exec.signal]),
        ).then(
          () => "passed",
          (cause) => {
            probeFailure = cause;
            return "failed";
          },
        );
        const result = await probeWork;
        exec.concludeTurn();
        return result;
      },
    };
    parent = await runtime.createAgent(
      {
        sessionId: "real-quick-role-probe",
        agentOptions: policyMode ? fixtureRoute : { provider: "magpie", model },
        meta: { cwd: outputDirectory },
        signal,
      },
      { kind: "coordinator", runIds: [runId] },
      followupMode && !backgroundMode ? [probeTool] : [],
    );
    try {
      if (followupMode) {
        const plannedApprovals = [
          { query: probeQueries.firstRejected, outcome: "rejected" },
          { query: probeQueries.paused, outcome: "rejected" },
          { query: probeQueries.resumed, outcome: "allowed-once" },
        ].map((item) => ({
          ...item,
          reason: `已使用 ${publicSearchLimit} 次公开检索；申请本次检索：${item.query}`,
        }));
        record.approval = policyMode
          ? {
              mode: "test-controlled",
              policy: "ask",
              userUI: false,
              answers: [],
              audit: [],
              ...(backgroundMode ? { turns: [] } : {}),
            }
          : {
              mode: "not-covered-by-model-smoke",
              policy: "never",
              userUI: false,
            };
        const releases = [];
        let parentFailure;
        if (policyMode) {
          record.searchAttempts = [];
          const searchQueries = new Map();
          let currentParentTurn;
          releases.push(
            ctx.on("approval/request", (req, next) => {
              if (
                req.agent !== parent.agent ||
                req.toolName !== "stock_search_public"
              )
                return next();
              const expected = plannedApprovals[record.approval.answers.length];
              if (expected === undefined || req.reason !== expected.reason)
                return next();
              record.approval.answers.push(expected);
              return Promise.resolve(expected.outcome);
            }),
          );
          releases.push(
            ctx.on("session/event", (session, event) => {
              if (backgroundMode && session === parent.agent.session) {
                if (event.type === "turn/start") {
                  currentParentTurn = {
                    turn: event.data.turn,
                    startSeq: event.seq,
                    inputs: [],
                  };
                  record.approval.turns.push(currentParentTurn);
                } else if (event.type === "user/message") {
                  currentParentTurn.inputs.push({
                    id: event.data.id,
                    seq: event.seq,
                    source: event.data.source,
                  });
                } else if (event.type === "turn/end") {
                  currentParentTurn.endSeq = event.seq;
                  currentParentTurn.endReason = event.data.reason;
                  currentParentTurn = undefined;
                }
              }
              if (
                session === parent.agent.session &&
                (event.type === "approval/asked" ||
                  event.type === "approval/decided")
              )
                record.approval.audit.push({
                  type: event.type,
                  seq: event.seq,
                  ...event.data,
                  ...(backgroundMode ? { turn: currentParentTurn?.turn } : {}),
                });
              if (
                event.type === "tool/call" &&
                event.data.name === "stock_search_public"
              )
                searchQueries.set(
                  event.data.callId,
                  JSON.parse(event.data.arguments).query,
                );
              if (event.type !== "tool/result") return;
              const callId = event.data.message.source.callId;
              if (!searchQueries.has(callId)) return;
              const text = event.data.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
              record.searchAttempts.push({
                query: searchQueries.get(callId),
                outcome: event.data.message.isError ? "failed" : "succeeded",
                ...(event.data.message.isError
                  ? { code: event.data.error?.code, errorText: text }
                  : { budget: JSON.parse(text).budget }),
              });
            }),
          );
        }
        releases.push(
          ctx.on("agent/error", ({ agent, error }) => {
            if (agent === parent.agent) parentFailure ??= error;
          }),
        );
        try {
          if (backgroundMode) {
            record.background = { initialParentStatus: parent.agent.status };
            assert.equal(parent.agent.status, "idle");
            await runProbe(signal);
          } else {
            const { createUserMessage } = await load("@deepseek-ai/dsh-llm");
            parent.agent.followup(
              createUserMessage({
                content: [
                  {
                    type: "text",
                    text: "调用 stock_acceptance_followup 一次，参数为 {}。不要自行研究或调用其他工具；该工具完成后结束本轮。",
                  },
                ],
                source: { kind: "user" },
              }),
            );
          }
          await parent.agent.whenIdle();
          signal.throwIfAborted();
          if (probeFailure !== undefined) throw probeFailure;
          if (parentFailure !== undefined) throw parentFailure;
          if (!backgroundMode) {
            assert.ok(probeWork, "The parent must execute its acceptance tool");
            assert.equal(await probeWork, "passed");
          }
          if (policyMode) {
            assert.deepEqual(record.approval.answers, plannedApprovals);
            const asked = record.approval.audit.filter(
              ({ type }) => type === "approval/asked",
            );
            const decided = record.approval.audit.filter(
              ({ type }) => type === "approval/decided",
            );
            assert.equal(record.approval.audit.length, 6);
            assert.equal(asked.length, 3);
            assert.equal(decided.length, 3);
            assert.equal(new Set(asked.map(({ id }) => id)).size, 3);
            for (const [index, request] of asked.entries()) {
              assert.equal(request.toolName, "stock_search_public");
              assert.equal(request.reason, plannedApprovals[index].reason);
              assert.equal(decided[index].id, request.id);
              assert.equal(
                decided[index].outcome,
                plannedApprovals[index].outcome,
              );
              assert.ok(request.seq < decided[index].seq);
            }
            if (backgroundMode) {
              const parentCalls = [...calls.values()].filter(
                (call) => call.sessionId === parent.agent.id,
              );
              const approvalTurns = new Set(asked.map(({ turn }) => turn));
              assert.equal(approvalTurns.size, 3);
              for (const [index, request] of asked.entries()) {
                const turn = record.approval.turns.find(
                  (entry) => entry.turn === request.turn,
                );
                assert.ok(turn);
                assert.equal(decided[index].turn, turn.turn);
                assert.ok(turn.startSeq < request.seq);
                assert.ok(decided[index].seq < turn.endSeq);
                assert.equal(
                  parentCalls.filter((call) => call.turn === turn.turn).length,
                  0,
                  "Approval-only parent turns must not request a model",
                );
              }
              const settledTurns = record.approval.turns.filter(
                ({ turn }) => !approvalTurns.has(turn),
              );
              for (const turn of settledTurns) {
                const inputs = turn.inputs.filter(
                  ({ source }) => source.form !== "snapshot",
                );
                assert.ok(inputs.length > 0);
                assert.ok(
                  inputs.every(
                    ({ source }) =>
                      source.kind === "subagent-settled" &&
                      source.senderSessionId === record.probe.sessionId,
                  ),
                  "Other parent turns must contain only this child's settled notices",
                );
                assert.equal(
                  parentCalls.filter((call) => call.turn === turn.turn).length,
                  1,
                  "A settled-notice turn receives one fixture response",
                );
                assert.ok(turn.endSeq > turn.startSeq);
              }
              assert.ok(
                parentCalls.every((call) =>
                  settledTurns.some(({ turn }) => turn === call.turn),
                ),
              );
              record.background.approvalTurns = [...approvalTurns];
              record.background.approvalTurnModelRequests = parentCalls.filter(
                ({ turn }) => approvalTurns.has(turn),
              ).length;
              record.background.settledNoticeTurns = settledTurns.map(
                ({ turn }) => turn,
              );
              record.background.settledNoticeModelRequests = parentCalls.length;
              record.background.parentModelRequests = parentCalls.length;
              record.background.finalParentStatus = parent.agent.status;
              assert.equal(parent.agent.status, "idle");
            }
            assert.deepEqual(
              record.searchAttempts.map(({ query, outcome }) => ({
                query,
                outcome,
              })),
              [
                { query: probeQueries.free, outcome: "succeeded" },
                { query: probeQueries.firstRejected, outcome: "failed" },
                { query: probeQueries.paused, outcome: "failed" },
                { query: probeQueries.resumed, outcome: "succeeded" },
              ],
            );
            const rejected = record.searchAttempts.filter(
              ({ outcome }) => outcome === "failed",
            );
            assert.equal(rejected[0].code, "ACCESS_DENIED");
            assert.match(
              rejected[0].errorText,
              /Search approval denied \(1\/2\)/,
            );
            assert.equal(rejected[1].code, "ACCESS_DENIED");
            assert.match(
              rejected[1].errorText,
              /Search is paused after 2 denied approvals/,
            );
            const budgets = record.searchAttempts
              .filter(({ outcome }) => outcome === "succeeded")
              .map(({ budget }) => budget);
            assert.deepEqual(budgets, [
              { limit: publicSearchLimit, used: 1, remaining: 0 },
              { limit: publicSearchLimit, used: 2, remaining: 0 },
            ]);
            assert.equal(fetches.search, 2);
            assert.equal(fetches.model, 0);
            assert.ok(calls.size > 0);
            assert.ok(
              [...calls.values()].every(
                (call) =>
                  call.provider === fixtureRoute.provider &&
                  call.model === fixtureRoute.model,
              ),
              "The policy probe must use only its fixture-driven model adapter",
            );
          } else {
            assert.equal(fetches.search, 1);
            assert.ok(fetches.model > 0);
            assert.ok(calls.size > 0);
            assert.ok(
              [...calls.values()].every(
                (call) => call.provider === "magpie" && call.model === model,
              ),
              "The model smoke must use only the configured real model route",
            );
          }
        } finally {
          for (const release of releases.reverse()) release();
        }
      } else await runProbe(signal);
    } finally {
      await parent.dispose();
    }
    record.stage = "role-acceptance";
    record.outcome = backgroundMode
      ? "role-followup-policy-background-passed"
      : policyMode
        ? "role-followup-policy-passed"
        : followupMode
          ? "role-followup-smoke-passed"
          : "role-passed";
  } else {
    let command = `/stock-quick SZ.002594 ${date}`;
    if (resumeRunId !== undefined) {
      const view = ctx.stockResearch.runs.view({ runId });
      assert.equal(view.scope.security.id, "CN:002594.SZ");
      assert.equal(view.scope.date, date);
      record.resolvedReasons = view.blockReasons;
      command = `/stock-resume ${runId} ${JSON.stringify({
        resolvedReasonIds: view.blockReasons.map((reason) => reason.id),
        instructions: [],
      })}`;
    }
    const stop = () => caller.agent.cancel({ kind: "user" });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const acknowledgement = await ctx.commands.execute(
        caller.agent,
        command,
        [],
        signal,
      );
      record.command = acknowledgement.result;
      assert.equal(
        acknowledgement.result.kind,
        "success",
        "The command must submit the request to the current main Agent",
      );
      record.stage = "main-agent";
      await caller.agent.whenIdle();
      signal.throwIfAborted();
      if (mainFailure !== undefined) throw mainFailure;
    } finally {
      signal.removeEventListener("abort", stop);
    }
    record.stage = "acceptance";
    assert.ok(runId, "The main Agent must open its canonical research run");
    const runtime = ctx.stockResearch;
    const view = runtime.runs.view({ runId });
    assert.equal(view.status, "completed");
    assert.equal(view.tasks.length, 15);
    assert.ok(view.tasks.every((task) => task.status === "succeeded"));
    const manager = runtime.runs.readArtifact(
      view.tasks.find(({ taskId }) => taskId === "manager.decision")
        .outputRefs[0],
    );
    const target = manager.content.payload.report.content.targetPrice;
    assert.ok(target, "Completed research must include a manager target price");
    assert.ok(Number.isFinite(target.value) && target.value >= 0);
    const calculationEntry = runtime.runs
      .inputCatalog(runId)
      .inputs.find(({ ref }) => ref.id === target.calculationId);
    assert.ok(
      calculationEntry,
      "The target price must reference a saved calculation",
    );
    const calculation = runtime.runs.readInput(runId, calculationEntry.ref);
    assert.equal(calculation.request.purpose, "target_price");
    assert.deepEqual(calculation.result.perShareValues, [target.value]);
    assert.equal(calculation.valueDate, manager.content.payload.horizonEndDate);
    record.targetPrice = {
      ...target,
      date: calculation.valueDate,
      currency: calculation.currency,
    };
    if (resumeRunId === undefined)
      assert.equal(
        view.stages?.length,
        4,
        "Fresh quick research must review each role stage once",
      );
    if (view.stages !== undefined) {
      assert.ok(
        view.stages.every((stage) => stage.accepted),
        "Every current research stage must be accepted before completion",
      );
      record.stageReviews = view.stageReviews;
    }
    assert.ok(
      lastReply?.trim(),
      "The main Agent must reply in the user's conversation",
    );
    assert.ok(
      finalizedSeq !== undefined && lastReplySeq > finalizedSeq,
      "The main Agent must deliver its reply after canonical finalization",
    );
    record.reply = lastReply;
    writeFileSync(join(outputDirectory, "reply.md"), `${lastReply}\n`);
    const catalog = runtime.runs.inputCatalog(runId);
    const input = catalog.inputs.find(
      (item) => item.name === "stock-research:collection",
    );
    assert.ok(input, "The run must retain its fixed collection input");
    const collection = runtime.runs.readInput(runId, input.ref);
    assert.equal(collection.schemaVersion, 1);
    assert.deepEqual(collection.scope, view.scope);
    assert.ok(
      collection.packets.some((packet) => packet.id === "market.daily"),
    );
    assert.ok(
      collection.packets.every(
        ({ envelope }) =>
          envelope.cutoff === view.scope.cutoff &&
          Number.isFinite(Date.parse(envelope.retrievedAt)),
      ),
    );
    const times = collection.packets
      .map(({ envelope }) => envelope.retrievedAt)
      .sort();
    record.collection = {
      packetCount: collection.packets.length,
      failures: collection.failures,
      capturedFrom: times[0],
      capturedThrough: times.at(-1),
    };
    assert.ok(calls.size > 0);
    assert.ok(
      [...calls.values()].every(
        (call) => call.provider === "magpie" && call.model === model,
      ),
      "No implicit model fallback",
    );
    const health = runtime.queries
      .health(view.scope)
      .sources.filter((source) => source.capability !== null);
    record.sources = health.map(
      ({ dataset, provider, sourceCalls, cacheHits, lastQuery }) => ({
        dataset,
        provider,
        sourceCalls,
        cacheHits,
        lastQuery,
      }),
    );
    record.outcome = "passed";
  }
  assert.deepEqual(await ctx.agentPresets.remoteExportList(), presetRoster);
} catch (cause) {
  record.outcome = "failed";
  record.error = diagnostic(cause);
  if (cause.code === "ERR_ASSERTION") record.assertion = cause.message;
  process.exitCode = 1;
} finally {
  try {
    try {
      if (ctx?.get("stockResearch") !== undefined && runId !== undefined) {
        const runtime = ctx.stockResearch;
        record.run = runtime.runs.view({ runId });
        record.artifacts = reviewMode
          ? []
          : record.run.tasks.flatMap((task) =>
              task.outputRefs.map((ref) => runtime.runs.readArtifact(ref)),
            );
        record.sources = runtime.queries
          .health(record.run.scope)
          .sources.filter((source) => source.capability !== null)
          .map(({ dataset, provider, sourceCalls, cacheHits, lastQuery }) => ({
            dataset,
            provider,
            sourceCalls,
            cacheHits,
            lastQuery,
          }));
      }
    } finally {
      try {
        await caller?.dispose();
      } finally {
        await shutdown?.shutdown(process.exitCode ?? 0);
      }
    }
  } finally {
    globalThis.fetch = nativeFetch;
    process.removeListener("SIGUSR2", cancel);
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
    Object.assign(record, {
      durationMs: performance.now() - startedAt,
      fetches,
      calls: [...calls.values()],
      tools: [...tools.values()],
    });
    writeFileSync(
      join(outputDirectory, "acceptance.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}
progress({
  outcome: record.outcome,
  stage: record.stage,
  code: record.error?.code,
  assertion: record.assertion,
  runId,
  fetches,
  modelCalls: calls.size,
  durationMs: record.durationMs,
});

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
const probeTaskId = reviewMode ? undefined : selection;
if (
  [installAnchor, profilePath, envPath, model, date, outputDirectory].some(
    (value) => value === undefined,
  ) ||
  (existingDataRoot === undefined) !== (resumeRunId === undefined) ||
  (selection !== undefined && resumeRunId === undefined) ||
  (selection?.startsWith("--") && !reviewMode)
) {
  console.error(
    "Usage: npm run check:quick -- <dsh-package.json> <profile-patch.yml> <env-file> <model-id> <research-date> <new-output-directory> [<existing-data-root> <source-run-id> [<probe-task-id>|--review [<review-question>]]]",
  );
  process.exit(2);
}
const execute = promisify(execFile);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(installAnchor);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const startedAt = performance.now();
const calls = new Map();
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
  case: `live BYD ${reviewMode ? "review" : "quick"} through official profile boot`,
  target: "SZ.002594",
  date,
  provider: "magpie",
  model,
  mode: reviewMode
    ? "review"
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
  }));
  process.env.DSH_HOME = join(directory, "home");
  const dataRoot =
    probeTaskId === undefined && !reviewMode
      ? (existingDataRoot ?? join(outputDirectory, "data"))
      : join(outputDirectory, "data");
  if (probeTaskId !== undefined || reviewMode)
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
          runtime: { ...bundleConfig.runtime, dataRoot, digestModel: route },
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
  const { DIGEST_PROMPT_VERSION } = await import(
    pathToFileURL(join(packageDirectory, "dist/tools.mjs")).href
  );
  record.runtimePrompts = { digest: DIGEST_PROMPT_VERSION };
  stock.parseLocalDate(date);
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
    fetches[kind]++;
    progress({ event: "request", kind, count: fetches[kind] });
    return nativeFetch(input, init);
  };
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (frame.type === "start") {
      const route = agent.session.requestHeader().config;
      calls.set(frame.attemptId, {
        attemptId: frame.attemptId,
        provider: route.provider,
        model: route.model,
        sessionId: agent.id,
        usage: null,
        finish: null,
      });
      streamedArguments.set(frame.attemptId, new Map());
      progress({
        event: "model",
        call: calls.size,
        provider: route.provider,
        model: route.model,
      });
    } else if (frame.type === "chunk") {
      const call = calls.get(frame.attemptId);
      const chunk = frame.chunk;
      const blocks = streamedArguments.get(frame.attemptId);
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
      streamedArguments.delete(frame.attemptId);
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
    const definition = runtime.runs.readDefinition(resumeRunId);
    const task = definition.tasks.find((item) => item.id === probeTaskId);
    assert.equal(definition.scope.security.id, "CN:002594.SZ");
    assert.equal(definition.scope.date, date);
    assert.equal(task.executor.kind, "role");
    record.sourceRunId = resumeRunId;
    record.taskId = probeTaskId;
    const parent = await runtime.createAgent(
      {
        sessionId: "real-quick-role-probe",
        agentOptions: { provider: "magpie", model },
        meta: { cwd: outputDirectory },
      },
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    try {
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
      record.probe = await runtime.dispatch.dispatch(
        parent.agent,
        runId,
        probeTaskId,
        randomUUID(),
        signal,
      );
    } finally {
      await parent.dispose();
    }
    record.stage = "role-acceptance";
    assert.equal(
      record.probe.status,
      "succeeded",
      "The isolated role must commit its actual artifact",
    );
    record.outcome = "role-passed";
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
    assert.equal(view.tasks.length, 12);
    assert.ok(view.tasks.every((task) => task.status === "succeeded"));
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

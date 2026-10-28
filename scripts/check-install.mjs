import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import console from "node:console";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { satisfies, valid } from "semver";

const execute = promisify(execFile);
const success = "Independent archive installation: accepted.";
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
];

async function probe(directory, targetVersion) {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("Installation must not make network requests.");
  };
  const require = createRequire(join(directory, "package.json"));
  const load = (name) => import(name);
  const manifest = require("@megapandas/dsh-stock-research/package.json");
  assert.equal(require("@deepseek-ai/dsh/package.json").version, targetVersion);
  assert.ok(
    satisfies(targetVersion, manifest.engines.dsh, { includePrerelease: true }),
    `DSH ${targetVersion} must satisfy ${manifest.engines.dsh}`,
  );
  const installed = realpathSync(
    dirname(require.resolve("@megapandas/dsh-stock-research/package.json")),
  );
  for (const subpath of Object.keys(manifest.exports)) {
    if (subpath === "./package.json") continue;
    const specifier = `@megapandas/dsh-stock-research${subpath === "." ? "" : subpath.slice(1)}`;
    assert.ok(
      realpathSync(fileURLToPath(import.meta.resolve(specifier))).startsWith(
        `${installed}${sep}`,
      ),
    );
  }

  const { runProfile, INSTALL_ANCHOR } = await load(
    "@deepseek-ai/dsh/profile-boot",
  );
  const { loadProfileDirectory } = await load("@deepseek-ai/dsh-app-boot");
  const { createLaunchEnvironmentSnapshot } = await load(
    "@deepseek-ai/dsh-launch-environment",
  );
  const profile = loadProfileDirectory(
    "archive-acceptance",
    directory,
    INSTALL_ANCHOR,
  );
  assert.deepEqual(profile.skippedBundles, []);
  assert.deepEqual(
    profile.layers.map((layer) => realpathSync(layer.packageDir)),
    [installed],
  );
  const { ctx, shutdown } = await runProfile({
    profile: "archive-acceptance",
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    environment: createLaunchEnvironmentSnapshot([
      { source: "process", values: { ...process.env } },
    ]),
    patchFiles: [],
    args: [],
  });
  try {
    assert.ok(ctx.get("stockResearch"));
    assert.deepEqual(ctx.llm.listProviders(), []);
    const pluginURL = pathToFileURL(join(installed, "dist/index.mjs")).href;
    for (const name of [
      "@deepseek-ai/dsh",
      ...Object.keys(manifest.peerDependencies),
      "@deepseek-ai/dsh-agent-loop",
      "@deepseek-ai/dsh-session-projection",
      "@deepseek-ai/dsh-subagent-spawn-in-process",
    ]) {
      const selected = ctx.pluginPackages.packageOf(name, pluginURL);
      assert.ok(
        realpathSync(selected.dir).startsWith(`${directory}${sep}`),
        `${name} must be installed independently`,
      );
      const range = manifest.peerDependencies[name] ?? manifest.engines.dsh;
      if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
        assert.equal(
          selected.version,
          targetVersion,
          `${name} must use the installation target`,
        );
      assert.ok(
        satisfies(selected.version, range, { includePrerelease: true }),
        `${name} ${selected.version} must satisfy ${range}`,
      );
      if (selected.manifest.dependencies?.zod) {
        const dependency = createRequire(selected.manifestPath);
        assert.equal(dependency("zod/package.json").version, "4.6.6");
      }
    }
    // Import only after the official runtime package resolution is active.
    for (const subpath of Object.keys(manifest.exports)) {
      if (subpath !== "./package.json" && subpath !== "./client")
        await load(
          `@megapandas/dsh-stock-research${subpath === "." ? "" : subpath.slice(1)}`,
        );
    }
    assert.deepEqual((await ctx.agentPresets.remoteExportList()).presets, []);
    await ctx.agentPresets.register({ id: "installation-user", plugins: [] });
    const userPresets = await ctx.agentPresets.remoteExportList();
    const graph = ctx.clientModules.graph();
    const client = graph.entries.find(({ id }) => id === manifest.name);
    assert.ok(
      client,
      "The installed plugin must appear in the Web boot graph.",
    );
    assert.deepEqual(client.inject, manifest.dsh.client.inject);
    assert.equal(
      realpathSync(ctx.clientModules.clientPath(manifest.name)),
      realpathSync(join(installed, "dist/client.js")),
    );
    const batch = graph.batches.find(({ entries }) =>
      entries.includes(manifest.name),
    );
    assert.ok(batch, "The installed client must belong to a startup batch.");
    const response = await ctx.clientModules.fetchBundle(
      new globalThis.Request(new URL(batch.url, "http://installation/")),
    );
    assert.equal(response.status, 200);
    const registrations = [];
    vm.runInNewContext(await response.text(), {
      window: {
        __ModuleLoader__: { load: (entry) => registrations.push(entry) },
      },
    });
    assert.ok(registrations.some(({ id }) => id === manifest.name));
    const outside = await ctx.agents.create({
      sessionId: "installation-user",
      meta: { cwd: directory },
    });
    ctx.commands.register({
      name: "host-ping",
      description: "Host marker",
      handler: () => ({ kind: "success", text: "pong" }),
    });
    for (const name of commands)
      assert.equal(ctx.commands.find(outside.agent, name).name, name);
    const mainAgentTools = [
      "stock_start_research",
      "stock_review_stage",
      "stock_research_control",
      "stock_followup_task",
      "stock_dispatch_stage",
    ];
    for (const name of mainAgentTools)
      assert.ok(
        ctx.tools.schemas(outside.agent).some((tool) => tool.name === name),
        `The installed application must expose ${name} to the current main Agent`,
      );
    assert.equal(typeof ctx.subagents.sendMessage, "function");
    assert.equal(typeof ctx.subagents.drainChildren, "function");
    const jobEvents = [];
    const unlisten = ctx.on("session/event", (session, event) => {
      if (session === outside.agent.session && event.type.startsWith("job/"))
        jobEvents.push(event);
    });
    const task = Promise.withResolvers();
    const jobId = ctx.jobs.start({
      kind: "stock-research",
      owner: outside.agent.id,
      label: "Installation lifecycle probe",
      run(job) {
        job.updateProgress("采集数据 0/1");
        job.append("Archive task started.\n", { channel: "log" });
        return {
          cancel: () => task.resolve({ status: "killed" }),
          done: task.promise,
        };
      },
    });
    assert.equal(
      ctx.jobs.get(jobId, outside.agent.id).progress,
      "采集数据 0/1",
    );
    assert.equal(
      ctx.jobs.readAt(jobId, 0, outside.agent.id).chunks[0].text,
      "Archive task started.\n",
    );
    assert.equal(ctx.jobs.kill(jobId, outside.agent.id), "requested");
    assert.equal(
      (await ctx.jobs.wait(jobId, 1000, outside.agent.id)).status,
      "killed",
    );
    assert.deepEqual(
      jobEvents.map((event) => event.type),
      ["job/registered", "job/settled"],
    );
    ctx.jobs.remove(jobId, outside.agent.id);
    unlisten();
    assert.equal(ctx.stockResearch.tools.length, 17);
    const health = ctx.stockResearch.queries.health({
      security: {
        id: "CN:002594.SZ",
        market: "CN",
        symbol: "002594.SZ",
        exchange: "SZ",
        currency: "CNY",
        timeZone: "Asia/Shanghai",
      },
      date: "2026-10-26",
      cutoff: "2026-10-26T00:00:00.000Z",
    });
    assert.ok(health.sources.every((source) => source.sourceCalls === 0));
    const descriptor = ctx.settings
      .describe()
      .find((item) => item.ns === "stock-research");
    assert.ok(descriptor);
    assert.equal(descriptor.autoGenerate, false);
    const runtimeBeforeEdit = ctx.stockResearch;
    await ctx.settings.mutate(
      "stock-research",
      [
        { op: "set", path: ["model"], value: { reasoningEffort: null } },
        { op: "set", path: ["publicSearchLimit"], value: 0 },
      ],
      descriptor.revision,
    );
    const edited = ctx.settings
      .describe()
      .find((item) => item.ns === "stock-research");
    assert.deepEqual(edited.value.model, { reasoningEffort: null });
    assert.equal(edited.value.publicSearchLimit, 0);
    assert.equal(ctx.stockResearchSettings.publicSearchLimit, 0);
    assert.equal(ctx.stockResearch, runtimeBeforeEdit);
    const patchBeforeRefusal = readFileSync(
      ctx.configEditor.documentPath,
      "utf8",
    );
    const busy = await ctx.stockResearch.createAgent(
      { sessionId: "settings-busy", meta: { cwd: directory } },
      { kind: "coordinator", runIds: [] },
      [],
    );
    try {
      await assert.rejects(
        () =>
          ctx.settings.mutate(
            "stock-research",
            [
              {
                op: "set",
                path: ["runtime", "http", "maxConcurrency"],
                value: 2,
              },
            ],
            edited.revision,
          ),
        /Research is running/,
      );
      assert.equal(
        readFileSync(ctx.configEditor.documentPath, "utf8"),
        patchBeforeRefusal,
      );
    } finally {
      await busy.dispose();
    }
    await ctx.settings.mutate(
      "stock-research",
      [
        { op: "unset", path: ["model"] },
        { op: "unset", path: ["publicSearchLimit"] },
      ],
      edited.revision,
    );
    assert.equal(
      ctx.settings.describe().find((item) => item.ns === "stock-research").value
        .model,
      undefined,
    );
    assert.equal(ctx.stockResearchSettings.publicSearchLimit, 8);
    const entries = [...ctx.loader.entries()].filter(
      (entry) => entry.options.id === "stock-research",
    );
    assert.equal(entries.length, 1);
    const [entry] = entries;
    const unloading = entry.fiber.dispose();
    await entry.parent.update(
      entry.parent.data.filter((item) => item.id !== "stock-research"),
    );
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
    assert.ok(
      !ctx.clientModules.graph().entries.some(({ id }) => id === manifest.name),
    );
    assert.equal(ctx.agents.get(outside.agent.id), outside.agent);
    assert.equal(
      ctx.commands.find(outside.agent, "host-ping").name,
      "host-ping",
    );
    const { DataRoot } = await load("@megapandas/dsh-stock-research/core");
    const root = new DataRoot(join(process.env.DSH_HOME, "stock-research"));
    root.close();
    assert.equal(fetches, 0);
  } finally {
    await shutdown.shutdown(0);
  }
  assert.equal(fetches, 0);
  console.log(success);
}

async function install(requestedVersion) {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(
    readFileSync(join(project, "package.json"), "utf8"),
  );
  const targetVersion =
    requestedVersion ?? manifest.devDependencies["@deepseek-ai/dsh-agent"];
  assert.equal(
    valid(targetVersion),
    targetVersion,
    "The DSH installation target must be an exact version.",
  );
  assert.ok(
    satisfies(targetVersion, manifest.engines.dsh, { includePrerelease: true }),
    `DSH ${targetVersion} must satisfy ${manifest.engines.dsh}`,
  );
  const directory = mkdtempSync(join(tmpdir(), "dsh-stock-install-"));
  const host = join(directory, "host");
  mkdirSync(host);
  try {
    console.log("Packing the frozen build for an independent host.");
    const packed = await execute(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      {
        cwd: project,
        timeout: 30_000,
      },
    );
    const archive = JSON.parse(packed.stdout)[manifest.name];
    assert.ok(archive.files.some((file) => file.path === "cordis.patch.yml"));
    assert.ok(
      archive.files.every(
        (file) => !/^(?:src|test|scripts|node_modules)\//u.test(file.path),
      ),
    );
    const filename = join(directory, archive.filename);
    writeFileSync(
      join(host, "package.json"),
      `${JSON.stringify(
        {
          name: "stock-research-installation-acceptance",
          private: true,
          type: "module",
          dependencies: {
            "@deepseek-ai/dsh": targetVersion,
            ...Object.fromEntries(
              Object.keys(manifest.peerDependencies)
                .filter((name) => name.startsWith("@deepseek-ai/dsh-"))
                .map((name) => [name, targetVersion]),
            ),
            "@megapandas/dsh-stock-research": `file:${filename}`,
            semver: manifest.devDependencies.semver,
          },
          overrides: { zod: "4.6.6" },
          dsh: { profile: { bundles: ["@megapandas/dsh-stock-research"] } },
        },
        null,
        2,
      )}\n`,
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
      "config-editor",
      "settings",
      "client-modules",
    ].map((service) => ({
      id: `host-${service}`,
      name: `@deepseek-ai/dsh-${service}`,
      ...(service === "agent-loop" ? { config: { agents: [] } } : {}),
      ...(service === "subagent-spawn-in-process"
        ? { config: { providerName: "spawn" } }
        : {}),
      ...(service === "agent-preset-registry"
        ? { config: { default: "installation-user" } }
        : {}),
    }));
    // JSON is accepted by the official YAML dialect; the bundle itself keeps its !!js values.
    writeFileSync(
      join(host, "cordis.patch.yml"),
      JSON.stringify([{ insert: services }], null, 2),
    );
    console.log(
      `Installing DSH ${targetVersion} and the archive; package lifecycle scripts are disabled.`,
    );
    await execute(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        "--cache=/tmp/dsh-stock-npm-cache",
        "--fetch-retries=0",
        "--fetch-timeout=20000",
      ],
      { cwd: host, timeout: 180_000, maxBuffer: 2_000_000 },
    );
    console.log(
      "Booting the official profile without model adapters or user credentials.",
    );
    const probeScript = join(host, "check-install.mjs");
    writeFileSync(
      probeScript,
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
    );
    const result = await execute(
      process.execPath,
      [probeScript, "--probe", host, targetVersion],
      {
        cwd: host,
        timeout: 30_000,
        maxBuffer: 2_000_000,
        env: {
          PATH: process.env.PATH,
          DSH_HOME: join(directory, "home"),
        },
      },
    );
    assert.ok(
      result.stdout.includes(success),
      "The host must complete its assertions and shutdown.",
    );
    console.log(result.stdout.trim());
    console.log(
      `Archive files: ${archive.files.length}; unpacked bytes: ${archive.unpackedSize}.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--probe")
  await probe(process.argv[3], process.argv[4]);
else {
  const { values } = parseArgs({
    options: { "dsh-version": { type: "string" } },
  });
  await install(values["dsh-version"]);
}

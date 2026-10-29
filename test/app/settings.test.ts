import CommandRuntime from "@deepseek-ai/dsh-commands";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import z from "@deepseek-ai/schemastery";
import { runtimeHost } from "../fixtures/runtime-host.js";
import { gate } from "../fixtures/runtime-host.js";
import { workflowModel } from "../fixtures/research-workflow.js";
import { initialInput, researchCommands } from "../fixtures/quick-host.js";
import { readApplicationInput } from "../../src/app/research-input.js";
import { askAnswerResponse, askCollection } from "../fixtures/ask-host.js";
import * as Application from "../../src/plugin.js";

const { Config, Configuration } = Application;
type ApplicationConfig = Application.ApplicationConfig;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function host(
  respond?: NonNullable<Parameters<typeof runtimeHost>[0]>["respond"],
) {
  const h = await runtimeHost({
    respond: respond ?? (() => askAnswerResponse("固定输入已核实。")),
  });
  cleanups.push(h.close);
  await h.ctx.plugin(CommandRuntime);
  const config: ApplicationConfig = {
    runtime: h.config({ enabledSources: [] }),
  };
  delete config.runtime.digestModel;
  const userPresets = await h.ctx.agentPresets.remoteExportList();
  h.ctx.loader.builtins["stock-research"] = Application;
  await h.ctx.loader.root.update([
    { id: "stock-research", name: "cordis:stock-research", config },
  ]);
  await h.ctx.loader.await();
  const entry = h.ctx.loader.resolve("stock-research");
  await entry.fiber!.await();
  const original = h.ctx.stockResearch;
  vi.spyOn(original.collection, "collect").mockImplementation(async (scope) =>
    askCollection(scope),
  );
  vi.spyOn(h.adapter, "resolveModel").mockImplementation(
    async (provider, id) => ({
      provider,
      id,
      name: "Fixture model",
      reasoning: {
        efforts: [{ id: ReasoningEffortId("deliberate"), name: "深入思考" }],
      },
    }),
  );
  async function save(next: ApplicationConfig) {
    const input = structuredClone(next);
    Configuration(
      entry.fiber!.ctx.waterfall(
        entry.fiber!,
        "internal/config",
        input,
        () => input,
      ),
    );
    await entry.update({ config: input });
    await h.ctx.loader.await();
  }
  const commands = researchCommands(h.ctx, h.outside.agent);
  const execute = (line = "/stock-ask SZ.002594 2024-01-03 核实固定数据") =>
    commands.executeAndWait(line);
  return { ...h, entry, original, config, save, execute, userPresets };
}

describe("live stock research settings", () => {
  it("preserves the user's preset roster and main composition through a full deep run", async () => {
    const workflow = workflowModel();
    const h = await host(workflow.respond);
    expect(await h.ctx.agentPresets.remoteExportList()).toEqual(h.userPresets);
    await h.ctx.agentPresets.select(h.outside.agent, "research-task");
    const compositions: (string | undefined)[] = [];
    const headers: (string | undefined)[] = [];
    const origins: (string | undefined)[] = [];
    h.ctx.on("agent/created", ({ agent }) => {
      compositions.push(h.ctx.agentPresets.composedPreset(agent.ctx));
      headers.push(agent.session.header.agentPreset);
      origins.push(agent.session.header.origin);
      return undefined;
    });
    expect(
      (await h.execute("/stock-deep SZ.002594 2024-01-03"))?.result.kind,
    ).toBe("success");
    expect(
      h.ctx.stockResearch.runs.view({ runId: workflow.state.runId! }),
    ).toMatchObject({ mode: "deep", status: "completed" });
    expect(compositions.length).toBeGreaterThan(1);
    for (const [index, origin] of origins.entries()) {
      expect(compositions[index]).toBe(
        origin === "subagent" ? "research-task" : undefined,
      );
      expect(headers[index]).toBe(
        origin === "subagent" ? "research-task" : undefined,
      );
    }
    expect(await h.ctx.agentPresets.remoteExportList()).toEqual(h.userPresets);
    expect(h.ctx.agentPresets.composedPreset(h.outside.agent.ctx)).toBe(
      "research-task",
    );
  });

  it("publishes a browser-validatable form without Host callback closures", async () => {
    const h = await host();
    const schema = new z(JSON.parse(JSON.stringify(Config)));
    expect(schema(h.config).get()).toEqual({
      ...h.config,
      publicSearchLimit: 8,
    });
    expect(() =>
      schema({
        ...h.config,
        runtime: {
          ...h.config.runtime,
          http: { ...h.config.runtime.http, maxConcurrency: 0 },
        },
      }),
    ).toThrow();
  });

  it("validates the search allowance at configuration entry", async () => {
    const h = await host();
    for (const publicSearchLimit of [0, 2])
      expect(
        Configuration({ ...h.config, publicSearchLimit }).publicSearchLimit,
      ).toBe(publicSearchLimit);
    for (const publicSearchLimit of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
    ])
      expect(() => Configuration({ ...h.config, publicSearchLimit })).toThrow();
  });

  it("keeps model, digest and search allowance snapshots while collection is running", async () => {
    const workflow = workflowModel();
    const h = await host(workflow.respond);
    const before = structuredClone(h.config);
    before.model = { provider: "runtime-fixture", model: "first" };
    before.runtime.digestModel = {
      provider: "runtime-fixture",
      model: "first-digest",
    };
    before.publicSearchLimit = 2;
    await h.save(before);
    const paused = gate<void>();
    vi.mocked(h.original.collection.collect).mockImplementationOnce(
      async (scope) => {
        paused.started.resolve();
        await paused.released.promise;
        return askCollection(scope);
      },
    );
    const work = h.execute("/stock-quick SZ.002594 2024-01-03");
    await paused.started.promise;
    try {
      const changedResources = structuredClone(before);
      changedResources.runtime.http.timeoutMs += 1000;
      await expect(h.save(changedResources)).rejects.toThrow(
        "Research is running",
      );
      await h.save({
        ...before,
        model: { provider: "runtime-fixture", model: "second" },
        runtime: {
          ...before.runtime,
          digestModel: { provider: "runtime-fixture", model: "second-digest" },
        },
        publicSearchLimit: 7,
      });
    } finally {
      paused.released.resolve();
    }
    expect((await work)?.result.kind).toBe("success");
    for (const request of h.adapter.requests) {
      if (request.sessionId === h.outside.agent.id) {
        expect(request.model).toBe("runtime");
        continue;
      }
      const input = initialInput<{ task: { role: string } }>(request);
      expect(request.model).toBe(
        input.task.role === "digest" ? "first-digest" : "first",
      );
    }
    expect(
      readApplicationInput(h.ctx.stockResearch.runs, workflow.state.runId!)
        .publicSearchLimit,
    ).toBe(2);
    expect(h.ctx.stockResearchSettings.publicSearchLimit).toBe(7);
  });
  it("applies model and reasoning overrides to new commands and restores inheritance without replacing the runtime", async () => {
    const h = await host();
    expect((await h.execute())?.result.kind).toBe("success");
    const next = {
      ...h.config,
      model: {
        provider: "runtime-fixture",
        model: "configured",
        reasoningEffort: ReasoningEffortId("deliberate"),
      },
    };
    await h.save(next);
    expect(h.ctx.stockResearch).toBe(h.original);
    expect((await h.execute())?.result.kind).toBe("success");
    expect(h.adapter.requests.at(-1)).toMatchObject({
      model: "configured",
      reasoningEffort: "deliberate",
    });
    await h.save(h.config);
    expect((await h.execute())?.result.kind).toBe("success");
    expect(h.adapter.requests.at(-1)!.model).toBe("runtime");
    expect(h.adapter.requests.at(-1)!.reasoningEffort).toBeUndefined();
    expect(h.ctx.stockResearch).toBe(h.original);
  });

  it("refuses resource changes during an owned agent while allowing new model settings", async () => {
    const h = await host();
    const agent = await h.original.createAgent(
      h.agentOptions("busy-settings"),
      { kind: "coordinator", runIds: [] },
      [],
    );
    try {
      const next = structuredClone(h.config);
      next.runtime.http.timeoutMs += 1000;
      await expect(h.save(next)).rejects.toThrow("Research is running");
      expect(h.ctx.stockResearch).toBe(h.original);
      await h.save({ ...h.config, model: { reasoningEffort: null } });
      expect(h.ctx.stockResearch).toBe(h.original);
    } finally {
      await agent.dispose();
    }
  });

  it("reopens saved resources before the next command, keeps the original data and retains command registration", async () => {
    const h = await host();
    const next = structuredClone(h.config);
    next.runtime.dataRoot = join(h.directory, "separate-data");
    await h.save(next);
    expect(h.ctx.stockResearch).toBe(h.original);
    await expect(h.execute("/stock-ask invalid")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(h.ctx.stockResearch).not.toBe(h.original);
    expect(existsSync(join(next.runtime.dataRoot, "cache.sqlite"))).toBe(true);
    expect(existsSync(join(h.directory, "cache.sqlite"))).toBe(true);
    expect(h.ctx.commands.find(h.outside.agent, "stock-review")).toBeDefined();
    expect(h.adapter.requests).toEqual([]);
  });

  it("restores working resources after initialization fails and permits correcting the saved configuration", async () => {
    const h = await host();
    const next = structuredClone(h.config);
    next.runtime.dataRoot = join(h.directory, "not-a-directory");
    writeFileSync(next.runtime.dataRoot, "existing file");
    await h.save(next);
    await expect(h.execute("/stock-ask invalid")).rejects.toMatchObject({
      code: "STORAGE_FAILED",
      cause: { code: "EEXIST" },
    });
    expect(h.ctx.stockResearch).toBeDefined();
    expect(h.ctx.commands.find(h.outside.agent, "stock-ask")).toBeDefined();
    next.runtime.dataRoot = join(h.directory, "corrected-data");
    await h.save(next);
    await expect(h.execute("/stock-ask invalid")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(existsSync(join(next.runtime.dataRoot, "cache.sqlite"))).toBe(true);
    expect(h.ctx.commands.find(h.outside.agent, "stock-review")).toBeDefined();
  });
});

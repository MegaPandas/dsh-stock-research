import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import WebRuntime, { type WebSearchProvider } from "@deepseek-ai/dsh-web";
import {
  createResearchPlugin,
  type ResearchConfig,
} from "../../src/runtime.js";
import { US_SECURITY } from "./market.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function gate<T>() {
  return {
    started: deferred<T>(),
    aborted: deferred<void>(),
    released: deferred<void>(),
  };
}
export async function* textResponse(text: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
class RuntimeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(
    private readonly respond: (
      request: GenerateOptions,
    ) => AsyncIterable<StreamChunk>,
  ) {
    super();
  }
  stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    return this.respond(request);
  }
}
export function markerTool(name = "host_marker"): ToolDefinition {
  return {
    name,
    description: "An existing host plugin capability",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute() {
      return "host remains available";
    },
  };
}

export async function runtimeHost(
  options: {
    respond?: (request: GenerateOptions) => AsyncIterable<StreamChunk>;
    search?: WebSearchProvider["search"];
  } = {},
) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-runtime-"));
  const ctx = new Context();
  async function close() {
    try {
      await ctx.fiber.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  try {
    await mountAgentLoopTestDependencies(ctx, {
      workingDirectory: true,
      tools: { mode: "native" },
    });
    await ctx.plugin(Loader, { baseUrl: import.meta.url });
    await ctx.plugin(AgentPresetRegistry, { default: "research-task" });
    await ctx.agentPresets.register({ id: "research-task", plugins: [] });
    await mountAgentLoopTestHarness(ctx);
    await ctx.plugin(LocalJobRegistry, {});
    await ctx.plugin(SubagentRuntime, {});
    await ctx.plugin(SpawnInProcess, { providerName: "spawn" });
    const adapter = new RuntimeAdapter(
      options.respond ?? (() => textResponse("Fixture complete.")),
    );
    ctx.llm.registerAdapter(["runtime-fixture"], adapter);
    if (options.search !== undefined) {
      await ctx.plugin(WebRuntime, {});
      ctx.web.registerSearchProvider({
        id: "runtime-fixture",
        available: () => true,
        search: options.search,
      });
    }
    const marker = markerTool();
    await ctx.plugin({
      name: "existing-host-fixture",
      inject: ["tools"],
      apply(pluginCtx: Context) {
        pluginCtx.tools.register(marker);
      },
    });
    const outside = await ctx.agents.create({
      sessionId: SessionId("host-other"),
      agentOptions: { provider: "runtime-fixture", model: "runtime" },
      meta: { cwd: directory },
    });
    const scope = {
      security: US_SECURITY,
      date: "2024-01-03",
      cutoff: "2024-01-03T22:00:00.000Z",
    };
    function config(changes: Partial<ResearchConfig> = {}): ResearchConfig {
      return {
        dataRoot: directory,
        enabledSources: ["sina", "fred"],
        http: { timeoutMs: 60_000, maxConcurrency: 1, minIntervalMs: 1000 },
        cache: {
          maxEntries: 10,
          ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
        },
        policy: {
          freshness: { market: 0, fundamentals: 0, macro: 0 },
          secCiks: {},
        },
        ...changes,
      };
    }
    async function mount(settings = config()) {
      const fiber = ctx.plugin(
        createResearchPlugin(() => {
          throw new Error(
            "Unexpected role dispatch in runtime ownership fixture",
          );
        }),
        settings,
      );
      await fiber;
      const runtime = ctx.get("stockResearch");
      if (runtime === undefined)
        throw new Error("Research plugin did not publish its ready service");
      return { fiber, runtime };
    }
    function agentOptions(id: string) {
      return {
        sessionId: SessionId(id),
        agentOptions: { provider: "runtime-fixture", model: "runtime" },
        meta: { cwd: directory },
      };
    }
    return {
      ctx,
      directory,
      adapter,
      marker,
      outside,
      scope,
      config,
      mount,
      agentOptions,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

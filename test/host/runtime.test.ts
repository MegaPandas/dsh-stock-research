import fs from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  createUserMessage,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { WebSearchRequest } from "@deepseek-ai/dsh-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataRoot } from "../../src/storage/data-root.js";
import {
  deferred,
  gate,
  markerTool,
  runtimeHost,
  textResponse,
} from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
const fetch = vi.fn(async () => {
  throw new Error("Unexpected external fetch in runtime fixture");
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});
async function host(options?: Parameters<typeof runtimeHost>[0]) {
  const h = await runtimeHost(options);
  cleanups.push(h.close);
  return h;
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}
function lockExists(directory: string) {
  return fs.existsSync(join(directory, ".writer.lock"));
}
function reacquire(directory: string) {
  const root = new DataRoot(directory);
  root.close();
}
function stockNames(h: Awaited<ReturnType<typeof host>>) {
  return h.ctx.tools
    .schemas()
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("stock_"))
    .sort();
}

describe("research runtime plugin with the real DSH host", () => {
  it("publishes its ready service and twenty tools without querying enabled sources", async () => {
    let searches = 0;
    const h = await host({
      search: async () => {
        searches++;
        return { sources: [], truncated: false };
      },
    });
    const mounted = await h.mount(
      h.config({ enabledSources: ["sina", "fred", "dsh-web"] }),
    );
    expect(h.ctx.get("stockResearch")).toBeDefined();
    expect(mounted.runtime.tools).toHaveLength(20);
    expect(new Set(stockNames(h)).size).toBe(20);
    const health = mounted.runtime.queries.health(h.scope);
    expect(
      health.sources
        .filter((source) => source.capability !== null)
        .map((source) => `${source.dataset}/${source.provider}`)
        .sort(),
    ).toEqual(["fundamentals/sina", "macro/fred", "research/dsh-web"]);
    expect(
      health.sources.every(
        (source) =>
          source.sourceCalls === 0 &&
          source.cacheHits === 0 &&
          source.lastQuery === null,
      ),
    ).toBe(true);
    expect(searches).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.adapter.requests).toHaveLength(0);
  });

  it("binds before the first model call and gates extra tools added by the original setup commit", async () => {
    let calls = 0;
    const h = await host({
      respond: async function* (): AsyncIterable<StreamChunk> {
        if (++calls === 1) {
          const id = ToolCallId("health");
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: 0,
            id,
            name: "stock_data_health",
            argumentsDelta: "{}",
          };
          yield {
            type: "block-end",
            index: 0,
            block: {
              type: "tool-call",
              id,
              name: "stock_data_health",
              arguments: "{}",
            },
          };
          yield { type: "finish", reason: { kind: "tool-calls" } };
        } else yield* textResponse("Health inspected.");
      },
    });
    const { runtime } = await h.mount();
    const health = runtime.tools.find(
      (tool) => tool.name === "stock_data_health",
    )!;
    const handle = await runtime.createAgent(
      h.agentOptions("research-ask"),
      { kind: "ask", scope: h.scope },
      [health],
    );
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: "Inspect data health." }],
        source: { kind: "user" },
      }),
    );
    await handle.agent.whenIdle();
    expect(h.adapter.requests).toHaveLength(2);
    expect(h.adapter.requests[0]?.sessionId).toBe(handle.agent.id);
    expect(h.adapter.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      health.name,
    ]);
    const toolMessage = h.adapter.requests[1]!.messages.find(
      (message) => message.role === "tool",
    )!;
    expect(toolMessage.isError).not.toBe(true);
    const text = toolMessage.content.find((block) => block.type === "text")!;
    expect(text.type).toBe("text");
    if (text.type !== "text")
      throw new Error("Expected the canonical health result");
    expect(JSON.parse(text.text)).toMatchObject({ scope: h.scope });
    expect(
      await h.ctx.tools.execute({
        agent: h.outside.agent,
        callId: ToolCallId("outside"),
        name: health.name,
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      isError: true,
      error: { info: { code: "ACCESS_DENIED" } },
    });

    let originalCommitted = false;
    const options = h.agentOptions("extra-tool-commit");
    const extraHandle = await runtime.createAgent(
      {
        ...options,
        setup(agentCtx) {
          return {
            commit() {
              originalCommitted = true;
              agentCtx.tools.register(markerTool("unsafe_file"));
            },
          };
        },
      },
      { kind: "ask", scope: h.scope },
      [health],
    );
    expect(originalCommitted).toBe(true);
    expect(h.ctx.tools.get("unsafe_file", extraHandle.agent)).toBeDefined();
    expect(
      await h.ctx.tools.execute({
        agent: extraHandle.agent,
        callId: ToolCallId("extra-tool"),
        name: "unsafe_file",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ isError: true });
    expect(
      await h.ctx.tools.execute({
        agent: extraHandle.agent,
        callId: ToolCallId("approved-tool"),
        name: health.name,
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ isError: false, value: { scope: h.scope } });
  });

  it("preserves malformed streamed arguments only for its owned research Agent", async () => {
    const raw = '{"queries":[{"text":"original draft"}]}}';
    const h = await host({
      respond: async function* (request) {
        if (request.messages.some((message) => message.role === "tool")) {
          yield* textResponse("Feedback received.");
          return;
        }
        const id = ToolCallId("malformed");
        const name =
          request.sessionId === "host-other"
            ? "host_marker"
            : "stock_data_health";
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        for (const argumentsDelta of [raw.slice(0, 15), raw.slice(15)])
          yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "tool-call", id, name, arguments: "{}" },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      },
    });
    const { runtime } = await h.mount();
    const health = runtime.tools.find(
      (tool) => tool.name === "stock_data_health",
    )!;
    const handle = await runtime.createAgent(
      h.agentOptions("research-arguments"),
      { kind: "ask", scope: h.scope },
      [health],
    );
    for (const agent of [handle.agent, h.outside.agent]) {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "Inspect." }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
    }
    const feedback = h.adapter.requests
      .filter((request) =>
        request.messages.some((message) => message.role === "tool"),
      )
      .map((request) =>
        request.messages.find((message) => message.role === "tool")!,
      );
    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toMatchObject({ isError: true });
    const errorText = feedback[0]!.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(errorText).toContain(raw);
    expect(errorText).toContain("Parsing that text as JSON failed:");
    expect(feedback[1]!.isError).not.toBe(true);
    expect(feedback[1]).toMatchObject({
      content: [{ type: "text", text: "host remains available" }],
    });
  });

  it("unloads only its owned Agents, closes idempotently and reinstalls without contributions leaking", async () => {
    const h = await host();
    const first = await h.mount();
    const health = first.runtime.tools.find(
      (tool) => tool.name === "stock_data_health",
    )!;
    const owned = await first.runtime.createAgent(
      h.agentOptions("owned"),
      { kind: "ask", scope: h.scope },
      [health],
    );
    await Promise.all([first.runtime.close(), first.runtime.close()]);
    await first.fiber.dispose();
    expect(h.ctx.agents.get(owned.agent.id)).toBeUndefined();
    expect(h.ctx.sessions.get(owned.agent.id)).toBeUndefined();
    expect(h.ctx.agents.get(h.outside.agent.id)).toBe(h.outside.agent);
    expect(h.ctx.tools.get(h.marker.name)).toBe(h.marker);
    expect(h.ctx.get("stockResearch")).toBeUndefined();
    expect(stockNames(h)).toEqual([]);
    await expect(async () =>
      first.runtime.createAgent(
        h.agentOptions("after-close"),
        { kind: "ask", scope: h.scope },
        [health],
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    reacquire(h.directory);
    const second = await h.mount();
    expect(second.runtime.tools).toHaveLength(20);
    expect(stockNames(h)).toHaveLength(20);
    await second.fiber.dispose();
    expect(stockNames(h)).toEqual([]);
    expect(h.ctx.agents.get(h.outside.agent.id)).toBe(h.outside.agent);
    reacquire(h.directory);
  });

  it("waits for an asynchronous original setup to finish before releasing its data root", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = await host();
    const { runtime } = await h.mount();
    cleanups.push(async () => {
      release.resolve();
    });
    const health = runtime.tools.find(
      (tool) => tool.name === "stock_data_health",
    )!;
    let setupFinished = false;
    let committed = false;
    const options = h.agentOptions("pending-setup");
    const creation = observe(
      runtime.createAgent(
        {
          ...options,
          async setup() {
            entered.resolve();
            await release.promise;
            setupFinished = true;
            return {
              commit() {
                committed = true;
              },
            };
          },
        },
        { kind: "ask", scope: h.scope },
        [health],
      ),
    );
    await entered.promise;
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await setImmediate();
    expect(closed).toBe(false);
    expect(setupFinished).toBe(false);
    expect(lockExists(h.directory)).toBe(true);
    release.resolve();
    expect(await creation).toMatchObject({
      kind: "rejected",
      reason: expect.any(Error),
    });
    await closing;
    expect(setupFinished).toBe(true);
    expect(committed).toBe(false);
    expect(h.ctx.agents.get(options.sessionId)).toBeUndefined();
    expect(h.ctx.sessions.get(options.sessionId)).toBeUndefined();
    reacquire(h.directory);
  });

  it("keeps the writer lock until both an owned model and an ordinary query producer have drained", async () => {
    const model = gate<GenerateOptions>();
    const search = gate<{
      request: WebSearchRequest;
      signal: AbortSignal | undefined;
    }>();
    const h = await host({
      respond: async function* (request): AsyncIterable<StreamChunk> {
        const aborted = () => model.aborted.resolve();
        request.signal?.addEventListener("abort", aborted, { once: true });
        model.started.resolve(request);
        try {
          await model.released.promise;
          request.signal?.throwIfAborted();
          yield* textResponse("Late model output.");
        } finally {
          request.signal?.removeEventListener("abort", aborted);
        }
      },
      search: async (request, signal) => {
        const aborted = () => search.aborted.resolve();
        signal?.addEventListener("abort", aborted, { once: true });
        search.started.resolve({ request, signal });
        try {
          await search.released.promise;
          signal?.throwIfAborted();
          return { sources: [], truncated: false };
        } finally {
          signal?.removeEventListener("abort", aborted);
        }
      },
    });
    const mounted = await h.mount(h.config({ enabledSources: ["dsh-web"] }));
    cleanups.push(async () => {
      model.released.resolve();
      search.released.resolve();
    });
    const health = mounted.runtime.tools.find(
      (tool) => tool.name === "stock_data_health",
    )!;
    const owned = await mounted.runtime.createAgent(
      h.agentOptions("model-owner"),
      { kind: "ask", scope: h.scope },
      [health],
    );
    owned.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: "Wait for provider." }],
        source: { kind: "user" },
      }),
    );
    const query = observe(
      mounted.runtime.queries.query(h.scope, {
        dataset: "research",
        provider: "dsh-web",
        parameters: { query: "one necessary query", maxResults: 1 },
      }),
    );
    await Promise.all([model.started.promise, search.started.promise]);
    let unloaded = false;
    const unloading = mounted.fiber.dispose().then(() => {
      unloaded = true;
    });
    await Promise.all([model.aborted.promise, search.aborted.promise]);
    expect(unloaded).toBe(false);
    expect(lockExists(h.directory)).toBe(true);
    model.released.resolve();
    await setImmediate();
    expect(unloaded).toBe(false);
    expect(lockExists(h.directory)).toBe(true);
    search.released.resolve();
    await unloading;
    expect(await query).toMatchObject({
      kind: "rejected",
      reason: expect.any(Error),
    });
    expect(h.ctx.agents.get(owned.agent.id)).toBeUndefined();
    expect(h.ctx.agents.get(h.outside.agent.id)).toBe(h.outside.agent);
    expect(h.ctx.get("stockResearch")).toBeUndefined();
    expect(stockNames(h)).toEqual([]);
    reacquire(h.directory);
  });

  it.each(["missing-web", "corrupt-cache", "tool-conflict"] as const)(
    "rolls back %s startup while preserving the existing host plugin",
    async (problem) => {
      const h = await host();
      const conflict = markerTool("stock_get_macro");
      let unregister: (() => void) | undefined;
      if (problem === "corrupt-cache")
        fs.writeFileSync(
          join(h.directory, "cache.sqlite"),
          "not a SQLite database",
        );
      if (problem === "tool-conflict")
        unregister = h.ctx.tools.register(conflict);
      const failed = await observe(
        h.mount(
          h.config({
            enabledSources: problem === "missing-web" ? ["dsh-web"] : [],
          }),
        ),
      );
      expect(failed).toMatchObject({
        kind: "rejected",
        reason: expect.any(Error),
      });
      if (problem === "missing-web")
        expect(failed).toMatchObject({
          reason: { code: "SOURCE_UNAVAILABLE" },
        });
      expect(h.ctx.get("stockResearch")).toBeUndefined();
      expect(h.ctx.tools.get(h.marker.name)).toBe(h.marker);
      expect(stockNames(h)).toEqual(
        problem === "tool-conflict" ? [conflict.name] : [],
      );
      expect(h.ctx.agents.get(h.outside.agent.id)).toBe(h.outside.agent);
      reacquire(h.directory);
      unregister?.();
      if (problem === "corrupt-cache")
        fs.rmSync(join(h.directory, "cache.sqlite"));
      const recovered = await h.mount();
      expect(recovered.runtime.tools).toHaveLength(20);
      expect(fetch).not.toHaveBeenCalled();
      await recovered.fiber.dispose();
      expect(stockNames(h)).toEqual([]);
      reacquire(h.directory);
    },
  );
});

import fs from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  HarnessError,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { DataRoot } from "../../src/storage/data-root.js";
import {
  askAnswerResponse,
  askCollection,
  askHost,
} from "../fixtures/ask-host.js";
import { gate, textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error("Unexpected fetch in ask fixture");
});
beforeEach(() => {
  fetch
    .mockReset()
    .mockRejectedValue(new Error("Unexpected fetch in ask fixture"));
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
async function host(options?: Parameters<typeof askHost>[0]) {
  const h = await askHost(options);
  cleanups.push(h.close);
  return h;
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}
async function* block(
  index: number,
  type: "text" | "reasoning",
  text: string,
): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index, blockType: type };
  if (type === "text") yield { type: "text-delta", index, text };
  else yield { type: "reasoning-delta", index, text };
  yield { type: "block-end", index, block: { type, text } };
}
async function* collectionCall(
  index = 2,
  parameters: Record<string, unknown> = {
    table: "market.daily",
    fields: ["close"],
    offset: 1,
    limit: 1,
  },
): AsyncIterable<StreamChunk> {
  const id = ToolCallId("saved-source-page");
  const args = JSON.stringify(parameters);
  yield { type: "block-start", index, blockType: "tool-call" };
  yield {
    type: "tool-call-delta",
    index,
    id,
    name: "stock_read_collection",
    argumentsDelta: args,
  };
  yield {
    type: "block-end",
    index,
    block: {
      type: "tool-call",
      id,
      name: "stock_read_collection",
      arguments: args,
    },
  };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
const readOnlyTools = [
  "stock_describe_collection",
  "stock_read_collection",
  "stock_recall",
  "stock_submit",
].sort();

describe("stock-ask through real commands, runtime and AgentLoop", () => {
  it("uses one scoped read-only Agent and returns its submitted business answer", async () => {
    let modelCalls = 0;
    let adoptedCutoff: string | undefined;
    let captured: CollectionSnapshot | undefined;
    const searches = vi.fn(async () => ({ sources: [], truncated: false }));
    const h = await host({
      enabledSources: ["tencent", "dsh-web"],
      search: searches,
      collect: async (scope) => {
        captured = askCollection(scope);
        return captured;
      },
      respond: async function* (request): AsyncIterable<StreamChunk> {
        if (++modelCalls === 1) {
          yield* block(0, "reasoning", "内部推理不应返回给用户。");
          yield* block(
            1,
            "text",
            "读取已经采集的资料，这段工具调用评论不应成为最终答案。",
          );
          yield* collectionCall();
          return;
        }
        const message = request.messages.find((entry) => entry.role === "tool");
        const text = message?.content.find((entry) => entry.type === "text");
        if (text?.type !== "text")
          throw new Error(
            "The offline collection tool did not return its canonical result",
          );
        const result = JSON.parse(text.text) as {
          cutoff: string;
          source: { url: string };
          data: { rows: { date: string; values: { close: number } }[] };
          totalRows: number;
        };
        adoptedCutoff = result.cutoff;
        expect(result.totalRows).toBe(2);
        expect(result.data.rows).toHaveLength(1);
        const item = result.data.rows[0]!;
        yield* askAnswerResponse(
          `${item.date}收盘价为${item.values.close}元。`,
        );
      },
    });
    const before = h.researchState();
    const parentEvents: string[] = [];
    h.ctx.on("session/event", (session, event) => {
      if (session === h.outside.agent.session) parentEvents.push(event.type);
    });
    const result = await h.execute();
    expect(result?.result).toEqual({
      kind: "success",
      text: "2024-01-03收盘价为82元。",
    });
    expect(h.created).toHaveLength(1);
    const agent = h.created[0]!;
    expect(agent.id).not.toBe(h.outside.agent.id);
    expect(h.adapter.requests).toHaveLength(2);
    expect(
      h.adapter.requests.every((request) => request.sessionId === agent.id),
    ).toBe(true);
    expect(
      h.adapter.requests[0]!.tools!.map((tool) => tool.name).sort(),
    ).toEqual(readOnlyTools);
    for (const tool of h.adapter.requests[0]!.tools!) {
      const variants = (tool.parameters.oneOf ?? [tool.parameters]) as {
        properties: Record<string, unknown>;
      }[];
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants) {
        expect(variant.properties).not.toHaveProperty("source");
        expect(variant.properties).not.toHaveProperty("runId");
      }
    }
    expect(
      h.runtime.tools.find(({ name }) => name === "stock_get_market")!
        .parameters.properties,
    ).toHaveProperty("source");
    const reader = h.adapter.requests[0]!.tools!.find(
      (tool) => tool.name === "stock_read_collection",
    )!;
    expect(reader.parameters).toMatchObject({
      type: "object",
      required: ["table", "fields", "offset", "limit"],
      properties: {
        table: { type: "string" },
        fields: { type: "array" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
    });
    expect(reader.parameters).not.toHaveProperty("oneOf");
    expect(reader.parameters.properties).not.toHaveProperty("kind");
    expect(
      h.adapter.requests[0]!.tools!.find(
        (tool) => tool.name === "stock_describe_collection",
      )!.parameters,
    ).toEqual({
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
      additionalProperties: false,
    });
    const prompt = h.adapter.requests[0]!.messages.find(
      (message) => message.role === "user",
    )!;
    const text = prompt.content.find((entry) => entry.type === "text")!;
    if (text.type !== "text") throw new Error("Expected the bound ask input");
    const input = JSON.parse(text.text) as {
      scope: unknown;
      task: { role: string; objective: string };
      context: {
        dataCatalog: {
          id: string;
          recordCount: number;
          range: { from: string; to: string };
        }[];
        collectionFailures: CollectionSnapshot["failures"];
      };
    };
    expect(input).toMatchObject({
      scope: {
        security: {
          id: "CN:002594.SZ",
          market: "CN",
          symbol: "002594.SZ",
          exchange: "SZ",
          currency: "CNY",
          timeZone: "Asia/Shanghai",
        },
        date: "2024-01-03",
        cutoff: "2024-01-03T15:59:59.999Z",
      },
      task: { role: "ask", objective: "请核实资料并说明时间限制" },
    });
    expect(input.context.dataCatalog).toEqual([
      expect.objectContaining({
        id: "market.daily",
        recordCount: 2,
        range: { from: "2024-01-02", to: "2024-01-03" },
        quality: {
          stale: false,
          historicalKnowledge: "unverified",
          missingValues: 0,
        },
      }),
    ]);
    for (const entry of input.context.dataCatalog)
      for (const field of [
        "latest",
        "columns",
        "candidateClaims",
        "gaps",
        "source",
      ])
        expect(entry).not.toHaveProperty(field);
    expect(input.context.collectionFailures).toEqual(captured!.failures);
    expect(h.collection).toHaveBeenCalledTimes(1);
    expect(h.collection.mock.calls[0]![0].security.id).toBe("CN:002594.SZ");
    expect(searches).not.toHaveBeenCalled();
    expect(adoptedCutoff).toBe("2024-01-03T15:59:59.999Z");
    expect(fetch).not.toHaveBeenCalled();
    expect(h.researchState()).toEqual(before);
    expect(h.outside.agent.inbox.nextStep).toEqual([]);
    expect(h.outside.agent.inbox.nextTurn).toEqual([]);
    expect(parentEvents).not.toContain("assistant/message");
    expect(parentEvents).not.toContain("user/message");
    expect(parentEvents).not.toContain("turn/start");
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.ctx.sessions.get(agent.id)).toBeUndefined();
  });

  it("finishes deterministic collection before creating any analysis Agent", async () => {
    const collection = gate<void>();
    const h = await host({
      collect: async (scope, signal) => {
        collection.started.resolve();
        await collection.released.promise;
        signal?.throwIfAborted();
        return askCollection(scope);
      },
      respond: () => askAnswerResponse("仅使用已保存的数据。"),
    });
    cleanups.push(async () => collection.released.resolve());
    const command = h.execute();
    await collection.started.promise;
    expect(h.created).toEqual([]);
    expect(h.adapter.requests).toEqual([]);
    expect(h.collection).toHaveBeenCalledTimes(1);
    collection.released.resolve();
    expect((await command)?.result).toEqual({
      kind: "success",
      text: "仅使用已保存的数据。",
    });
    expect(h.created).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates a failed collection before creating a model or writing research state", async () => {
    const failure = new ResearchError(
      "STORAGE_FAILED",
      "Could not retain the source snapshot.",
    );
    const h = await host({
      collect: async () => {
        throw failure;
      },
    });
    const before = h.researchState();
    await expect(h.execute()).rejects.toBe(failure);
    expect(h.created).toEqual([]);
    expect(h.adapter.requests).toEqual([]);
    expect(h.researchState()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start analysis when the required daily table was not collected", async () => {
    const h = await host({ collect: "runtime", enabledSources: [] });
    await expect(h.execute()).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
    expect(h.created).toEqual([]);
    expect(h.adapter.requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { offset: -1, limit: 1 },
    { offset: 0, limit: 0 },
    { offset: 0, limit: 101 },
  ])(
    "rejects an out-of-contract offline page without contacting a source",
    async (page) => {
      let calls = 0;
      const h = await host({
        respond: async function* (request): AsyncIterable<StreamChunk> {
          if (++calls === 1) {
            yield* collectionCall(0, {
              table: "market.daily",
              fields: ["close"],
              ...page,
            });
            return;
          }
          const result = request.messages.find(
            (message) => message.role === "tool",
          );
          expect(JSON.stringify(result)).toContain("INVALID_INPUT");
          yield* askAnswerResponse("请求的数据页范围无效。");
        },
      });
      expect((await h.execute())?.result).toEqual({
        kind: "success",
        text: "请求的数据页范围无效。",
      });
      expect(h.adapter.requests).toHaveLength(2);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["empty", "empty-after-tool", "nonstop", "sdk-error"] as const)(
    "does not return success for an %s model outcome",
    async (problem) => {
      const failure = new HarnessError(
        "Fixture ask request rejected",
        "INVALID_INPUT",
      );
      let calls = 0;
      const h = await host({
        collect: async (scope) => askCollection(scope),
        respond: async function* (): AsyncIterable<StreamChunk> {
          if (problem === "sdk-error") throw failure;
          if (problem === "empty-after-tool") {
            if (++calls === 1) {
              yield* block(
                0,
                "text",
                "This intermediate comment is not an answer.",
              );
              yield* collectionCall(1);
            } else yield { type: "finish", reason: { kind: "stop" } };
            return;
          }
          yield* block(
            0,
            "text",
            problem === "empty" ? "   " : "Incomplete answer",
          );
          yield {
            type: "finish",
            reason: { kind: problem === "nonstop" ? "max-tokens" : "stop" },
          };
        },
      });
      await expect(h.execute()).rejects.toMatchObject({
        code: problem === "sdk-error" ? "INVALID_INPUT" : "INVALID_ARTIFACT",
      });
      expect(h.created).toHaveLength(1);
      expect(h.ctx.sessions.get(h.created[0]!.id)).toBeUndefined();
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid dates, symbols, missing questions and pre-cancelled commands before any model or source call", async () => {
    let searches = 0;
    const h = await host({
      search: async () => {
        searches++;
        return { sources: [], truncated: false };
      },
    });
    for (const line of [
      "/stock-ask SZ.002594 2024-02-30 问题",
      "/stock-ask BYD 2024-01-03 问题",
      "/stock-ask SZ.002594 2024-01-03   ",
      "/stock-ask SZ.002594 2099-01-03 问题",
    ])
      await expect(h.execute(line)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    const controller = new AbortController();
    controller.abort(
      new DOMException("Cancelled before command admission", "AbortError"),
    );
    await expect(h.execute(undefined, controller.signal)).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(h.created).toEqual([]);
    expect(h.adapter.requests).toEqual([]);
    expect(h.collection).not.toHaveBeenCalled();
    expect(searches).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["model", "collection"] as const)(
    "drains the cancelled %s producer through its owning module",
    async (producer) => {
      const model = gate<GenerateOptions>();
      const source = gate<{ signal: AbortSignal | undefined }>();
      let released = false;
      if (producer === "collection")
        fetch.mockImplementationOnce(async (_input, options) => {
          const signal = options?.signal ?? undefined;
          const aborted = () => source.aborted.resolve();
          signal?.addEventListener("abort", aborted, { once: true });
          source.started.resolve({ signal });
          try {
            await source.released.promise;
            signal?.throwIfAborted();
            return new Response("{}");
          } finally {
            released = true;
            signal?.removeEventListener("abort", aborted);
          }
        });
      const h = await host({
        enabledSources: producer === "collection" ? ["eastmoney-market"] : [],
        ...(producer === "collection" ? { collect: "runtime" as const } : {}),
        respond: async function* (request): AsyncIterable<StreamChunk> {
          const aborted = () => model.aborted.resolve();
          request.signal?.addEventListener("abort", aborted, { once: true });
          model.started.resolve(request);
          try {
            await model.released.promise;
            request.signal?.throwIfAborted();
            yield* textResponse("Late answer");
          } finally {
            released = true;
            request.signal?.removeEventListener("abort", aborted);
          }
        },
      });
      cleanups.push(async () => {
        model.released.resolve();
        source.released.resolve();
      });
      const controller = new AbortController();
      const command = observe(h.execute(undefined, controller.signal));
      await (producer === "model"
        ? model.started.promise
        : source.started.promise);
      if (producer === "collection") {
        expect(h.created).toEqual([]);
        expect(h.adapter.requests).toEqual([]);
      }
      controller.abort(new DOMException("Cancel ask", "AbortError"));
      expect(await command).toMatchObject({
        kind: "rejected",
        reason: { name: "AbortError" },
      });
      await (producer === "model"
        ? model.aborted.promise
        : source.aborted.promise);
      if (producer === "model") {
        let unloaded = false;
        const unloading = h.askFiber.dispose().then(() => {
          unloaded = true;
        });
        await setImmediate();
        expect(unloaded).toBe(false);
        expect(released).toBe(false);
        model.released.resolve();
        await unloading;
        expect(h.ctx.get("stockResearch")).toBeDefined();
      } else {
        await h.askFiber.dispose();
        expect(released).toBe(false);
        expect(h.ctx.get("stockResearch")).toBeDefined();
        let closed = false;
        const closing = h.runtime.close().then(() => {
          closed = true;
        });
        await setImmediate();
        expect(closed).toBe(false);
        expect(fs.existsSync(join(h.directory, ".writer.lock"))).toBe(true);
        source.released.resolve();
        await closing;
        expect(h.ctx.get("stockResearch")).toBeUndefined();
        const reopened = new DataRoot(h.directory);
        reopened.close();
      }
      expect(released).toBe(true);
      expect(h.ctx.commands.find(h.outside.agent, "stock-ask")).toBeUndefined();
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    },
  );

  it("reinstalls only its own command and preserves other host commands and Agents", async () => {
    const h = await host({
      respond: () => askAnswerResponse("2024-01-03收盘价为82元。"),
    });
    await h.askFiber.dispose();
    expect(h.ctx.commands.find(h.outside.agent, "stock-ask")).toBeUndefined();
    const second = await h.mountAsk();
    expect(
      h.ctx.commands
        .list(h.outside.agent)
        .filter((command) => command.name === "stock-ask"),
    ).toHaveLength(1);
    expect((await h.execute())?.result).toEqual({
      kind: "success",
      text: "2024-01-03收盘价为82元。",
    });
    await Promise.all([second.dispose(), second.dispose()]);
    expect(
      (
        await h.ctx.commands.execute(
          h.outside.agent,
          "/host-ping",
          [],
          new AbortController().signal,
        )
      )?.result,
    ).toEqual({ kind: "success", text: "pong" });
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.ctx.get("stockResearch")).toBeDefined();
  });
});

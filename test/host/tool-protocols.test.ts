import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import { afterEach, expect, it, vi } from "vitest";
import { collectionDataTools } from "../../src/app/collection-tools.js";
import { createPublicSearchSession } from "../../src/app/public-search.js";
import { createReportReader } from "../../src/app/report-reader.js";
import { createReportDraft } from "../../src/host/report-draft.js";
import {
  computedValuationDraftTools,
  scopedCalculationReader,
} from "../../src/app/valuation-tools.js";
import {
  createValuationMethodTool,
  VALUATION_METHODS,
} from "../../src/app/valuation-methods.js";
import { quickHost } from "../fixtures/quick-host.js";
import { textResponse } from "../fixtures/runtime-host.js";
import { askCollection } from "../fixtures/ask-host.js";
import { US_SECURITY } from "../fixtures/market.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const protocols = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

function response(api: (typeof protocols)[number]): Response {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const body =
    api === "openai-completions"
      ? `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      : api === "openai-responses"
        ? event("response.output_item.done", {
            output_index: 0,
            item: {
              id: "message",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          }) +
          event("response.completed", {
            response: {
              id: "fixture",
              model: "fixture",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          })
        : event("message_start", {
            message: {
              id: "fixture",
              type: "message",
              role: "assistant",
              model: "fixture",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
          event("content_block_start", {
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          }) +
          event("message_stop", {});
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

it.each(protocols)(
  "preserves research tool fields through the real %s adapter",
  async (api) => {
    const h = await quickHost(() => textResponse("unused"));
    cleanups.push(h.close);
    vi.stubEnv("DSH_TOOL_PROTOCOL_KEY", "fixture-only-key");
    await h.ctx.plugin(PiAi, {
      providers: {
        fixture: {
          api,
          baseURL: "https://model.invalid/v1",
          apiKeyEnv: "DSH_TOOL_PROTOCOL_KEY",
          models: [{ id: "fixture" }],
          retryPolicy: { mode: "normal", maxRetries: 0 },
        },
      },
    });
    const roleTools = [
      createValuationMethodTool(VALUATION_METHODS),
      scopedCalculationReader(
        h.runtime.tools.find(
          ({ name }) => name === "stock_read_valuation_calculation",
        )!,
        "fixture-run",
      ),
      ...collectionDataTools(
        askCollection({
          security: US_SECURITY,
          date: "2024-01-03",
          cutoff: "2024-01-03T21:00:00.000Z",
        }).packets,
      ),
      createReportReader([], []).tool,
      createPublicSearchSession({
        search: async () => {
          throw new Error("Unexpected search");
        },
        approve: async () => false,
      }).tool,
      ...computedValuationDraftTools(
        createReportDraft("analysis", () => undefined, undefined, false, {})
          .tools,
        h.runtime.runs,
        "fixture-run",
      ),
    ];
    const agent = await h.ctx.agents.create(h.agentOptions("protocol-tools"));
    const definitions = new Map(
      [...h.runtime.tools, ...roleTools].map((tool) => [tool.name, tool]),
    );
    for (const tool of definitions.values())
      agent.agent.ctx.tools.register(tool);
    const declarations: ToolSchema[] = h.ctx.tools
      .schemas(agent.agent)
      .filter(({ name }) => name.startsWith("stock_"));
    for (const name of [
      "stock_read_run",
      "stock_read_artifact",
      "stock_read_evidence",
      "stock_check_numbers",
      "stock_check_pending_numbers",
      "stock_get_fundamentals",
      "stock_describe_collection",
      "stock_read_collection",
      "stock_read_valuation_method",
      "stock_calculate_valuation",
      "stock_read_valuation_calculation",
      "stock_resume_research",
      "stock_cancel_research",
      "stock_recover_research",
      "stock_replay_research",
    ])
      expect(declarations.some((tool) => tool.name === name)).toBe(true);

    const requests: { tools: Record<string, unknown>[] }[] = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return response(api);
    });
    vi.stubGlobal("fetch", fetch);
    const chunks = [];
    for await (const chunk of h.ctx.llm.stream({
      provider: "fixture",
      model: "fixture",
      maxTokens: 32,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Inspect tool declarations." }],
        },
      ],
      tools: declarations,
    }))
      chunks.push(chunk);
    expect(chunks.at(-1), JSON.stringify(chunks)).toMatchObject({
      type: "finish",
      reason: { kind: "stop" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const wire = requests[0]!.tools;
    expect(wire).toHaveLength(declarations.length);
    for (const tool of declarations) {
      const entry = wire.find(
        (item) =>
          (api === "openai-completions"
            ? (item.function as { name: string }).name
            : item.name) === tool.name,
      )!;
      const schema = (
        api === "openai-completions"
          ? (entry.function as { parameters: JsonSchemaNode }).parameters
          : api === "anthropic-messages"
            ? entry.input_schema
            : entry.parameters
      ) as JsonSchemaNode;
      expect(schema.type, tool.name).toBe("object");
      expect(schema.properties, tool.name).toEqual(tool.parameters.properties);
      expect(schema.required ?? [], tool.name).toEqual(
        tool.parameters.required ?? [],
      );
    }
  },
);

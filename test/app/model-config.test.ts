import { afterEach, describe, expect, it } from "vitest";
import z from "@deepseek-ai/schemastery";
import {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  ModelConfig,
  resolveModelOptions,
} from "../../src/app/model-config.js";
import { runtimeHost, textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function parse(input: unknown): ModelConfig {
  return z.resolve(input, ModelConfig, {})[0];
}

async function parent() {
  const h = await runtimeHost();
  cleanups.push(h.close);
  const handle = await h.ctx.agents.create({
    sessionId: SessionId("model-parent"),
    agentOptions: {
      provider: "runtime-fixture",
      model: "created",
      reasoningEffort: ReasoningEffortId("high"),
      maxTokens: 1024,
    },
    meta: { cwd: h.directory },
  });
  return { h, agent: handle.agent };
}

describe("research model configuration", () => {
  it.each([
    {},
    { reasoningEffort: "low" },
    { reasoningEffort: null },
    { provider: "fixture", model: "custom" },
    { provider: "fixture", model: "custom", reasoningEffort: "high" },
  ])("accepts inheritance and supported override shapes: %j", (input) => {
    expect(parse(input)).toEqual(input);
  });

  it.each([
    { provider: "fixture" },
    { model: "custom" },
    { provider: " ", model: "custom" },
    { provider: "fixture", model: "" },
    { provider: null, model: null },
    { provider: "fixture", model: null },
    { reasoningEffort: " " },
    { reasoningEffort: 3 },
    { reasoningEffort: false },
    { temperature: 0.2 },
  ])("rejects invalid external model settings: %j", (input) => {
    expect(() => parse(input)).toThrow();
  });

  it.each([
    { config: undefined, effort: "high" },
    { config: {}, effort: "high" },
    { config: { reasoningEffort: ReasoningEffortId("low") }, effort: "low" },
    { config: { reasoningEffort: null }, effort: undefined },
  ])(
    "inherits the creation route with effort $effort before any request",
    async ({ config, effort }) => {
      const { agent } = await parent();
      const options = resolveModelOptions(agent, config);
      expect(options).toEqual({
        provider: "runtime-fixture",
        model: "created",
        maxTokens: 1024,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      });
      expect(agent.options.reasoningEffort).toBe("high");
    },
  );

  it.each(["created", "custom"])(
    "clears inherited effort for the explicitly selected model %s",
    async (model) => {
      const { agent } = await parent();
      const route = { provider: "runtime-fixture", model };
      expect(resolveModelOptions(agent, route)).toEqual({
        ...route,
        maxTokens: 1024,
      });
      expect(
        resolveModelOptions(agent, {
          ...route,
          reasoningEffort: ReasoningEffortId("low"),
        }),
      ).toEqual({ ...route, maxTokens: 1024, reasoningEffort: "low" });
    },
  );

  it("inherits the last effective request route and effort instead of creation options", async () => {
    class SelectedModelAdapter extends LlmAdapter {
      override async resolveModel(
        provider: string,
        id: string,
      ): Promise<LlmResolvedModelInfo> {
        return {
          provider,
          id,
          name: id,
          reasoning: {
            efforts: [{ id: ReasoningEffortId("low"), name: "Low" }],
          },
        };
      }
      stream() {
        return textResponse("Selection recorded.");
      }
    }
    const { h, agent } = await parent();
    h.ctx.llm.registerAdapter(["selected-fixture"], new SelectedModelAdapter());
    agent.ctx.on("agent/request", async (_payload, next) => ({
      ...(await next()),
      provider: "selected-fixture",
      model: "selected",
      reasoningEffort: ReasoningEffortId("low"),
    }));
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: "Use selected model" }],
        source: { kind: "user" },
      }),
    );
    await agent.whenIdle();
    expect(agent.session.requestHeader()?.config).toMatchObject({
      provider: "selected-fixture",
      model: "selected",
      reasoningEffort: "low",
    });
    expect(resolveModelOptions(agent)).toEqual({
      provider: "selected-fixture",
      model: "selected",
      reasoningEffort: "low",
      maxTokens: 1024,
    });
    expect(resolveModelOptions(agent, { reasoningEffort: null })).toEqual({
      provider: "selected-fixture",
      model: "selected",
      maxTokens: 1024,
    });
  });
});

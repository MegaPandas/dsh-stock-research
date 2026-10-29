import { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentSetup } from "@deepseek-ai/dsh-agent";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { bindScopeParent, createScope } from "@deepseek-ai/dsh-scope";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {
  ToolDefinition,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionBindings,
  taskOperation,
  type ResearchBinding,
} from "../../src/host/bindings.js";
import { ResearchSessions } from "../../src/host/sessions.js";

const cleanups: (() => Promise<void>)[] = [];
const binding: ResearchBinding = {
  kind: "task",
  runId: "run-one",
  taskId: "analyst",
  attempt: 3,
};
const agentOptions = { provider: "fixture", model: "session-boundary" };

function tool(
  name: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: "Session boundary integration fixture",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute,
  };
}

class ToolThenStopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    options.signal?.throwIfAborted();
    if (this.requests.length === 1) {
      const id = ToolCallId("first-tool-call");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id,
        name: "stock_session_probe",
        argumentsDelta: "{}",
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id,
          name: "stock_session_probe",
          arguments: "{}",
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "Fixture complete." };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "Fixture complete." },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function host() {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: "native" } });
  const adapter = new ToolThenStopAdapter();
  ctx.llm.registerAdapter([agentOptions.provider], adapter);
  await mountAgentLoopTestHarness(ctx);
  const bindings = new SessionBindings();
  const sessions = new ResearchSessions(ctx, bindings);
  let probeCalls = 0;
  let unsafeCalls = 0;
  const probe = tool("stock_session_probe", async (_args, exec) => {
    probeCalls++;
    return JSON.stringify(taskOperation(bindings.require(exec.agent)));
  });
  const unsafe = tool("shell", async () => {
    unsafeCalls++;
    return "unsafe";
  });
  ctx.tools.register(probe);
  ctx.tools.register(unsafe);
  function create(
    id: string,
    setup: AgentSetup = sessions.setup(binding, [probe]),
  ) {
    return ctx.agents.create({
      sessionId: SessionId(id),
      agentOptions,
      setup,
    });
  }
  function call(agent: Agent, name = probe.name) {
    return ctx.tools.execute({
      agent,
      callId: ToolCallId("direct-call"),
      name,
      arguments: {},
      signal: new AbortController().signal,
    });
  }
  return {
    ctx,
    bindings,
    sessions,
    adapter,
    probe,
    unsafe,
    create,
    call,
    calls: () => ({ probe: probeCalls, unsafe: unsafeCalls }),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("ResearchSessions with the real DSH AgentLoop", () => {
  it("binds before the first queued model call and hides inherited unsafe tools", async () => {
    const h = await host();
    const presetKey = {};
    await h.ctx.plugin({
      name: "session-boundary-preset-fixture",
      inject: ["tools"],
      apply(presetCtx: Context) {
        const preset = createScope(presetCtx, presetKey);
        presetCtx.effect(() => preset.rawDispose);
        preset.ctx.tools.register(tool("read_file", async () => "unsafe file"));
      },
    });
    const results: Readonly<ToolExecutionResult>[] = [];
    h.ctx.on("tools/result", (_exec, result) => {
      results.push(result);
    });
    h.ctx.on("agent/created", ({ agent }) => {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "Read the trusted task identity." }],
          source: { kind: "user" },
        }),
      );
      return undefined;
    });
    const handle = await h.create("first-call", async (agentCtx, agent) => {
      bindScopeParent(agent, presetKey);
      const prepared = await h.sessions.setup(binding, [h.probe])(
        agentCtx,
        agent,
      );
      expect((await h.call(agent)).isError).toBe(true);
      expect(h.calls().probe).toBe(0);
      return prepared;
    });
    await handle.agent.whenIdle();

    const expected = JSON.stringify({
      runId: "run-one",
      taskId: "analyst",
      attempt: 3,
      identity: "first-call",
      sessionId: "first-call",
    });
    expect(h.adapter.requests).toHaveLength(2);
    expect(h.adapter.requests[0]?.sessionId).toBe(handle.agent.id);
    expect(h.adapter.requests[0]?.tools?.map((entry) => entry.name)).toEqual([
      h.probe.name,
    ]);
    expect(results).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: false, value: expected }),
    ]);
    expect(
      h.adapter.requests[1]?.messages.find((message) => message.role === "tool")
        ?.content,
    ).toEqual([{ type: "text", text: expected }]);
    expect(
      h.ctx.tools.schemas(handle.agent).map((entry) => entry.name),
    ).toEqual([h.probe.name]);
    expect((await h.call(handle.agent, "shell")).isError).toBe(true);
    expect((await h.call(handle.agent, "read_file")).isError).toBe(true);
    expect(h.calls()).toEqual({ probe: 1, unsafe: 0 });
  });

  it("hides local preset tools from model requests without granting execution", async () => {
    const h = await host();
    const handle = await h.create(
      "extra-preset-tool",
      async (agentCtx, agent) => {
        const prepared = await h.sessions.setup(binding, [h.probe])(
          agentCtx,
          agent,
        );
        agentCtx.tools.register(h.unsafe);
        return prepared;
      },
    );

    expect(h.ctx.tools.schemas(handle.agent).map(({ name }) => name)).toEqual([
      h.probe.name,
      h.unsafe.name,
    ]);
    expect((await h.call(handle.agent, h.unsafe.name)).isError).toBe(true);
    expect((await h.call(handle.agent)).isError).toBe(false);
    expect(h.calls()).toEqual({ probe: 1, unsafe: 0 });
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: "Read the trusted task identity." }],
        source: { kind: "user" },
      }),
    );
    await handle.agent.whenIdle();
    expect(h.adapter.requests).toHaveLength(2);
    for (const request of h.adapter.requests)
      expect(request.tools?.map(({ name }) => name)).toEqual([h.probe.name]);
    await handle.dispose();
    expect(() => h.bindings.require(handle.agent)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  });

  it("keeps old and replacement Agents isolated when a session id is reused", async () => {
    const h = await host();
    const old = await h.create("reused-id");
    await old.dispose();
    expect(() => h.bindings.require(old.agent)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    const replacementBinding: ResearchBinding = {
      ...binding,
      attempt: 4,
    };
    const replacement = await h.create(
      "reused-id",
      h.sessions.setup(replacementBinding, [h.probe]),
    );
    await old.dispose();

    expect(replacement.agent).not.toBe(old.agent);
    expect(h.bindings.require(replacement.agent).binding).toEqual(
      replacementBinding,
    );
    expect((await h.call(old.agent)).isError).toBe(true);
    expect((await h.call(replacement.agent)).isError).toBe(false);
    expect(h.calls()).toEqual({ probe: 1, unsafe: 0 });
  });

  it("rejects new bindings and existing calls after close without lifting restrictions", async () => {
    const h = await host();
    const handle = await h.create("closing");
    h.sessions.close();
    h.sessions.close();

    expect(() => h.bindings.require(handle.agent)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    expect((await h.call(handle.agent)).isError).toBe(true);
    expect((await h.call(handle.agent, "shell")).isError).toBe(true);
    expect(
      h.ctx.tools.schemas(handle.agent).map((entry) => entry.name),
    ).toEqual([h.probe.name]);
    await expect(async () => h.create("after-close")).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(h.ctx.agents.get(SessionId("after-close"))).toBeUndefined();
    expect(h.calls()).toEqual({ probe: 0, unsafe: 0 });
  });

  it("denies a local tool injected after publication despite an allowing pre-policy", async () => {
    const h = await host();
    const handle = await h.create("late-injection");
    handle.agent.ctx.tools.register(h.unsafe);
    h.ctx.on("tools/pre-execute", async () => ({ kind: "allow" }));

    expect((await h.call(handle.agent, "shell")).isError).toBe(true);
    expect(h.calls()).toEqual({ probe: 0, unsafe: 0 });
  });

  it("rechecks closure at publication after asynchronous setup", async () => {
    const h = await host();
    let unpublished: Agent | undefined;
    await expect(
      h.create("closed-before-commit", async (agentCtx, agent) => {
        unpublished = agent;
        const prepared = await h.sessions.setup(binding, [h.probe])(
          agentCtx,
          agent,
        );
        h.sessions.close();
        return prepared;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    expect(h.ctx.agents.get(SessionId("closed-before-commit"))).toBeUndefined();
    expect(
      h.ctx.sessions.get(SessionId("closed-before-commit")),
    ).toBeUndefined();
    expect(() => h.bindings.require(unpublished)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  });

  it("leaves ordinary host Agents outside the research policy", async () => {
    const h = await host();
    const handle = await h.create("ordinary", () => {});

    expect((await h.call(handle.agent, "shell")).value).toBe("unsafe");
    expect(h.calls()).toEqual({ probe: 0, unsafe: 1 });
  });

  it("rejects a reserved child if the boundary closes before its creation event", async () => {
    const h = await host();
    const id = SessionId("reserved-before-close");
    const release = h.sessions.reserve(
      id,
      h.sessions.setup(binding, [h.probe]),
    );
    h.sessions.close();

    await expect(h.create(id, () => {})).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    release();
    expect(h.ctx.agents.get(id)).toBeUndefined();
    expect(h.ctx.sessions.get(id)).toBeUndefined();
    expect(h.adapter.requests).toHaveLength(0);
  });
});

import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createUserMessage, type LlmFailure } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createSubmission } from "../../src/host/agent-protocol/submission.js";
import { setupResearchTools } from "../../src/host/sessions/tool-policy.js";
import { observeModelCalls } from "../../src/host/model-events.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import { captureModelLogs } from "../fixtures/dispatch-host.js";
import { runtimeHost } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

/** The external model boundary speaks OpenAI SSE; PiAi owns all decoding. */
function toolResponse(
  calls: { name: string; argumentsText: string; id: string }[],
): Response {
  const delta = (value: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    calls
      .map(({ name, argumentsText, id }, index) => {
        const split = Math.floor(argumentsText.length / 2);
        return (
          delta({
            role: "assistant",
            tool_calls: [
              {
                index,
                id,
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          }) +
          delta({
            tool_calls: [
              { index, function: { arguments: argumentsText.slice(0, split) } },
            ],
          }) +
          delta({
            tool_calls: [
              { index, function: { arguments: argumentsText.slice(split) } },
            ],
          })
        );
      })
      .join("") +
      delta({}, "tool_calls") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

it.each(["business fields", "native arguments"] as const)(
  "preserves malformed %s diagnostics through real PiAi without accepting an invalid report",
  async (failureKind) => {
    vi.stubEnv("DSH_ARGUMENTS_TEST_KEY", "fixture-only-key");
    const h = await runtimeHost();
    cleanups.push(h.close);
    await h.ctx.plugin(PiAi, {
      providers: {
        fixture: {
          api: "openai-completions",
          baseURL: "https://model.invalid/v1",
          apiKeyEnv: "DSH_ARGUMENTS_TEST_KEY",
          models: [{ id: "fixture" }],
          retryPolicy: { mode: "normal", maxRetries: 0 },
        },
      },
    });
    const business = agentAnalysisReport();
    const call = (name: string, args: unknown, id: string) => ({
      name,
      argumentsText: JSON.stringify(args),
      id,
    });
    type WireMessage = {
      role: string;
      content?: string;
      tool_call_id?: string;
    };
    const requests: { messages: WireMessage[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          messages: WireMessage[];
        };
        requests.push(body);
        if (requests.length === 1) {
          if (failureKind === "native arguments")
            // DSH 0.2.2 rejects malformed completed arguments at the model boundary.
            return toolResponse([
              {
                name: "stock_submit",
                argumentsText: '{"summary": [}',
                id: "malformed-arguments",
              },
            ]);
          return toolResponse([
            call(
              "stock_submit",
              {
                ...business,
                content: { ...business.content, currentState: [42] },
              },
              "original-report",
            ),
          ]);
        }
        return toolResponse([
          call("stock_submit", business, "corrected-report"),
        ]);
      }),
    );
    const logs = captureModelLogs(h.ctx);
    const operation = {
      runId: "arguments-run",
      taskId: "analysis.market",
      attempt: 7,
      identity: "coordinator",
      sessionId: null,
    };
    const committed = {
      runId: operation.runId,
      taskId: operation.taskId,
      attempt: operation.attempt,
      refs: [],
    };
    const accept = vi.fn(() => committed);
    const submission = createSubmission("analysis", accept);
    const failures: LlmFailure[] = [];
    const handle = await h.ctx.agents.create({
      sessionId: SessionId("arguments-role"),
      agentOptions: { provider: "fixture", model: "fixture" },
      meta: { cwd: h.directory },
      setup: async (ctx, agent) => {
        const verifyTools = await setupResearchTools(ctx, agent, [
          submission.tool,
        ]);
        observeModelCalls(agent, operation, "role");
        ctx.on("session/event", (session, event) => {
          if (
            session === agent.session &&
            event.type === "turn/end" &&
            event.data.reason.kind === "error"
          )
            failures.push(event.data.reason.error);
        });
        return { commit: verifyTools };
      },
    });
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "Submit the analysis report." }],
          source: { kind: "user" },
        }),
      );
      await handle.agent.whenIdle();
      if (failureKind === "native arguments") {
        expect(requests).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.code).toBe("MALFORMED_RESPONSE");
        expect(failures[0]!.message).toContain("stock_submit");
        expect(failures[0]!.message).toContain('{"summary": [}');
        expect(failures[0]!.message).toMatch(/JSON|position|token/);
        expect(accept).not.toHaveBeenCalled();
        expect(() => submission.result()).toThrowError(
          expect.objectContaining({ code: "INVALID_ARTIFACT" }),
        );
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          sessionId: handle.agent.id,
          finish: "error",
        });
        return;
      }
      expect(submission.result()).toEqual(committed);
    } finally {
      await handle.dispose();
    }
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.find(
      (message) => message.tool_call_id === "original-report",
    );
    expect(feedback?.content).toContain("INVALID_INPUT");
    expect(feedback?.content).toContain("currentState");
    expect(feedback?.content).toMatch(/string/);
    expect(feedback?.content).not.toContain(business.summary);
    expect(accept).toHaveBeenCalledExactlyOnceWith(
      business,
      expect.objectContaining({ agent: handle.agent }),
    );
    expect(logs).toHaveLength(2);
    expect(
      logs.every(
        (log) =>
          log.kind === "role" &&
          log.runId === operation.runId &&
          log.taskId === operation.taskId &&
          log.attempt === 7,
      ),
    ).toBe(true);
    expect(logs.map((log) => log.sessionId)).toEqual([
      handle.agent.id,
      handle.agent.id,
    ]);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.ctx.tools.get("stock_submit")).toBeUndefined();
  },
);

import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DigestDraft,
  DigestModelInput,
} from "../../src/contracts/digests.js";
import { HostDigestModel } from "../../src/host/digest-model.js";
import { digestBusinessDraft } from "../../src/services/digest-business.js";
import { assembleDigest } from "../../src/services/digest-draft.js";
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
  "returns malformed %s diagnostics through real PiAi, then publishes one corrected digest",
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
    const input: DigestModelInput = {
      scope: h.scope,
      taskId: "digest",
      instructionVersion: 2,
      instruction: "Use the fixed input references.",
      reports: [],
      artifacts: [],
      references: [],
      numbers: [],
      risks: [],
      gaps: [],
    };
    const draft: DigestDraft = {
      title: "Preserved draft",
      body: "The original qualitative summary survives.",
      inputRefs: [],
      facts: [],
      disagreements: [],
      riskSummaries: [],
    };
    const business = {
      summary: draft.body,
      content: {
        keyPoints: [],
        disagreements: [],
        riskSummaries: [],
        openQuestions: [],
      },
    };
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
            // A complete malformed call exercises PiAi's normalization to {}.
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
                content: { ...business.content, keyPoints: [42] },
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
      taskId: "digest",
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
    const published: unknown[] = [];
    const submit = vi.fn((value: unknown) => {
      published.push(assembleDigest(value, input));
      return committed;
    });
    const host = new HostDigestModel(h.ctx, {
      provider: "fixture",
      model: "fixture",
    });
    expect(
      await host.generate(
        input,
        new AbortController().signal,
        operation,
        submit,
      ),
    ).toEqual(committed);
    expect(requests).toHaveLength(2);
    const feedback = requests[1]!.messages.find(
      (message) =>
        message.tool_call_id ===
        (failureKind === "business fields"
          ? "original-report"
          : "malformed-arguments"),
    );
    expect(feedback?.content).toContain("INVALID_INPUT");
    if (failureKind === "business fields") {
      expect(feedback?.content).toContain("keyPoints");
      expect(feedback?.content).toMatch(/string/);
      expect(feedback?.content).not.toContain(draft.body);
    } else {
      expect(feedback?.content).toContain('{"summary": [}');
      expect(feedback?.content).toMatch(/JSON|position|token/);
    }
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      digestBusinessDraft(business, input),
    );
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ payload: { report: business } });
    expect(logs).toHaveLength(2);
    expect(
      logs.every(
        (log) =>
          log.runId === operation.runId &&
          log.taskId === operation.taskId &&
          log.attempt === 7,
      ),
    ).toBe(true);
    expect(new Set(logs.map((log) => log.sessionId)).size).toBe(1);
  },
);

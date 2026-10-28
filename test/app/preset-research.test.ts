import { createUserMessage } from "@deepseek-ai/dsh-llm";
import SubagentModelSelectionConfig from "@deepseek-ai/dsh-tool-subagent/model-selection-settings";
import { afterEach, expect, it, vi } from "vitest";
import {
  quickHost,
  initialInput,
  lastToolText,
  toolCall,
} from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
  type RoleInput,
} from "../fixtures/research-workflow.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("accepts standard-preset tools in the child catalog while enforcing research capabilities at execution", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              sz002594: {
                day: [["2024-01-03", "190", "192", "193", "189", "100"]],
              },
            },
          }),
        ),
    ),
  );
  const model = workflowModel();
  let attemptedDelegation = false;
  let denial: string | undefined;
  const h = await quickHost(
    async function* (request) {
      if (!isMainResearchRequest(request)) {
        const input = initialInput<RoleInput>(request);
        if (input.task.id === "analysis.market") {
          if (!attemptedDelegation) {
            attemptedDelegation = true;
            yield* toolCall("subagent", {
              description: "Unapproved recursive delegation",
              prompt: "Perform another research task.",
            });
            return;
          }
          denial ??= lastToolText(request);
        }
      }
      yield* model.respond(request);
    },
    async (host) => {
      await host.ctx.plugin(SubagentModelSelectionConfig, {});
      await host.ctx.agentPresets.register({
        id: "standard-delegation",
        plugins: [
          {
            id: "subagent",
            name: "@deepseek-ai/dsh-tool-subagent",
            config: {
              provider: "spawn",
              toolName: "subagent",
              modelSelectionSettings: true,
            },
          },
        ],
      });
      await host.ctx.agentPresets.select(
        host.outside.agent,
        "standard-delegation",
      );
    },
  );
  cleanup = h.close;
  expect(h.ctx.tools.get("subagent", h.outside.agent)).toBeDefined();
  h.outside.agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "请对SZ.002594做一次快速个股调研。" }],
      source: { kind: "user" },
    }),
  );
  await h.outside.agent.whenIdle();
  const view = h.runtime.runs.view({ runId: model.state.runId! });
  expect(
    view.tasks.flatMap((task) => (task.failure === null ? [] : [task.failure])),
  ).toEqual([]);
  expect(view.status).toBe("completed");
  expect(attemptedDelegation).toBe(true);
  expect(denial).toContain("outside this research Agent's capabilities");
  expect(h.created).toHaveLength(8);
  const researchRequests = h.adapter.requests.filter(
    (request) => request.sessionId !== h.outside.agent.id,
  );
  expect(
    researchRequests.some((request) =>
      request.tools?.some(({ name }) => name === "subagent"),
    ),
  ).toBe(true);
  expect(h.ctx.tools.get("subagent", h.outside.agent)).toBeDefined();
  for (const request of researchRequests)
    expect(request.tools?.map(({ name }) => name)).not.toContain("host_marker");
});

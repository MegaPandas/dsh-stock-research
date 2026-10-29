import type {} from "@deepseek-ai/dsh-session-projection";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quickHost, initialInput } from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
  type RoleInput,
} from "../fixtures/research-workflow.js";
import { deferred, textResponse } from "../fixtures/runtime-host.js";
import { isApplicationBusy } from "../../src/app/activity.js";
import { expectRoleTools } from "../fixtures/role-tools.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
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
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("research from an ordinary DSH chat", () => {
  it("uses the receiving main Agent for natural-language planning, review and final delivery", async () => {
    const model = workflowModel();
    const h = await quickHost(async function* (request) {
      if (request.sessionId === "other-chat") yield* textResponse("普通聊天。");
      else yield* model.respond(request);
    });
    cleanups.push(h.close);
    const entryTools = [
      "stock_start_research",
      "stock_resume_research",
      "stock_cancel_research",
      "stock_recover_research",
      "stock_replay_research",
    ].sort();
    const coordinatorTools = [
      ...entryTools,
      "stock_read_run",
      "stock_read_artifact",
      "stock_dispatch_task",
      "stock_dispatch_stage",
      "stock_followup_task",
      "stock_make_digest",
      "stock_decide",
      "stock_redo_task",
      "stock_review_stage",
    ].sort();
    const other = await h.ctx.agents.create(h.agentOptions("other-chat"));
    const turns: string[] = [];
    h.ctx.on("session/event", (session, event) => {
      if (session === h.outside.agent.session) turns.push(event.type);
    });
    const parents: unknown[] = [];
    h.ctx.on("subagent/start", (info) => {
      parents.push(h.ctx.agents.get(info.id)!.session.header.parentSession);
    });
    const mainOptions = { ...h.outside.agent.options };
    h.outside.agent.followup(
      createUserMessage({
        content: [
          { type: "text", text: "请对SZ.002594 比亚迪做一次快速的个股调研。" },
        ],
        source: { kind: "user" },
      }),
    );
    await h.outside.agent.whenIdle();
    expect(model.state.runId).toBeDefined();
    const view = h.runtime.runs.view({ runId: model.state.runId! });
    expect(view.status).toBe("completed");
    expect(view.scope.date).toBe("2024-01-03");
    expect(view.stageReviews).toHaveLength(4);
    expect(view.stages?.every((stage) => stage.accepted)).toBe(true);
    expect(parents).toHaveLength(8);
    expect(parents.every((parent) => parent === h.outside.agent.id)).toBe(true);
    expect(h.created.filter((agent) => agent !== other.agent)).toHaveLength(8);
    expect(h.outside.agent.options).toEqual(mainOptions);
    const mainRequests = h.adapter.requests.filter(
      ({ sessionId }) => sessionId === h.outside.agent.id,
    );
    for (const request of h.adapter.requests.filter(
      (request) => !isMainResearchRequest(request),
    ))
      expectRoleTools(request);
    const stockTools = (request: (typeof mainRequests)[number]) =>
      request
        .tools!.map(({ name }) => name)
        .filter((name) => name.startsWith("stock_"))
        .sort();
    expect(stockTools(mainRequests[0]!)).toEqual(entryTools);
    for (const request of mainRequests.slice(1))
      expect(stockTools(request)).toEqual(coordinatorTools);
    other.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: "普通聊天。" }],
        source: { kind: "user" },
      }),
    );
    await other.agent.whenIdle();
    const otherRequest = h.adapter.requests.find(
      ({ sessionId }) => sessionId === other.agent.id,
    )!;
    expect(stockTools(otherRequest)).toEqual(entryTools);
    expect(otherRequest.tools?.map(({ name }) => name)).toContain(
      "host_marker",
    );
    await other.dispose();
    expect(
      h.ctx.tools.schemas(h.outside.agent).map(({ name }) => name),
    ).toContain("host_marker");
    expect(turns).toContain("turn/start");
    expect(turns.at(-1)).toBe("turn/end");
    expect(
      h.ctx.sessionProjections.stateOf(h.outside.agent.session, "turnBoundary")
        ?.lastTurn,
    ).toBeGreaterThan(0);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it.each([
    ["analysis", "analysis.market"],
    ["debate.1", "debate.1.bull"],
  ])(
    "delivers rejected %s feedback to the revised subagent",
    async (stageId, taskId) => {
      const model = workflowModel({ rejectStage: stageId });
      const feedback: unknown[] = [];
      const h = await quickHost(async function* (request) {
        if (!isMainResearchRequest(request)) {
          const input = initialInput<
            RoleInput & { context: { revisionFeedback?: unknown } }
          >(request);
          if (
            input.task.id === taskId &&
            input.context.revisionFeedback !== undefined
          )
            feedback.push(input.context.revisionFeedback);
        }
        yield* model.respond(request);
      });
      cleanups.push(h.close);
      h.outside.agent.followup(
        createUserMessage({
          content: [
            {
              type: "text",
              text: "请对SZ.002594做快速调研，研究日期2024-01-03。",
            },
          ],
          source: { kind: "user" },
        }),
      );
      await h.outside.agent.whenIdle();
      const view = h.runtime.runs.view({ runId: model.state.runId! });
      expect(view.status).toBe("completed");
      const reviews = view.stageReviews!.filter(
        (review) => review.stageId === stageId,
      );
      expect(reviews.map(({ verdict }) => verdict)).toEqual([
        "rejected",
        "accepted",
      ]);
      expect(reviews[1]!.refs).not.toEqual(reviews[0]!.refs);
      expect(
        reviews.every(({ identity }) => identity === h.outside.agent.id),
      ).toBe(true);
      expect(view.tasks.find((task) => task.taskId === taskId)!.attempt).toBe(
        2,
      );
      expect(feedback).toEqual([
        {
          stageId,
          feedback: "需要补充分析依据。",
          previousRefs: reviews[0]!.refs,
        },
      ]);
    },
  );

  it("keeps research resources until the main Agent delivers its final response", async () => {
    const model = workflowModel();
    const finalResponse = deferred<void>();
    const release = deferred<void>();
    const h = await quickHost(async function* (request) {
      for await (const chunk of model.respond(request)) {
        if (
          isMainResearchRequest(request) &&
          chunk.type === "text-delta" &&
          chunk.text.includes("已完成")
        ) {
          finalResponse.resolve();
          await release.promise;
        }
        yield chunk;
      }
    });
    cleanups.push(h.close);
    try {
      h.outside.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "请对SZ.002594做快速调研。" }],
          source: { kind: "user" },
        }),
      );
      await finalResponse.promise;
      expect(h.runtime.runs.view({ runId: model.state.runId! }).status).toBe(
        "completed",
      );
      expect(isApplicationBusy(h.runtime)).toBe(true);
    } finally {
      release.resolve();
    }
    await h.outside.agent.whenIdle();
    expect(isApplicationBusy(h.runtime)).toBe(false);
  });
});

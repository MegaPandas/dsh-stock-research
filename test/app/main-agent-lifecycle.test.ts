import { ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { isApplicationBusy } from "../../src/app/activity.js";
import { quickHost, toolCall } from "../fixtures/quick-host.js";
import { workflowModel } from "../fixtures/research-workflow.js";
import { textResponse } from "../fixtures/runtime-host.js";

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
    vi.restoreAllMocks();
  }
});

function causes(error: unknown): unknown[] {
  if (!(error instanceof Error)) return [error];
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ...(error.cause === undefined ? [] : causes(error.cause)),
  ];
}

describe("main Agent research lifecycle", () => {
  it("replays an existing finalization receipt after completion without new work", async () => {
    const model = workflowModel();
    const h = await quickHost(model.respond);
    cleanups.push(h.close);
    let finalized:
      { runId: string; taskId: string; requestId: string } | undefined;
    h.ctx.on("session/event", (session, event) => {
      if (
        session === h.outside.agent.session &&
        event.type === "tool/call" &&
        event.data.name === "stock_decide"
      )
        finalized = JSON.parse(event.data.arguments);
    });
    expect((await h.executeAndWait())?.result.kind).toBe("success");
    expect(finalized).toBeDefined();
    const before = h.runtime.runs.view({ runId: model.state.runId! });
    expect(before.status).toBe("completed");
    const refs = before.tasks.find(
      ({ taskId }) => taskId === "finalize",
    )!.outputRefs;
    const requests = h.adapter.requests.length;
    const jobs = h.ctx.jobs.list(h.outside.agent.id);
    const replay = await h.ctx.tools.execute({
      agent: h.outside.agent,
      callId: ToolCallId("replay-finalization"),
      name: "stock_decide",
      arguments: finalized!,
      signal: new AbortController().signal,
    });
    expect(replay).toMatchObject({
      isError: false,
      value: { runId: before.runId, taskId: "finalize", attempt: 1, refs },
    });
    expect(h.runtime.runs.view({ runId: before.runId })).toEqual(before);
    expect(h.adapter.requests).toHaveLength(requests);
    expect(h.ctx.jobs.list(h.outside.agent.id)).toEqual(jobs);

    const fresh = await h.ctx.tools.execute({
      agent: h.outside.agent,
      callId: ToolCallId("new-finalization"),
      name: "stock_decide",
      arguments: { ...finalized!, requestId: "different-finalization" },
      signal: new AbortController().signal,
    });
    expect(fresh).toMatchObject({
      isError: true,
      error: { info: { code: "TASK_NOT_READY" } },
    });
    expect(h.runtime.runs.view({ runId: before.runId })).toEqual(before);
    expect(h.adapter.requests).toHaveLength(requests);
    expect(h.ctx.jobs.list(h.outside.agent.id)).toEqual(jobs);
  });

  it("withdraws the main Agent's scoped tools and binding even when cancellation fails", async () => {
    let calls = 0;
    const h = await quickHost(async function* (): AsyncIterable<StreamChunk> {
      if (++calls === 1)
        yield* toolCall("stock_start_research", {
          security: "SZ.002594",
          date: "2024-01-03",
          mode: "quick",
          requestId: "prepare-only",
        });
      else yield* textResponse("研究数据已准备，等待下一步安排。");
    });
    cleanups.push(h.close);
    expect((await h.executeAndWait())?.result.kind).toBe("error");
    const dispatch = h.runtime.tools.find(
      ({ name }) => name === "stock_dispatch_task",
    )!;
    const read = h.runtime.tools.find(({ name }) => name === "stock_read_run")!;
    expect(h.ctx.tools.get(dispatch.name, h.outside.agent)).not.toBe(dispatch);
    expect(h.ctx.tools.get(read.name, h.outside.agent)).not.toBe(read);
    expect(isApplicationBusy(h.runtime)).toBe(true);
    const failure = new Error("Cancellation producer release failed");
    const logged: unknown[] = [];
    h.ctx.logger.exporter({
      export: (message) => {
        if (message.type === "error") logged.push(...message.args);
      },
    });
    vi.spyOn(h.runtime.dispatch, "cancel").mockRejectedValueOnce(failure);
    await h.quickFiber.dispose();
    expect(logged.flatMap(causes)).toContain(failure);
    expect(h.ctx.tools.get(dispatch.name, h.outside.agent)).toBe(dispatch);
    expect(h.ctx.tools.get(read.name, h.outside.agent)).toBe(read);
    expect(isApplicationBusy(h.runtime)).toBe(false);
    const scope = {
      security: {
        id: "CN:002594.SZ",
        market: "CN" as const,
        symbol: "002594.SZ",
        exchange: "SZ",
        currency: "CNY",
        timeZone: "Asia/Shanghai",
      },
      date: "2024-01-03",
      cutoff: "2024-01-03T08:00:00.000Z",
    };
    const input = createQuickInput(
      scope,
      h.runtime.policy,
      h.runtime.queries.health(scope).sources,
    );
    expect(() =>
      h.runtime.openRun(h.outside.agent, input, "after-unload"),
    ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(
      await h.ctx.tools.execute({
        agent: h.outside.agent,
        callId: ToolCallId("host-marker-after-unload"),
        name: "host_marker",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ isError: false, value: "host remains available" });
  });
});

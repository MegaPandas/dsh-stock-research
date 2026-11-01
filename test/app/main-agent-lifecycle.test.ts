import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/plan/quick.js";
import { isApplicationBusy } from "../../src/app/activity.js";
import { quickHost } from "../fixtures/quick-host.js";
import { workflowModel } from "../fixtures/research-workflow.js";
import { deferred, gate } from "../fixtures/runtime-host.js";

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
  it("finalizes once in the background without exposing mechanical tools to the main Agent", async () => {
    const model = workflowModel();
    const h = await quickHost(model.respond);
    cleanups.push(h.close);
    const calls: string[] = [];
    h.ctx.on("session/event", (session, event) => {
      if (session === h.outside.agent.session && event.type === "tool/call")
        calls.push(event.data.name);
    });
    expect((await h.executeAndWait())?.result.kind).toBe("success");
    const before = h.runtime.runs.view({ runId: model.state.runId! });
    expect(before.status).toBe("completed");
    const finalization = before.tasks.find(
      ({ taskId }) => taskId === "finalize",
    )!;
    expect(finalization.attempt).toBe(1);
    expect(finalization.outputRefs.length).toBeGreaterThan(0);
    const mechanicalTools = [
      "stock_dispatch_task",
      "stock_dispatch_stage",
      "stock_make_digest",
      "stock_decide",
    ];
    for (const name of mechanicalTools) {
      expect(calls).not.toContain(name);
      expect(h.ctx.tools.get(name, h.outside.agent)).toBeUndefined();
    }
    const requests = h.adapter.requests.length;
    const jobs = h.ctx.jobs.list(h.outside.agent.id);
    const files = h.runFiles();
    expect(
      jobs.some(
        ({ kind, status }) =>
          kind === "stock-research" && status === "completed",
      ),
    ).toBe(true);
    expect(calls).toContain("stock_read_run");
    expect(calls).toContain("stock_read_artifact");
    expect(isApplicationBusy(h.runtime)).toBe(false);
    await h.outside.agent.whenIdle();
    expect(h.runtime.runs.view({ runId: before.runId })).toEqual(before);
    expect(h.runFiles()).toEqual(files);
    expect(h.adapter.requests).toHaveLength(requests);
    expect(h.ctx.jobs.list(h.outside.agent.id)).toEqual(jobs);
  });

  it("withdraws the main Agent's scoped tools and binding even when cancellation fails", async () => {
    const pause = gate<import("@deepseek-ai/dsh-llm").GenerateOptions>();
    const model = workflowModel({ pauseFundamentals: pause });
    const h = await quickHost(model.respond);
    cleanups.push(h.close);
    cleanups.push(async () => pause.released.resolve());
    expect((await h.execute())?.result.kind).toBe("success");
    await pause.started.promise;
    const read = h.runtime
      .createTools(h.runtime.policy)
      .find(({ name }) => name === "stock_read_run")!;
    expect(h.ctx.tools.get(read.name, h.outside.agent)).toBeDefined();
    expect(h.ctx.tools.get(read.name, h.outside.agent)).not.toBe(read);
    expect(isApplicationBusy(h.runtime)).toBe(true);
    const failure = new Error("Cancellation producer release failed");
    const logged: unknown[] = [];
    h.ctx.logger.exporter({
      export: (message) => {
        if (message.type === "error") logged.push(...message.args);
      },
    });
    const cancellation = deferred<void>();
    vi.spyOn(h.runtime.dispatch, "cancel").mockImplementationOnce(async () => {
      cancellation.resolve();
      throw failure;
    });
    const disposing = h.quickFiber.dispose();
    await cancellation.promise;
    pause.released.resolve();
    await disposing;
    expect(logged.flatMap(causes)).toContain(failure);
    expect(h.ctx.tools.get(read.name, h.outside.agent)).toBeUndefined();
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

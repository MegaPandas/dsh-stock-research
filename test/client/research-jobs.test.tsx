// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IJobs,
  JobsSnapshot,
  ObservedJob,
} from "@deepseek-ai/dsh-api-job-controller/client";
import type { ChatNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import type {
  ConversationNodeContext,
  ConversationMatch,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { JobId } from "@deepseek-ai/dsh-jobs/brand";
import type { JobRegisteredData, JobSettledData } from "@deepseek-ai/dsh-jobs";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";
import {
  SessionId,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session/types";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import {
  ResearchJobCard,
  researchJobDefinition,
  type ResearchCardData,
} from "../../src/client/research-jobs.js";
import type {
  ResearchProgress,
  ResearchState,
} from "../../src/contracts/research-progress.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sessionId = SessionId("research-session");
const jobId = JobId("stock-research-fixture");
const registration: JobRegisteredData = {
  jobId,
  owner: sessionId,
  kind: "stock-research",
  label: "SZ.002594 · Quick · 2026-10-28",
  startedAt: 1000,
};
const settlement: JobSettledData = {
  ...registration,
  finishedAt: 12000,
  status: "completed",
  cause: "producer",
  producerReported: true,
};

function browserModule<T>(name: string): T {
  const require = createRequire(import.meta.url);
  let factory!: (require: (name: string) => unknown) => T;
  vm.runInNewContext(readFileSync(require.resolve(`${name}/client`), "utf8"), {
    window: {
      __ModuleLoader__: {
        load: (entry: { factory: typeof factory }) => {
          factory = entry.factory;
        },
      },
    },
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  return factory((id) => {
    // These presentation modules are never rendered by the assembly regression.
    if (id === "@deepseek-ai/dsh-client-ui-primitives")
      return new Proxy({}, { get: () => () => null });
    if (id === "@tanstack/react-virtual") return {};
    return require(id);
  });
}

function registered(seq = 0): SessionEvent<"job/registered"> {
  return {
    type: "job/registered",
    seq: SessionSeq(seq),
    time: 1000,
    data: registration,
  };
}
function settled(
  seq = 1,
  overrides: Partial<JobSettledData> = {},
): SessionEvent<"job/settled"> {
  return {
    type: "job/settled",
    seq: SessionSeq(seq),
    time: 12000,
    data: { ...settlement, ...overrides },
  };
}
function progress(
  overrides: Partial<ResearchState> = {},
  text = "分析阶段，等待下一步安排",
): ResearchProgress {
  return {
    state: {
      status: "active",
      phase: {
        kind: "tasks",
        completed: 0,
        total: 12,
        currentTaskIds: ["analysis.market"],
      },
      identity: { symbol: "002594.SZ", date: "2026-10-28", mode: "quick" },
      runId: "run-fixture",
      operationIds: [],
      ...overrides,
    },
    text,
  };
}
function observation(value: ResearchProgress): ObservedJob {
  return {
    jobId,
    text: JSON.stringify({ type: "research/progress", progress: value }) + "\n",
    gapBefore: false,
    streaming: true,
  };
}
function project(
  events: readonly SessionEvent[],
): ChatNode<"stock-research-job"> {
  let state: ResearchCardData | undefined;
  const matches: ConversationMatch[] = [];
  const context = (): ConversationNodeContext<ResearchCardData> => ({
    key: `stock-research-job:${jobId}`,
    id: jobId,
    kind: "stock-research-job",
    matches,
    start: matches[0] as ConversationMatch & { role: "start" },
    state,
    current: new Map(),
  });
  for (const event of events) {
    if (typeof researchJobDefinition.match !== "function")
      throw new Error("Expected event matcher");
    const matched = researchJobDefinition.match(event);
    if (matched === null) continue;
    const match: ConversationMatch = {
      ...matched,
      event,
      location: { kind: "session" },
    };
    matches.push(match);
    state =
      state === undefined
        ? researchJobDefinition.start(
            context(),
            match as ConversationMatch & { role: "start" },
            { previous: () => undefined },
          )
        : researchJobDefinition.update({ ...context(), state }, match);
  }
  return researchJobDefinition.buildViewNode!(
    context(),
  ) as ChatNode<"stock-research-job">;
}

function jobsFixture(
  rows: readonly JobView[] = [],
  observed: JobsSnapshot["observed"] = {},
) {
  let snapshot: JobsSnapshot = { rows: { [sessionId]: rows }, observed };
  const listeners = new Set<() => void>();
  const unwatch = vi.fn();
  const unobserve = vi.fn<(id: JobId) => void>();
  const jobs: IJobs = {
    state: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    watchRows: vi.fn(() => unwatch),
    observe: vi.fn((_owner, id) => () => unobserve(id)),
    kill: vi.fn<IJobs["kill"]>(async () => ({
      ok: true,
      value: { outcome: "requested" },
    })),
  };
  return {
    jobs,
    unwatch,
    unobserve,
    listeners,
    update(value: JobsSnapshot) {
      snapshot = value;
      for (const listener of listeners) listener();
    },
  };
}
function row(overrides: Partial<JobView> = {}): JobView {
  return {
    id: jobId,
    kind: "stock-research",
    label: registration.label,
    owner: sessionId,
    status: "running",
    progress: "采集数据 9/53 · 东方财富",
    startedAt: 1000,
    output: { total: 0, earliest: 0 },
    ...overrides,
  };
}

describe("research task chat node", () => {
  it("watches a native task from history and observes it when its live row arrives", () => {
    const h = jobsFixture();
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(h.jobs.watchRows).toHaveBeenCalledWith(sessionId);
    expect(h.jobs.observe).not.toHaveBeenCalled();
    act(() =>
      h.update({
        rows: { [sessionId]: [row({ progress: "Reworded native progress" })] },
        observed: {
          [jobId]: observation(
            progress(
              {
                phase: { kind: "review", stageId: "analysis", feedback: null },
              },
              "Unrelated copy",
            ),
          ),
        },
      }),
    );
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, jobId);
    expect(screen.getByRole("status").textContent).toBe("等待验收");
    expect(screen.getByText("等待主 Agent 验收：分析报告")).toBeTruthy();
  });

  it("activates native Chat in a blank conversation from the registration event alone", async () => {
    const native = browserModule<
      typeof import("@deepseek-ai/dsh-client-ui-conversation/client")
    >("@deepseek-ai/dsh-client-ui-conversation");
    const chat = browserModule<
      typeof import("@deepseek-ai/dsh-client-ui-chat/client")
    >("@deepseek-ai/dsh-client-ui-chat");
    const ctx = new Context();
    try {
      const ui = new native.UiConversation(
        ctx,
        {} as ConstructorParameters<typeof native.UiConversation>[1],
      );
      for (const name of [
        "sessions",
        "uiWorkspace",
        "remote",
        "remote.session",
        "sidebarRight",
      ])
        ctx.provide(name, {});
      ctx.provide("slots", {
        inject: () => () => {},
        registerFactory: () => () => {},
      });
      ctx.provide("uiSession", { provide: () => () => {} });
      ctx.provide("locale", {
        register: () => () => {},
        bind: () => (key: string) => key,
      });
      ctx.provide("configForms", {
        get: () => ({
          getSnapshot: () => ({ value: {} }),
          subscribe: () => () => {},
        }),
      });
      await ctx.plugin(chat);
      ui.events.register(researchJobDefinition);
      const assembler = new native.ConversationNodeAssembler(
        ui.events,
        ui.views,
        ui.groups,
      );
      assembler.activateTarget("chat");
      assembler.replaceWindow([], false);
      assembler.flush();
      expect(assembler.activityTargets().has("chat")).toBe(false);
      assembler.append({ type: "event", event: registered() });
      assembler.flush();
      const snapshot = assembler.get("chat")!;
      expect(snapshot.order).toHaveLength(1);
      expect(snapshot.nodes.get(snapshot.order[0]!)?.kind).toBe(
        "stock-research-job",
      );
      expect(assembler.activityTargets().has("chat")).toBe(true);
      assembler.append({
        type: "event",
        event: {
          ...registered(2),
          data: {
            ...registration,
            jobId: JobId("stock-research-step-fixture"),
            kind: "stock-research-step",
          },
        },
      });
      assembler.flush();
      expect(assembler.get("chat")!.order).toHaveLength(1);
      expect(
        assembler.get("chat")!.nodes.get(snapshot.order[0]!)?.data,
      ).toMatchObject({ registration });
      assembler.append({
        type: "event",
        event: {
          type: "job/settled",
          seq: SessionSeq(4),
          time: 12000,
          data: settlement,
        },
      });
      assembler.flush();
      const completed = assembler.get("chat")!;
      expect(completed.order).toHaveLength(1);
      expect(completed.nodes.get(completed.order[0]!)).toMatchObject({
        anchorSeq: 0,
        data: { registration, settlement },
      });
      assembler.replaceWindow([{ type: "event", event: settled(8) }], true);
      assembler.flush();
      const restored = assembler.get("chat")!;
      expect(restored.order).toHaveLength(1);
      expect(restored.nodes.get(restored.order[0]!)).toMatchObject({
        anchorSeq: 8,
        data: { settlement },
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("publishes a visible non-command chat node and ignores unrelated and step registrations", () => {
    const node = project([registered()]);
    expect(node).toMatchObject({
      kind: "stock-research-job",
      target: "chat",
      visibility: "visible",
      location: { kind: "session" },
      anchorSeq: 0,
    });
    expect(node.data.registration?.label).toBe(registration.label);
    for (const kind of ["bash", "stock-research-step"])
      expect(
        typeof researchJobDefinition.match === "function" &&
          researchJobDefinition.match({
            ...registered(),
            data: { ...registration, kind },
          }),
      ).toBeNull();
  });

  it("keeps one identity and anchor while adding native terminal state", () => {
    const node = project([registered(), settled(2)]);
    expect(node.id).toBe(jobId);
    expect(node.anchorSeq).toBe(0);
    expect(node.data).toMatchObject({ registration, settlement });
  });

  it("restores a terminal history window without requiring a process-local Job row", () => {
    const node = project([settled(8)]);
    expect(node.anchorSeq).toBe(8);
    const h = jobsFixture();
    render(
      <ResearchJobCard data={node.data} sessionId={sessionId} jobs={h.jobs} />,
    );
    expect(screen.getByRole("heading").textContent).toBe(registration.label);
    expect(screen.getByRole("status").textContent).toBe("已完成");
    expect(h.jobs.watchRows).toHaveBeenCalledWith(sessionId);
    expect(h.jobs.observe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
  });
});

describe("research task card", () => {
  it("acknowledges cancellation immediately and lets native settlement supersede its pending receipt", async () => {
    let finishCancellation!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const h = jobsFixture([row()], { [jobId]: observation(progress()) });
    vi.mocked(h.jobs.kill).mockImplementationOnce(async () => {
      await pending;
      return { ok: true, value: { outcome: "requested" } };
    });
    const mounted = render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    expect(h.jobs.kill).toHaveBeenCalledWith(sessionId, jobId);
    expect(screen.getByRole("status").textContent).toBe("正在取消");
    expect(
      (screen.getByRole("button", { name: "正在取消…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    mounted.rerender(
      <ResearchJobCard
        data={project([registered(), settled()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("已完成");
    expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();
    await act(async () => finishCancellation());
    expect(screen.getByRole("status").textContent).toBe("已完成");
  });

  it("uses structured collection counts and identity despite conflicting labels and copy", () => {
    const technical = "新文案 · eastmoney · benchmark.dxy.weekly";
    const value = progress(
      {
        status: "preparing",
        phase: {
          kind: "collection",
          counts: {
            completed: 38,
            total: 53,
            succeeded: 37,
            failed: 1,
            cacheHits: 2,
            cacheMisses: 36,
            current: { provider: "eastmoney", id: "benchmark.dxy.weekly" },
          },
        },
      },
      technical,
    );
    const h = jobsFixture(
      [
        row({
          label: "Renamed Job title",
          progress: "等待主 Agent 验收：fake · 采集数据 1/2",
        }),
      ],
      { [jobId]: observation(value) },
    );
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "002594.SZ",
    );
    expect(screen.getByText("快速研究")).toBeTruthy();
    expect(screen.getByText("2026-10-28")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("准备数据");
    expect(screen.getByText("37 项已就绪")).toBeTruthy();
    expect(screen.getByText("1 项缺失")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "数据采集进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("38");
    expect(bar.getAttribute("aria-valuemax")).toBe("53");
    const details = screen.getByText("查看详情").closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(
      screen
        .getAllByText(technical)
        .every((element) => element.closest("details") === details),
    ).toBe(true);
  });

  it("does not infer counts, review state or identity from native prose without a structured record", () => {
    const prose = "等待主 Agent 验收：analysis · 采集数据 9/53";
    const h = jobsFixture([row({ progress: prose })]);
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe(registration.label);
    expect(screen.getByRole("status").textContent).toBe("进行中");
    expect(screen.getByText(prose)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("快速研究")).toBeNull();
  });

  it("derives review state from phase fields and does not invent analysis percentages", () => {
    const technical = "采集数据 99/100 · a renamed progress line";
    const value = progress(
      { phase: { kind: "review", stageId: "digest.analysis", feedback: null } },
      technical,
    );
    const h = jobsFixture([row()], { [jobId]: observation(value) });
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("等待验收");
    expect(screen.getByText("等待主 Agent 验收：分析摘要")).toBeTruthy();
    expect(
      screen.getAllByText(technical).every((element) => {
        const details = element.closest("details");
        return details !== null && !details.hasAttribute("open");
      }),
    ).toBe(true);
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() =>
      h.update({
        rows: { [sessionId]: [row()] },
        observed: {
          [jobId]: observation(
            progress(
              {
                phase: {
                  kind: "review",
                  stageId: "digest.analysis",
                  feedback: null,
                },
              },
              "等待主 Agent 验收：分析摘要",
            ),
          ),
        },
      }),
    );
    expect(screen.getByRole("status").textContent).toBe("等待验收");
    expect(screen.getByText("当前进展").closest("details")).toBeTruthy();
    act(() =>
      h.update({
        rows: { [sessionId]: [row()] },
        observed: {
          [jobId]: observation(progress({}, "正在核对最新财务报告")),
        },
      }),
    );
    expect(screen.getByRole("status").textContent).toBe("进行中");
    expect(
      screen
        .getAllByText("正在核对最新财务报告")
        .some((element) => !element.closest("details")),
    ).toBe(true);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("cancels the owning native Job while preparation has no run", async () => {
    const { runId: _runId, ...state } = progress().state;
    void _runId;
    const preparing = {
      state: {
        ...state,
        status: "preparing" as const,
        phase: { kind: "preparing" as const },
      },
      text: "准备固定数据",
    };
    const h = jobsFixture([row()], { [jobId]: observation(preparing) });
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(
      screen
        .getAllByText("准备固定数据")
        .some((element) => !element.closest("details")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() =>
      expect(h.jobs.kill).toHaveBeenCalledWith(sessionId, jobId),
    );
    act(() =>
      h.update({
        rows: { [sessionId]: [row({ status: "stopping" })] },
        observed: { [jobId]: observation(preparing) },
      }),
    );
    expect(
      (screen.getByRole("button", { name: "正在取消…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it.each(["row", "event"] as const)(
    "lets native terminal %s override a residual active progress record",
    (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(20000);
      const h = jobsFixture(
        [
          source === "row"
            ? row({ status: "completed", finishedAt: 12000 })
            : row(),
        ],
        {
          [jobId]: observation(
            progress({
              phase: { kind: "review", stageId: "analysis", feedback: null },
            }),
          ),
        },
      );
      render(
        <ResearchJobCard
          data={
            project(
              source === "row" ? [registered()] : [registered(), settled()],
            ).data
          }
          sessionId={sessionId}
          jobs={h.jobs}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe("已完成");
      expect(screen.getByText("用时 11 秒")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, jobId);
    },
  );

  it.each([
    { canonical: "completed", native: "completed", label: "已完成" },
    { canonical: "completed", native: "failed", label: "执行失败" },
    { canonical: "cancelled", native: "killed", label: "已取消" },
  ] as const)(
    "keeps canonical $canonical in resource drain until native $native settlement",
    ({ canonical, native, label }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10000);
      const text =
        canonical === "completed"
          ? "研究报告已定档，主 Agent 将在聊天中交付结论"
          : "研究已取消，已提交产物保留";
      const output = observation(
        progress({ status: canonical, phase: { kind: "ended" } }, text),
      );
      const h = jobsFixture([row()], { [jobId]: output });
      const mounted = render(
        <ResearchJobCard
          data={project([registered()]).data}
          sessionId={sessionId}
          jobs={h.jobs}
        />,
      );
      expect(screen.getByRole("status").textContent).toBe(
        canonical === "completed" ? "正在收尾" : "正在取消",
      );
      expect(
        screen
          .getAllByText(text)
          .some((element) => !element.closest("details")),
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
      if (canonical === "cancelled") {
        expect(
          (
            screen.getByRole("button", {
              name: "正在取消…",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        act(() =>
          h.update({
            rows: { [sessionId]: [row({ status: "stopping" })] },
            observed: { [jobId]: output },
          }),
        );
        expect(screen.getByRole("status").textContent).toBe("正在取消");
      }
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("用时 10 秒")).toBeTruthy();
      expect(h.jobs.kill).not.toHaveBeenCalled();
      expect(h.jobs.observe).toHaveBeenCalledExactlyOnceWith(sessionId, jobId);
      expect(h.unobserve).not.toHaveBeenCalled();
      const detail = native === "failed" ? "角色释放失败" : undefined;
      act(() =>
        h.update({
          rows: {
            [sessionId]: [
              row({
                status: native,
                finishedAt: 11000,
                ...(detail === undefined ? {} : { detail }),
              }),
            ],
          },
          observed: { [jobId]: output },
        }),
      );
      expect(screen.getByRole("status").textContent).toBe(label);
      expect(screen.getByText("用时 10 秒")).toBeTruthy();
      if (detail !== undefined) expect(screen.getByText(detail)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.jobs.observe).toHaveBeenCalledOnce();
      expect(h.unobserve).not.toHaveBeenCalled();
      mounted.unmount();
      expect(h.unobserve).toHaveBeenCalledExactlyOnceWith(jobId);
      expect(h.unwatch).toHaveBeenCalledOnce();
      expect(h.listeners.size).toBe(0);
    },
  );

  it("observes concurrent operations and releases only removed step observations", () => {
    const firstId = JobId("stock-research-step-market");
    const secondId = JobId("stock-research-step-finance");
    const thirdId = JobId("stock-research-step-risk");
    const rows = [
      row(),
      row({
        id: firstId,
        kind: "stock-research-step",
        label: "行情分析",
        progress: "读取行情快照",
      }),
      row({
        id: secondId,
        kind: "stock-research-step",
        label: "财务分析",
        progress: "核对现金流",
      }),
      row({ id: thirdId, kind: "stock-research-step", label: "风险分析" }),
    ];
    const h = jobsFixture(rows, {
      [jobId]: observation(progress({ operationIds: [firstId, secondId] })),
    });
    const mounted = render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    for (const id of [jobId, firstId, secondId])
      expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, id);
    expect(screen.getByText("行情分析").closest("li")?.textContent).toBe(
      "行情分析进行中读取行情快照",
    );
    expect(screen.getByText("财务分析").closest("li")?.textContent).toBe(
      "财务分析进行中核对现金流",
    );
    act(() =>
      h.update({
        rows: { [sessionId]: rows },
        observed: {
          [jobId]: observation(progress({ operationIds: [firstId] })),
        },
      }),
    );
    expect(h.unobserve.mock.calls).toEqual([[secondId]]);
    act(() =>
      h.update({
        rows: { [sessionId]: rows },
        observed: {
          [jobId]: observation(progress({ operationIds: [firstId, thirdId] })),
        },
      }),
    );
    act(() =>
      h.update({
        rows: { [sessionId]: rows },
        observed: {
          [jobId]: observation(progress({ operationIds: [thirdId, firstId] })),
        },
      }),
    );
    expect(
      vi.mocked(h.jobs.observe).mock.calls.filter(([, id]) => id === firstId),
    ).toHaveLength(1);
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, thirdId);
    expect(h.unobserve.mock.calls).toEqual([[secondId]]);
    act(() =>
      h.update({
        rows: { [sessionId]: rows.filter(({ id }) => id !== firstId) },
        observed: {
          [jobId]: observation(progress({ operationIds: [firstId, thirdId] })),
        },
      }),
    );
    expect(h.unobserve.mock.calls).toEqual([[secondId], [firstId]]);
    expect(h.unobserve).not.toHaveBeenCalledWith(jobId);
    expect(h.unwatch).not.toHaveBeenCalled();
    mounted.unmount();
    expect(h.unobserve).toHaveBeenCalledWith(thirdId);
    expect(h.unobserve).toHaveBeenCalledTimes(4);
    expect(h.unobserve).toHaveBeenCalledWith(jobId);
    expect(h.unwatch).toHaveBeenCalledOnce();
  });

  it("shows a rejected native cancellation and retains a later completed state independently of prose", async () => {
    const h = jobsFixture([row()], { [jobId]: observation(progress()) });
    vi.mocked(h.jobs.kill).mockRejectedValueOnce(new Error("运行取消失败"));
    const mounted = render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "取消失败：运行取消失败",
      ),
    );
    mounted.rerender(
      <ResearchJobCard
        data={project([registered(), settled()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("已完成");
    expect(screen.getByText("用时 11 秒")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
  });

  it("streams progress, ticks elapsed time, and retains terminal output until observation cleanup on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const h = jobsFixture([row()], {
      [jobId]: observation(progress({}, "采集数据 9/53 · 东方财富")),
    });
    const mounted = render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByText(/用时 9 秒/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/用时 10 秒/)).toBeTruthy();
    act(() =>
      h.update({
        rows: { [sessionId]: [row({ progress: "Unused native copy" })] },
        observed: { [jobId]: observation(progress({}, "分析 · 财务研究员")) },
      }),
    );
    expect(
      screen
        .getAllByText("分析 · 财务研究员")
        .some((element) => !element.closest("details")),
    ).toBe(true);
    expect(h.jobs.watchRows).toHaveBeenCalledWith(sessionId);
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, jobId);
    mounted.rerender(
      <ResearchJobCard
        data={project([registered(), settled()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(h.unwatch).not.toHaveBeenCalled();
    expect(h.unobserve).not.toHaveBeenCalled();
    mounted.unmount();
    expect(h.unwatch).toHaveBeenCalledOnce();
    expect(h.unobserve).toHaveBeenCalledExactlyOnceWith(jobId);
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a native cancellation error receipt so it can be retried", async () => {
    const h = jobsFixture([row()]);
    vi.mocked(h.jobs.kill).mockResolvedValueOnce({
      ok: false,
      error: new RemoteError("gateway/internal", "取消请求失败", {}),
    });
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "取消失败：取消请求失败",
      ),
    );
    expect(h.jobs.kill).toHaveBeenCalledWith(sessionId, jobId);
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    act(() =>
      h.update({
        rows: { [sessionId]: [row({ status: "stopping" })] },
        observed: {},
      }),
    );
    expect(
      (screen.getByRole("button", { name: "正在取消…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("preserves cancellation and failure details after the live registry row disappears", () => {
    const h = jobsFixture();
    const cancelled = project([
      registered(),
      settled(1, { status: "killed", detail: "用户取消调研" }),
    ]);
    const mounted = render(
      <ResearchJobCard
        data={cancelled.data}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByText(/已取消/)).toBeTruthy();
    expect(screen.getByText("用户取消调研")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    mounted.rerender(
      <ResearchJobCard
        data={{
          ...cancelled.data,
          settlement: {
            ...settlement,
            status: "failed",
            detail: "数据源请求失败",
          },
        }}
        sessionId={sessionId}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("执行失败");
    expect(screen.getByText("用时 11 秒")).toBeTruthy();
    expect(screen.getByText("数据源请求失败")).toBeTruthy();
  });

  it("keeps copied native history readable without observing or controlling another session's Job", () => {
    const h = jobsFixture([row()]);
    render(
      <ResearchJobCard
        data={project([registered(), settled()]).data}
        sessionId={SessionId("copied-session")}
        jobs={h.jobs}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe(registration.label);
    expect(screen.getByRole("status").textContent).toBe("已完成");
    expect(h.jobs.watchRows).not.toHaveBeenCalled();
    expect(h.jobs.observe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("releases owned parent and operation observations when the card changes to another session", () => {
    const operationId = JobId("stock-research-step-market");
    const h = jobsFixture(
      [row(), row({ id: operationId, kind: "stock-research-step" })],
      {
        [jobId]: observation(progress({ operationIds: [operationId] })),
      },
    );
    const data = project([registered()]).data;
    const mounted = render(
      <ResearchJobCard data={data} sessionId={sessionId} jobs={h.jobs} />,
    );
    mounted.rerender(
      <ResearchJobCard
        data={data}
        sessionId={SessionId("copied-session")}
        jobs={h.jobs}
      />,
    );
    expect(h.unwatch).toHaveBeenCalledOnce();
    expect(h.unobserve.mock.calls.map(([id]) => id).sort()).toEqual(
      [jobId, operationId].sort(),
    );
    expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
    expect(h.jobs.observe).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(h.unobserve).toHaveBeenCalledTimes(2);
  });
});

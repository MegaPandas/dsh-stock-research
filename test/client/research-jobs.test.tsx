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
  type ResearchJobCardProps,
  type ResearchCardData,
} from "../../src/client/research-jobs.js";
import type { ResearchActivity } from "../../src/app/research-job.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  cancelRun.mockReset();
});

const cancelRun = vi.fn<ResearchJobCardProps["cancelRun"]>(async () => {});
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
function result(seq = 1): SessionEvent<"stock-research/result"> {
  return {
    type: "stock-research/result",
    seq: SessionSeq(seq),
    time: 11000,
    data: {
      jobId,
      runId: "run-fixture",
      text: "完整研究报告\n\n数据、判断和来源。",
      outcome: "success",
    },
  };
}
function activity(
  seq = 1,
  overrides: Partial<ResearchActivity> = {},
): SessionEvent<"stock-research/activity"> {
  return {
    type: "stock-research/activity",
    seq: SessionSeq(seq),
    time: 10000,
    data: {
      jobId,
      owner: sessionId,
      label: registration.label,
      runId: "run-fixture",
      status: "active",
      progress: "分析阶段，等待主 Agent 验收",
      operationIds: [],
      startedAt: 1000,
      ...overrides,
    },
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

function jobsFixture(rows: readonly JobView[] = []) {
  let snapshot: JobsSnapshot = { rows: { [sessionId]: rows }, observed: {} };
  const listeners = new Set<() => void>();
  const unwatch = vi.fn();
  const unobserve = vi.fn();
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
    observe: vi.fn(() => unobserve),
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
  it("connects a native task from history before its live row arrives", () => {
    const h = jobsFixture();
    render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(h.jobs.watchRows).toHaveBeenCalledWith(sessionId);
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, jobId);
    act(() =>
      h.update({
        rows: {
          [sessionId]: [row({ progress: "等待主 Agent 验收：analysis" })],
        },
        observed: {},
      }),
    );
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
      assembler.append({ type: "event", event: activity() });
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
      ).toMatchObject({ activity: activity().data });
      assembler.append({ type: "event", event: result(3) });
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
        data: { registration, settlement, result: result().data },
      });
      assembler.replaceWindow([{ type: "event", event: result(8) }], true);
      assembler.flush();
      const restored = assembler.get("chat")!;
      expect(restored.order).toHaveLength(1);
      expect(restored.nodes.get(restored.order[0]!)).toMatchObject({
        anchorSeq: 8,
        data: { result: result().data },
      });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("publishes a visible non-command chat node from the first registration in an empty conversation", () => {
    const node = project([registered()]);
    expect(node).toMatchObject({
      kind: "stock-research-job",
      target: "chat",
      visibility: "visible",
      location: { kind: "session" },
      anchorSeq: 0,
    });
    expect(node.data.registration?.label).toBe(registration.label);
    expect(
      typeof researchJobDefinition.match === "function" &&
        researchJobDefinition.match({
          ...registered(),
          data: { ...registration, kind: "bash" },
        }),
    ).toBeNull();
  });

  it("keeps one identity and anchor while adding its complete report and terminal state", () => {
    const node = project([
      registered(),
      result(),
      {
        type: "job/settled",
        seq: SessionSeq(2),
        time: 12000,
        data: settlement,
      },
    ]);
    expect(node.id).toBe(jobId);
    expect(node.anchorSeq).toBe(0);
    expect(node.data).toMatchObject({
      registration,
      settlement,
      result: { runId: "run-fixture", text: result().data.text },
    });
  });

  it("restores the full report when a history window starts with the result event", () => {
    const node = project([result(8)]);
    expect(node.anchorSeq).toBe(8);
    const h = jobsFixture();
    render(
      <ResearchJobCard
        data={node.data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByText(/完整研究报告/).textContent).toBe(
      result().data.text,
    );
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(h.jobs.watchRows).not.toHaveBeenCalled();
    expect(h.jobs.observe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
  });

  it("restores an activity-only window and ignores fine-grained step registrations", () => {
    const node = project([activity(10)]);
    expect(node).toMatchObject({
      anchorSeq: 10,
      id: jobId,
      data: { activity: activity().data },
    });
    expect(
      typeof researchJobDefinition.match === "function" &&
        researchJobDefinition.match({
          ...registered(),
          data: { ...registration, kind: "stock-research-step" },
        }),
    ).toBeNull();
  });
});

describe("research task card", () => {
  it("shows real collection counts while keeping technical identifiers in collapsed details", () => {
    const technical =
      "采集数据 38/53 · 成功 37，缺失 1 · eastmoney · benchmark.dxy.weekly";
    const h = jobsFixture([row({ progress: technical })]);
    render(
      <ResearchJobCard
        data={
          project([
            activity(1, {
              label: "002594.SZ · 快速研究 · 2026-10-28",
              status: "preparing",
              operationIds: [jobId],
            }),
          ]).data
        }
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("002594.SZ");
    expect(screen.getByText("快速研究")).toBeTruthy();
    expect(screen.getByText("2026-10-28")).toBeTruthy();
    expect(screen.getByText("37 项已就绪")).toBeTruthy();
    expect(screen.getByText("1 项缺失")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "数据采集进度" });
    expect(progress.getAttribute("aria-valuenow")).toBe("38");
    expect(progress.getAttribute("aria-valuemax")).toBe("53");
    const details = screen.getByText("查看详情").closest("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(screen.getByText(technical).closest("details")).toBe(details);
  });

  it("does not invent a total percentage during analysis and translates known review stages", () => {
    const h = jobsFixture();
    const technical = "等待主 Agent 验收：digest.analysis";
    const mounted = render(
      <ResearchJobCard
        data={project([activity(1, { progress: technical })]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("等待验收");
    expect(screen.getByText("等待主 Agent 验收：分析摘要")).toBeTruthy();
    expect(
      screen.getByText(technical).closest("details")?.hasAttribute("open"),
    ).toBe(false);
    expect(screen.queryByRole("progressbar")).toBeNull();
    mounted.rerender(
      <ResearchJobCard
        data={project([activity(2, { progress: "正在核对最新财务报告" })]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByText("正在核对最新财务报告")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps preparation progress live and cancels its native job before a run exists", async () => {
    const h = jobsFixture([row()]);
    const { runId: _runId, ...preparing } = activity().data;
    void _runId;
    const data = project([
      {
        ...activity(),
        data: { ...preparing, status: "preparing", operationIds: [jobId] },
      },
    ]).data;
    render(
      <ResearchJobCard
        data={data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByText("采集数据 9/53 · 东方财富")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await waitFor(() =>
      expect(h.jobs.kill).toHaveBeenCalledWith(sessionId, jobId),
    );
    expect(cancelRun).not.toHaveBeenCalled();
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

  it("keeps the research active after preparation settles and cancels the full run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20000);
    const h = jobsFixture([row({ status: "completed", finishedAt: 12000 })]);
    render(
      <ResearchJobCard
        data={
          project([
            registered(),
            {
              type: "job/settled",
              seq: SessionSeq(1),
              time: 12000,
              data: settlement,
            },
            activity(2),
          ]).data
        }
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("等待验收");
    expect(screen.getByText("用时 19 秒")).toBeTruthy();
    expect(screen.getByText("分析阶段，等待主 Agent 验收")).toBeTruthy();
    expect(h.jobs.observe).not.toHaveBeenCalled();
    expect(h.jobs.watchRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消调研" }));
    await act(async () => {});
    expect(cancelRun).toHaveBeenCalledWith(sessionId, "run-fixture");
    expect(h.jobs.kill).not.toHaveBeenCalled();
  });

  it("observes concurrent operations in one card and releases observations when operations finish", () => {
    const firstId = JobId("stock-research-step-market");
    const secondId = JobId("stock-research-step-finance");
    const h = jobsFixture([
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
    ]);
    const mounted = render(
      <ResearchJobCard
        data={
          project([activity(1, { operationIds: [firstId, secondId] })]).data
        }
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, firstId);
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, secondId);
    expect(screen.getByText("行情分析 · 读取行情快照")).toBeTruthy();
    expect(screen.getByText("财务分析 · 核对现金流")).toBeTruthy();
    mounted.rerender(
      <ResearchJobCard
        data={project([activity(2, { operationIds: [] })]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(h.unobserve).toHaveBeenCalledTimes(2);
    expect(h.unwatch).toHaveBeenCalledOnce();
    mounted.unmount();
    expect(h.unobserve).toHaveBeenCalledTimes(2);
  });

  it("shows full-run cancellation failures and keeps completed activity independent of a live row", async () => {
    const h = jobsFixture();
    cancelRun.mockRejectedValueOnce(new Error("运行取消失败"));
    const mounted = render(
      <ResearchJobCard
        data={project([activity()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
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
        data={
          project([
            activity(2, {
              status: "completed",
              progress: "研究报告已生成",
              finishedAt: 12000,
            }),
          ]).data
        }
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("已完成");
    expect(screen.getByText("用时 11 秒")).toBeTruthy();
    expect(screen.getByText("研究报告已生成")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消调研" })).toBeNull();
  });

  it("streams collection progress, ticks elapsed time, and releases observations on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const h = jobsFixture([row()]);
    const mounted = render(
      <ResearchJobCard
        data={project([registered()]).data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByText("采集数据 9/53 · 东方财富")).toBeTruthy();
    expect(screen.getByText(/用时 9 秒/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/用时 10 秒/)).toBeTruthy();
    act(() =>
      h.update({
        rows: { [sessionId]: [row({ progress: "分析 · 财务研究员" })] },
        observed: {},
      }),
    );
    expect(screen.getByText("分析 · 财务研究员")).toBeTruthy();
    expect(h.jobs.watchRows).toHaveBeenCalledWith(sessionId);
    expect(h.jobs.observe).toHaveBeenCalledWith(sessionId, jobId);
    mounted.rerender(
      <ResearchJobCard
        data={{ ...project([registered(), result()]).data, settlement }}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(h.unwatch).toHaveBeenCalledOnce();
    expect(h.unobserve).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    mounted.unmount();
    expect(h.unwatch).toHaveBeenCalledOnce();
    expect(h.unobserve).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses native cancellation and shows a failed receipt so it can be retried", async () => {
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
        cancelRun={cancelRun}
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
      {
        type: "job/settled",
        seq: SessionSeq(1),
        time: 12000,
        data: { ...settlement, status: "killed", detail: "用户取消调研" },
      },
    ]);
    const mounted = render(
      <ResearchJobCard
        data={cancelled.data}
        sessionId={sessionId}
        jobs={h.jobs}
        cancelRun={cancelRun}
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
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("执行失败");
    expect(screen.getByText("用时 11 秒")).toBeTruthy();
    expect(screen.getByText("数据源请求失败")).toBeTruthy();
  });

  it("keeps copied history readable without observing or controlling another session's job", () => {
    const h = jobsFixture([row()]);
    render(
      <ResearchJobCard
        data={project([registered(), result()]).data}
        sessionId={SessionId("copied-session")}
        jobs={h.jobs}
        cancelRun={cancelRun}
      />,
    );
    expect(screen.getByText(/完整研究报告/)).toBeTruthy();
    expect(h.jobs.watchRows).not.toHaveBeenCalled();
    expect(h.jobs.observe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

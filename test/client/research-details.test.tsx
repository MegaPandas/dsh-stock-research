// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobId } from "@deepseek-ai/dsh-jobs/brand";
import type { ObservedJob } from "@deepseek-ai/dsh-api-job-controller/client";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";
import { ResearchDetails } from "../../src/client/ResearchDetails.js";

afterEach(cleanup);

function observation(
  text: string,
  extra: Partial<ObservedJob> = {},
): ObservedJob {
  return {
    jobId: JobId("collection"),
    text,
    gapBefore: false,
    streaming: true,
    ...extra,
  };
}

describe("research details", () => {
  it("summarizes the latest collection counts without treating source diagnostics as missing data", () => {
    const text = [
      "采集数据 1/2 · 成功 0，缺失 1 · 缓存命中 0，未命中 1",
      "benchmark.gold.weekly · eastmoney · TypeError: fetch failed → socket closed · context",
      "benchmark.gold.monthly · eastmoney · TypeError: fetch failed → socket closed · context",
      "采集数据 2/2 · 成功 2，缺失 0 · 缓存命中 0，未命中 2",
      "采集记录：/tmp/研究 记录.json",
      "分析 · 已完成 0/12 个研究任务",
      "",
    ].join("\n");
    render(
      <ResearchDetails
        progress={undefined}
        operations={[]}
        observations={[observation(text)]}
      />,
    );
    expect(screen.getByText("已处理").parentElement?.textContent).toBe(
      "已处理2 / 2",
    );
    expect(screen.getByText("已就绪").parentElement?.textContent).toBe(
      "已就绪2",
    );
    expect(screen.getByText("缺失").parentElement?.textContent).toBe("缺失0");
    expect(screen.getAllByText("数据采集")).toHaveLength(1);
    expect(screen.getAllByText("来源诊断")).toHaveLength(1);
    expect(screen.getByText("benchmark.gold.weekly")).toBeTruthy();
    expect(screen.getByText("benchmark.gold.monthly")).toBeTruthy();
    expect(screen.getByText("2 条")).toBeTruthy();
    expect(
      screen.getByText("TypeError: fetch failed → socket closed · context"),
    ).toBeTruthy();
    expect(screen.queryByText("执行失败")).toBeNull();
    expect(screen.getByText("/tmp/研究 记录.json")).toBeTruthy();
    expect(screen.getByText("分析 · 已完成 0/12 个研究任务")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "原始日志" }));
    expect(screen.getByLabelText("原始日志").textContent).toBe(text);
    expect(
      screen
        .getByRole("button", { name: "原始日志" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "整理视图" }));
    expect(screen.getByText("缺失").parentElement?.textContent).toBe("缺失0");
  });

  it("keeps earlier and unknown output accessible, and retains a stream gap notice", () => {
    const text =
      "最早记录\n第二条记录\n第三条记录\n第四条记录\n第五条记录\n第六条记录\n第七条记录\n最新记录\n";
    render(
      <ResearchDetails
        progress={undefined}
        operations={[]}
        observations={[observation(text, { gapBefore: true })]}
      />,
    );
    expect(screen.getByText("这里只显示最近的日志。")).toBeTruthy();
    expect(screen.queryByText("最早记录")).toBeNull();
    expect(screen.getByText("最新记录")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "显示更早的 2 条记录" }),
    );
    expect(screen.getByText("最早记录")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "收起较早记录" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "收起较早记录" }));
    expect(screen.queryByText("最早记录")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "原始日志" }));
    expect(screen.getByLabelText("原始日志").textContent).toBe(text);
  });

  it("separates concurrent task output and displays actual task outcomes", () => {
    const tasks: JobView[] = [
      {
        id: JobId("market"),
        kind: "stock-research-step",
        label: "行情分析",
        status: "completed",
        detail: "已保存分析",
        startedAt: 1000,
        output: { total: 100, earliest: 0 },
      },
      {
        id: JobId("finance"),
        kind: "stock-research-step",
        label: "财务分析",
        status: "running",
        progress: "核对现金流",
        startedAt: 2000,
        output: { total: 200, earliest: 0 },
      },
    ];
    const mounted = render(
      <ResearchDetails
        progress={undefined}
        operations={tasks}
        observations={[
          observation("行情输出\n", {
            jobId: JobId("market"),
            streaming: false,
          }),
          observation("财务输出\n", { jobId: JobId("finance") }),
        ]}
      />,
    );
    const rows = within(
      screen.getByRole("region", { name: "研究任务" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "行情分析已完成已保存分析",
      "财务分析进行中核对现金流",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "原始日志" }));
    expect(screen.getByLabelText("行情分析原始日志").textContent).toBe(
      "行情输出\n",
    );
    expect(screen.getByLabelText("财务分析原始日志").textContent).toBe(
      "财务输出\n",
    );
    mounted.rerender(
      <ResearchDetails
        progress={undefined}
        operations={tasks}
        observations={[
          observation("行情输出\n", {
            jobId: JobId("market"),
            streaming: false,
          }),
          observation("财务输出\n新增一条\n", { jobId: JobId("finance") }),
        ]}
      />,
    );
    expect(screen.getByLabelText("财务分析原始日志").textContent).toBe(
      "财务输出\n新增一条\n",
    );
  });
});

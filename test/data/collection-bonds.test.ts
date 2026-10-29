import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import { createBenchmarkBondTasks } from "../../src/data/collection-bonds.js";
import { HttpClient } from "../../src/data/http.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const scope: ResearchScope = {
  security: CN_SECURITY,
  date: "2026-10-27",
  cutoff: "2026-10-26T17:48:31.000Z",
};
function response(data: Record<string, unknown>[]) {
  return JSON.stringify({
    success: true,
    code: 0,
    result: { pages: 157, count: 9374, data },
  });
}
function setup(
  text = response([
    {
      SOLAR_DATE: "2026-10-26 00:00:00",
      EMM00166466: 1.6376,
      EMG00001310: null,
    },
    { SOLAR_DATE: "2026-10-23 00:00:00", EMM00166466: 1.64, EMG00001310: 5 },
    {
      SOLAR_DATE: "2026-10-22 00:00:00",
      EMM00166466: 1.6414,
      EMG00001310: 4.96,
    },
  ]),
  selectedScope = scope,
) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const get = vi.spyOn(http, "getText").mockResolvedValue(text);
  const tasks = createBenchmarkBondTasks(http, selectedScope);
  return { get, task: tasks[0]!, tasks };
}
afterEach(() => vi.restoreAllMocks());

describe("fixed benchmark government-bond yields", () => {
  it("requests both countries in one dated table and preserves the verified source sample", async () => {
    const { get, task, tasks } = setup();
    const signal = new AbortController().signal;
    expect(tasks).toHaveLength(1);
    expect(task).toMatchObject({
      id: "benchmark.bondYields",
      provider: "eastmoney",
      dataset: "macro",
    });
    const envelope = await task.run(signal);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]?.signal).toBe(signal);
    const url = new URL(String(get.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://datacenter.eastmoney.com/api/data/get",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "RPTA_WEB_TREASURYYIELD",
      sty: "ALL",
      st: "SOLAR_DATE",
      sr: "-1",
      p: "1",
      ps: "60",
      filter: "(SOLAR_DATE<='2026-10-26')",
    });
    expect(
      envelope.data.rows.map(({ date, values }) => ({ date, values })),
    ).toEqual([
      { date: "2026-10-22", values: { china10y: 1.6414, us10y: 4.96 } },
      { date: "2026-10-23", values: { china10y: 1.64, us10y: 5 } },
      { date: "2026-10-26", values: { china10y: 1.6376, us10y: null } },
    ]);
    expect(envelope.data.columns).toEqual({
      china10y: { label: "中国10年期国债收益率", unit: "percent" },
      us10y: { label: "美国10年期国债收益率", unit: "percent" },
    });
    expect(envelope.data).toMatchObject({
      interval: "1d",
      basis: "source_reported_daily_yield",
    });
    expect(envelope).toMatchObject({
      asOf: "2026-10-26T00:00:00.000Z",
      availableAt: null,
      historicalKnowledge: "unverified",
    });
    expect(envelope.gaps).toContainEqual(
      expect.objectContaining({ code: "unverified_time" }),
    );
    expect(envelope.gaps).toContainEqual(
      expect.objectContaining({
        code: "missing",
        field: "/data/rows/2/values/us10y",
      }),
    );
  });

  it("uses the same single source independently of the researched stock market", async () => {
    const { task, get } = setup(undefined, {
      ...scope,
      security: US_SECURITY,
      date: "2026-10-26",
      cutoff: "2026-10-27T03:59:59.999Z",
    });
    const envelope = await task.run();
    expect(
      new URL(String(get.mock.calls[0]![0])).searchParams.get("filter"),
    ).toBe("(SOLAR_DATE<='2026-10-26')");
    expect(envelope.data.rows.at(-1)!.values.us10y).toBeNull();
  });

  it("keeps the latest sixty source observations without synthesizing calendar dates", async () => {
    const rows = Array.from({ length: 65 }, (_, index) => ({
      SOLAR_DATE: new Date(Date.UTC(2026, 0, 1 + index))
        .toISOString()
        .slice(0, 10),
      EMM00166466: 1,
      EMG00001310: 4,
    }));
    const { task } = setup(response(rows));
    const envelope = await task.run();
    expect(envelope.data.rows).toHaveLength(60);
    expect(envelope.data.rows[0]!.date).toBe("2026-01-06");
    expect(envelope.data.rows.at(-1)!.date).toBe("2026-03-06");
  });

  it("filters future source labels instead of substituting current values into history", async () => {
    const { task } = setup(
      response([
        { SOLAR_DATE: "2026-10-28 00:00:00", EMM00166466: 99, EMG00001310: 99 },
        {
          SOLAR_DATE: "2026-10-23 00:00:00",
          EMM00166466: null,
          EMG00001310: 5,
        },
      ]),
    );
    const envelope = await task.run();
    expect(envelope.data.rows).toHaveLength(1);
    expect(envelope.data.rows[0]!.values).toEqual({ china10y: null, us10y: 5 });
  });

  it("propagates network errors and rejected source responses without retries or another provider", async () => {
    const { task, get } = setup();
    const failure = new Error("source disconnected");
    get.mockRejectedValueOnce(failure);
    await expect(task.run()).rejects.toBe(failure);
    get.mockResolvedValueOnce(
      JSON.stringify({ success: false, code: 500, message: "unavailable" }),
    );
    await expect(task.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(task.enabledBy).toEqual(["benchmarks"]);
  });

  it("rejects empty and duplicate-dated responses", async () => {
    const empty = setup(response([]));
    await expect(empty.task.run()).rejects.toMatchObject({
      code: "DATA_INSUFFICIENT",
    });
    const duplicate = setup(
      response([{ SOLAR_DATE: "2026-10-23" }, { SOLAR_DATE: "2026-10-23" }]),
    );
    await expect(duplicate.task.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });

  it.each([
    { SOLAR_DATE: "2026-13-01", EMM00166466: 1.6 },
    { SOLAR_DATE: "2026-10-23 08:00:00", EMM00166466: 1.6 },
    { SOLAR_DATE: "2026-10-23", EMM00166466: "invalid" },
    { SOLAR_DATE: "2026-10-23", EMG00001310: true },
  ])("rejects malformed source dates or nonnumeric rates", async (row) => {
    const { task } = setup(response([row]));
    await expect(task.run()).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});

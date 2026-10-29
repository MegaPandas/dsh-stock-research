import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import { HttpClient } from "../../src/data/http.js";
import { CollectionService } from "../../src/services/collection.js";
import type { QueryService } from "../../src/services/query.js";
import { CN_SECURITY } from "../fixtures/market.js";

const scope = {
  security: CN_SECURITY,
  date: "2024-01-03",
  cutoff: "2024-01-03T08:00:00.000Z",
};
const cookie = "session=fixture-only-session";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function setup(enabledSources: string[]) {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-xueqiu-"));
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 100,
  });
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  const service = new CollectionService(
    http,
    cache,
    { query: vi.fn() as QueryService["query"] },
    {
      enabledSources,
      xueqiuCookie: cookie,
      freshness: { market: 86400000, fundamentals: 86400000, macro: 0 },
      secCiks: {},
      ttl: { market: 60000, fundamentals: 60000, macro: 0, research: 0 },
    },
  );
  cleanups.push(async () => {
    await service.close();
    await http.close();
    cache.close();
    fs.rmSync(directory, { recursive: true });
  });
  return service;
}

function json(value: unknown) {
  return new Response(JSON.stringify(value));
}

function mockSources(primarySucceeds: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "stock.xueqiu.com") {
      if (url.pathname.includes("kline")) {
        const period = url.searchParams.get("period");
        const date = period === "day" ? "2024-01-03" : "2023-12-29";
        return json({
          error_code: 0,
          data: {
            symbol: "SH600519",
            column: ["timestamp", "open", "close", "high", "low", "volume"],
            item: [[Date.parse(`${date}T00:00:00Z`), 100, 102, 103, 99, 1200]],
          },
        });
      }
      if (url.pathname.includes("quote"))
        return json({
          error_code: 0,
          data: {
            quote: {
              symbol: "SH600519",
              currency: "CNY",
              name: "贵州茅台",
              timestamp: Date.parse("2024-01-03T07:30:00Z"),
              current: 102,
            },
          },
        });
      return json({
        error_code: 0,
        data: {
          currency: "CNY",
          list: [
            {
              report_date: Date.parse("2023-09-30T00:00:00+08:00"),
              total_revenue: [1000000, 0.25],
              total_assets: [5000000, 0.1],
              ncf_from_oa: [200000, 0.2],
              basic_eps: [1.25, 0.1],
            },
          ],
        },
      });
    }
    if (!primarySucceeds)
      return new Response("source unavailable", { status: 503 });
    if (url.hostname === "push2his.eastmoney.com") {
      const interval = url.searchParams.get("klt");
      const date = interval === "101" ? "2024-01-03" : "2023-12-29";
      return json({
        rc: 0,
        data: {
          code: "600519",
          market: 1,
          klines: [`${date},100,102,103,99,12,122400,4,2,2,0.01`],
        },
      });
    }
    if (url.hostname === "push2.eastmoney.com")
      return json({
        rc: 0,
        data: {
          f57: "600519",
          f58: "贵州茅台",
          f59: 2,
          f152: 2,
          f86: Date.parse("2024-01-03T07:30:00Z") / 1000,
          f43: 10200,
        },
      });
    return json({
      success: true,
      code: 0,
      result: {
        data: [
          {
            SECUCODE: "600519.SH",
            REPORT_DATE: "2023-09-30 00:00:00",
            NOTICE_DATE: "2023-10-30 00:00:00",
            SECURITY_CODE: "600519",
            TRADE_DATE: "2024-01-03 00:00:00",
            EPSJB: 1,
          },
        ],
      },
    });
  });
}

function xueqiuCalls(fetch: ReturnType<typeof mockSources>) {
  return fetch.mock.calls.filter(
    ([url]) => new URL(String(url)).hostname === "stock.xueqiu.com",
  );
}

describe("Xueqiu collection fallback integration", () => {
  it("makes no Xueqiu requests while disabled even if a Cookie is retained", async () => {
    const fetch = mockSources(false);
    await setup(["eastmoney-market", "eastmoney-income"]).collect(scope);
    expect(xueqiuCalls(fetch)).toHaveLength(0);
  });

  it("keeps primary results and never contacts Xueqiu when they succeed", async () => {
    const fetch = mockSources(true);
    const snapshot = await setup([
      "eastmoney-market",
      "eastmoney-income",
      "xueqiu",
    ]).collect(scope);
    expect(snapshot.packets).toHaveLength(11);
    expect(
      snapshot.packets.every(
        ({ id, envelope }) =>
          envelope.source.provider ===
          (id === "financial.metrics" ? "stock-research" : "eastmoney"),
      ),
    ).toBe(true);
    expect(xueqiuCalls(fetch)).toHaveLength(0);
  });

  it("uses whole fallback tables, reuses their cache and excludes credentials from captured data", async () => {
    const fetch = mockSources(false);
    const service = setup([
      "eastmoney-market",
      "eastmoney-income",
      "tencent",
      "sina",
      "xueqiu",
    ]);
    const snapshot = await service.collect(scope);
    expect(snapshot.packets.map(({ id }) => id)).toEqual([
      "market.daily",
      "market.weekly",
      "market.monthly",
      "stock.snapshot",
      "financial.indicators",
      "financial.income",
      "financial.balance",
      "financial.cashflow",
      "financial.metrics",
    ]);
    expect(
      snapshot.packets.every(
        ({ id, envelope }) =>
          envelope.source.provider ===
          (id === "financial.metrics" ? "stock-research" : "xueqiu"),
      ),
    ).toBe(true);
    expect(snapshot.packets[0]!.envelope.data.rows[0]!.values.volume).toBe(
      1200,
    );
    expect(snapshot.packets[4]!.envelope.data.rows[0]!.values.EPSJB).toBe(1.25);
    expect(snapshot.failures.some(({ id }) => id === "financial.quarter")).toBe(
      true,
    );
    expect(JSON.stringify(snapshot)).not.toContain(cookie);
    const calls = xueqiuCalls(fetch);
    expect(calls).toHaveLength(8);
    for (const [, options] of calls)
      expect(new Headers(options!.headers).get("Cookie")).toBe(cookie);
    const cached = await service.collect(scope);
    expect(xueqiuCalls(fetch)).toHaveLength(calls.length);
    expect(cached.diagnostics!.cacheHits).toBe(8);
    expect(JSON.stringify(cached)).not.toContain(cookie);
  });
});

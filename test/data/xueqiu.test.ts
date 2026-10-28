import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/data/http.js";
import {
  XueqiuClient,
  xueqiuDate,
  xueqiuTimestamp,
} from "../../src/data/xueqiu.js";
import { collectionError } from "../../src/services/collection-errors.js";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  return {
    http,
    client: new XueqiuClient(http, "session=fixture-only-session"),
  };
}

describe("Xueqiu authenticated transport", () => {
  it("sends the configured Cookie only in request headers", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error_code: 0, data: { list: [] } })),
      );
    const { http, client } = setup();
    try {
      const result = await client.get("/v5/stock/finance/cn/income.json", {
        symbol: "SZ002594",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0]!;
      expect(String(url)).toBe(
        "https://stock.xueqiu.com/v5/stock/finance/cn/income.json?symbol=SZ002594",
      );
      expect(new Headers(options!.headers).get("Cookie")).toBe(
        "session=fixture-only-session",
      );
      expect(result.data).toEqual({ list: [] });
      expect(JSON.stringify(result)).not.toContain("fixture-only-session");
      expect(JSON.stringify(client)).not.toContain("fixture-only-session");
    } finally {
      await http.close();
    }
  });

  it("reports rejected authentication without retaining the upstream body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error_code: "400016",
          error_description: "upstream message with fixture-only-session",
          data: null,
        }),
      ),
    );
    const { http, client } = setup();
    try {
      const failure = await client
        .get("/v5/stock/quote.json", {})
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      expect(JSON.stringify(collectionError(failure))).not.toContain(
        "fixture-only-session",
      );
    } finally {
      await http.close();
    }
  });

  it("propagates caller cancellation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { http, client } = setup();
    const reason = new Error("collection cancelled");
    try {
      await expect(
        client.get("/v5/stock/quote.json", {}, AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await http.close();
    }
  });

  it("uses China local dates for millisecond timestamps", () => {
    const timestamp = Date.parse("2026-06-29T16:00:00.000Z");
    expect(xueqiuDate(timestamp, "report_date")).toBe("2026-06-30");
    expect(xueqiuTimestamp(timestamp, "report_date")).toBe(
      "2026-06-29T16:00:00.000Z",
    );
    for (const value of [null, "2026-06-30", NaN, 1e20])
      expect(() => xueqiuDate(value, "report_date")).toThrow(
        "expected a millisecond timestamp",
      );
  });
});

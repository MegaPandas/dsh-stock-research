import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../../src/data/http.js";
import { sinaKlines } from "../../src/data/sina-kline.js";

const request = {
  symbol: "sh600519",
  period: "day" as const,
  start: "2026-10-26",
  end: "2026-10-27",
  count: 60,
  volumeScale: 1,
};
const bar = {
  day: "2026-10-26",
  open: "1325.400",
  high: "1350.000",
  low: "1324.790",
  close: "1349.980",
  volume: "4159916",
};
function setup(text: string) {
  const http = new HttpClient({
    timeoutMs: 1000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  vi.spyOn(http, "getText").mockResolvedValue(text);
  return http;
}
afterEach(() => vi.restoreAllMocks());
describe("Sina native K-lines", () => {
  it("normalizes verified source fields and filters historical dates", async () => {
    const http = setup(
      JSON.stringify([
        { ...bar, day: "2026-10-28" },
        bar,
        { ...bar, day: "2026-10-25" },
      ]),
    );
    const result = await sinaKlines(http, request);
    expect(result.rows).toEqual([
      {
        date: "2026-10-26",
        open: 1325.4,
        high: 1350,
        low: 1324.79,
        close: 1349.98,
        volume: 4159916,
      },
    ]);
    expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it.each([
    "not JSON",
    "null",
    "{}",
    JSON.stringify([{ ...bar, volume: "bad" }]),
    JSON.stringify([{ ...bar, day: "2026-02-30" }]),
  ])("rejects malformed source payload %s", async (text) => {
    await expect(sinaKlines(setup(text), request)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
  it("reports unavailable historical coverage without substituting the current tail", async () => {
    await expect(
      sinaKlines(
        setup(JSON.stringify([{ ...bar, day: "2026-10-28" }])),
        request,
      ),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  });
});

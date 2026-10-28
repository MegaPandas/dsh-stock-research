import { describe, expect, it } from "vitest";
import z from "@deepseek-ai/schemastery";
import { parseAskInput } from "../../src/app/ask-input.js";
import { Config } from "../../src/app/ask.js";

const NOW = new Date("2026-10-26T03:00:00.000Z");
describe("ask command external input", () => {
  it.each(["SZ.002594", "CN:002594.SZ", "002594.SZ"])(
    "binds %s to the same explicit Shenzhen equity",
    (symbol) => {
      expect(
        parseAskInput(`  ${symbol} 2026-10-25 比亚迪\n收盘价？  `, NOW),
      ).toEqual({
        scope: {
          security: {
            id: "CN:002594.SZ",
            market: "CN",
            symbol: "002594.SZ",
            exchange: "SZ",
            currency: "CNY",
            timeZone: "Asia/Shanghai",
          },
          date: "2026-10-25",
          cutoff: "2026-10-25T15:59:59.999Z",
        },
        question: "比亚迪\n收盘价？",
      });
    },
  );

  it("caps today's scope at the actual start and uses market-local dates", () => {
    expect(
      parseAskInput("SZ.002594 2026-10-26 今日情况", NOW).scope.cutoff,
    ).toBe(NOW.toISOString());
    expect(() =>
      parseAskInput("NASDAQ:NVDA 2026-10-26 今日情况", NOW),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(
      parseAskInput("NYSE:IBM 2026-10-25 昨日情况", NOW).scope,
    ).toMatchObject({
      security: {
        id: "US:IBM",
        exchange: "NYSE",
        timeZone: "America/New_York",
      },
      cutoff: NOW.toISOString(),
    });
  });

  it.each([
    ["2024-03-10", "2024-03-11T03:59:59.999Z"],
    ["2024-11-03", "2024-11-04T04:59:59.999Z"],
    ["2024-02-29", "2024-03-01T04:59:59.999Z"],
  ])(
    "uses the end of New York date %s across DST and leap boundaries",
    (date, cutoff) => {
      expect(
        parseAskInput(`NASDAQ:NVDA ${date} 收盘价`, NOW).scope.cutoff,
      ).toBe(cutoff);
    },
  );

  it.each([
    "002594 2026-10-25 问题",
    "US:NVDA 2026-10-25 问题",
    "比亚迪 2026-10-25 问题",
    "SZ.002594 2026-02-30 问题",
    "SZ.002594 2026-10-27 问题",
    "SZ.002594 2026-10-25",
    "SZ.002594 2026-10-25   ",
  ])("rejects ambiguous or invalid input %s", (input) => {
    expect(() => parseAskInput(input, NOW)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("allows model inheritance when omitted and validates explicit overrides", () => {
    expect(z.resolve(undefined, Config, {})[0]).toBeUndefined();
    expect(
      Config({ provider: "magpie", model: "minimax-cn/MiniMax-M3.1-Flash" }),
    ).toEqual({ provider: "magpie", model: "minimax-cn/MiniMax-M3.1-Flash" });
    for (const input of [
      { provider: "magpie" },
      { model: "x" },
      { provider: "magpie", model: " " },
      { provider: "magpie", model: "x", fallback: "other" },
    ])
      expect(() => z.resolve(input, Config, {})).toThrow();
  });
});

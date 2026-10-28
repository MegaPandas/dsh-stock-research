import { describe, expect, it } from "vitest";
import {
  decisionPolicy,
  priceRating,
  PRICE_RATING_POLICY,
} from "../../src/contracts/rating-policy.js";

describe("six-month absolute price ratings", () => {
  it.each([
    [116, "buy"],
    [115, "overweight"],
    [110, "overweight"],
    [105, "neutral"],
    [100, "neutral"],
    [95, "neutral"],
    [94, "underweight"],
    [85, "underweight"],
    [84, "sell"],
    [0, "sell"],
  ] as const)("maps a 100 base and %s target to %s", (target, expected) => {
    expect(priceRating(100, target)).toBe(expected);
  });

  it("classifies the BYD run's small negative price expectation as neutral", () => {
    expect(priceRating(82.01, 80)).toBe("neutral");
  });

  it.each([
    [1.4, 1.61, "overweight"],
    [1.4, 1.47, "neutral"],
    [1.4, 1.33, "neutral"],
    [1.4, 1.19, "underweight"],
    [1.4, 1.6100000001, "buy"],
    [1.4, 1.1899999999, "sell"],
    [1e-7, 1.15e-7, "overweight"],
  ] as const)(
    "keeps decimal price endpoints exact for %s to %s",
    (base, target, expected) => {
      expect(priceRating(base, target)).toBe(expected);
    },
  );

  it.each([
    [null, 100],
    [100, null],
    [null, null],
  ])("leaves the rating unset with a missing price", (base, target) => {
    expect(priceRating(base, target)).toBeNull();
  });

  it.each([
    ["2026-10-28", "2027-04-28"],
    ["2023-08-31", "2024-02-29"],
    ["2024-08-31", "2025-02-28"],
    ["2026-03-31", "2026-09-30"],
  ])("sets the six-calendar-month horizon from %s", (date, expected) => {
    expect(decisionPolicy(date)).toMatchObject({
      version: PRICE_RATING_POLICY,
      basis: "absolute_price",
      horizonEndDate: expected,
    });
  });
});

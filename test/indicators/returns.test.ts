import { describe, expect, it } from "vitest";
import { calculatePriceReturn, type PriceReturnInput } from "../../src/core.js";

function input(): PriceReturnInput {
  return {
    requestedStartDate: "2024-01-06",
    requestedEndDate: "2024-01-08",
    start: {
      date: "2024-01-05",
      price: 100,
      currency: "USD",
      adjustment: "unadjusted",
    },
    end: {
      date: "2024-01-08",
      price: 120,
      currency: "USD",
      adjustment: "unadjusted",
    },
    comparable: true,
  };
}

describe("price return", () => {
  it("computes a price-only ratio and preserves requested and actual dates", () => {
    const request = input();
    const result = calculatePriceReturn(request);
    expect(result).toMatchObject({
      ...request,
      unit: "ratio",
      gaps: [],
    });
    expect(result.value).toBeCloseTo(0.2, 12);
    expect(request).toEqual(input());
  });

  it("accepts a verified split-adjusted comparison", () => {
    const request = input();
    request.start.adjustment = "split_adjusted";
    request.end.adjustment = "split_adjusted";
    request.start.price = 50;
    request.end.price = 60;
    expect(calculatePriceReturn(request).value).toBeCloseTo(0.2, 12);
  });

  it("represents a complete price loss as -1 rather than missing data", () => {
    const request = input();
    request.end.price = 0;
    expect(calculatePriceReturn(request)).toMatchObject({
      value: -1,
      gaps: [],
    });
  });

  it.each([
    {
      case: "currency mismatch",
      change: (request: PriceReturnInput) => {
        request.end.currency = "CNY";
      },
    },
    {
      case: "adjustment mismatch",
      change: (request: PriceReturnInput) => {
        request.end.adjustment = "split_adjusted";
      },
    },
    {
      case: "total-return prices",
      change: (request: PriceReturnInput) => {
        request.start.adjustment = "total_return_adjusted";
        request.end.adjustment = "total_return_adjusted";
      },
    },
    {
      case: "unverified corporate actions",
      change: (request: PriceReturnInput) => {
        request.comparable = false;
      },
    },
  ])("returns an explicit incomparable gap for $case", ({ change }) => {
    const request = input();
    change(request);
    const result = calculatePriceReturn(request);
    expect(result.value).toBeNull();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      code: "incomparable",
      field: "/value",
    });
    expect(result.gaps[0]!.detail.length).toBeGreaterThan(0);
    expect(result.start).toEqual(request.start);
    expect(result.end).toEqual(request.end);
  });

  it.each([
    {
      case: "zero start",
      change: (request: PriceReturnInput) => {
        request.start.price = 0;
      },
    },
    {
      case: "negative end",
      change: (request: PriceReturnInput) => {
        request.end.price = -1;
      },
    },
    {
      case: "nonfinite start",
      change: (request: PriceReturnInput) => {
        request.start.price = Number.NaN;
      },
    },
    {
      case: "nonfinite end",
      change: (request: PriceReturnInput) => {
        request.end.price = Number.POSITIVE_INFINITY;
      },
    },
    {
      case: "reversed requested range",
      change: (request: PriceReturnInput) => {
        request.requestedEndDate = "2024-01-04";
      },
    },
    {
      case: "reversed actual range",
      change: (request: PriceReturnInput) => {
        request.start.date = "2024-01-04";
        request.end.date = "2024-01-03";
      },
    },
    {
      case: "start price after requested date",
      change: (request: PriceReturnInput) => {
        request.start.date = "2024-01-07";
      },
    },
    {
      case: "end price after requested date",
      change: (request: PriceReturnInput) => {
        request.end.date = "2024-01-09";
      },
    },
  ])("rejects $case at the public calculation boundary", ({ change }) => {
    const request = input();
    change(request);
    expect(() => calculatePriceReturn(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});

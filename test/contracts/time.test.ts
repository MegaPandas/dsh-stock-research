import { describe, expect, it } from "vitest";
import { ResearchError, parseISOTime, parseLocalDate } from "../../src/core.js";

describe("parseLocalDate", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-10-25"])(
    "accepts the actual calendar date %s",
    (value) => {
      expect(parseLocalDate(value)).toBe(value);
    },
  );

  it.each([
    "2023-02-29",
    "1900-02-29",
    "2024-04-31",
    "2024-13-01",
    "2024-01-00",
    "2024-1-2",
    "2024-01-02T00:00:00Z",
    null,
    20240102,
  ])("rejects malformed or rolled-over dates: %s", (value) => {
    expect(() => parseLocalDate(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});

describe("parseISOTime", () => {
  it.each([
    ["2024-02-29T16:05:30Z", "2024-02-29T16:05:30.000Z"],
    ["2024-02-29T16:05:30.1Z", "2024-02-29T16:05:30.100Z"],
    ["2024-02-29T16:05:30.12Z", "2024-02-29T16:05:30.120Z"],
    ["2024-02-29T16:05:30.123Z", "2024-02-29T16:05:30.123Z"],
  ])("normalizes %s without changing its instant", (value, expected) => {
    expect(parseISOTime(value)).toBe(expected);
  });

  it.each([
    "2023-02-29T16:05:30Z",
    "2024-02-29T24:00:00Z",
    "2024-02-29T16:60:00Z",
    "2024-02-29T16:05:60Z",
    "2024-02-29T16:05:30.1234Z",
    "2024-02-29T16:05:30+00:00",
    "2024-02-29T16:05:30",
    "2024-02-29",
    null,
  ])("rejects timestamps outside the UTC contract: %s", (value) => {
    expect(() => parseISOTime(value)).toThrowError(ResearchError);
  });
});

it("preserves a source failure's original cause", () => {
  const cause = new Error("connection closed");
  const error = new ResearchError(
    "SOURCE_UNAVAILABLE",
    "Market request failed",
    {
      cause,
    },
  );
  expect(error.cause).toBe(cause);
  expect(error.code).toBe("SOURCE_UNAVAILABLE");
  expect(error).toBeInstanceOf(Error);
});

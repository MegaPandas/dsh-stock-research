import { describe, expect, it } from "vitest";
import { assertJsonValue } from "../../src/json/value.js";

describe("JSON input values", () => {
  it("accepts plain data, null-prototype records and shared non-cyclic values", () => {
    const shared = { text: "研究", numbers: [0, -1, 1.25] };
    const value = {
      first: shared,
      second: shared,
      record: Object.assign(Object.create(null), { flag: true }),
      missing: null,
    };
    const before = structuredClone(value);
    expect(() => assertJsonValue(value, "input")).not.toThrow();
    expect(value).toEqual(before);
    expect(value.first).toBe(value.second);
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    1n,
    Symbol("input"),
    () => 1,
    new Date("2024-01-01"),
    new Map([["value", 1]]),
    new Array(1),
    Object.assign(["finding"], { extra: true }),
    { [Symbol("hidden")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
  ])("rejects nested data that JSON would lose or rewrite: %s", (value) => {
    expect(() => assertJsonValue({ content: value }, "report")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects cycles with a path to the offending value", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => assertJsonValue(value, "report")).toThrowError(
      /report\/self.*lossless JSON/,
    );
  });

  it("rejects accessors without evaluating them", () => {
    const value = Object.defineProperty({}, "finding", {
      enumerable: true,
      get() {
        throw new Error("The getter must not run.");
      },
    });
    expect(() => assertJsonValue(value, "report")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});

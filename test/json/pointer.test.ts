import { describe, expect, it } from "vitest";
import { readPointer, SelectorError } from "../../src/json/pointer.js";

describe("readPointer", () => {
  it("decodes slash and tilde escapes once", () => {
    expect(readPointer({ "a/b": { "~1": 7 } }, "/a~1b/~01")).toEqual({
      value: 7,
      tokens: ["a/b", "~1"],
    });
  });
  it.each(["/01", "/-", "/1e0", "/length"])(
    "rejects noncanonical array index %s",
    (selector) => {
      expect(() => readPointer([1, 2], selector)).toThrow(SelectorError);
    },
  );
  it("reads only own properties", () => {
    expect(() =>
      readPointer(Object.create({ inherited: 1 }), "/inherited"),
    ).toThrow(SelectorError);
  });
  it.each(["field", "/bad~2", "/bad~"])(
    "rejects malformed pointer %s",
    (selector) => {
      expect(() => readPointer({}, selector)).toThrow(SelectorError);
    },
  );
});

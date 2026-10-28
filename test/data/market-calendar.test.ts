import { describe, expect, it } from "vitest";
import { marketFreshnessMs } from "../../src/data/market-calendar.js";
import { CN_SECURITY, US_SECURITY } from "../fixtures/market.js";

const DAY_MS = 86_400_000;

describe("daily market freshness by completed trading date", () => {
  it.each([
    ["2026-10-24T12:00:00.000Z", 0],
    ["2026-10-25T12:00:00.000Z", 0],
    ["2026-10-26T05:00:00.000Z", 0],
    ["2026-10-26T07:30:00.000Z", 1],
    ["2026-10-27T07:30:00.000Z", 2],
  ])(
    "Friday close at %s is behind by %s completed trading dates",
    (cutoff, sessions) => {
      expect(
        marketFreshnessMs(CN_SECURITY, "2026-10-23T07:30:00.000Z", cutoff),
      ).toBe(sessions * DAY_MS);
    },
  );

  it("excludes the CN national holiday and weekend adjustment dates", () => {
    const asOf = "2026-09-30T07:30:00.000Z";
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2026-10-07T15:59:59.999Z"),
    ).toBe(0);
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2026-10-08T07:29:59.999Z"),
    ).toBe(0);
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2026-10-08T07:30:00.000Z"),
    ).toBe(DAY_MS);
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2026-10-11T15:59:59.999Z"),
    ).toBe(2 * DAY_MS);
  });

  it("keeps the last CN close fresh over the full 2024 Spring Festival closure", () => {
    const asOf = "2024-02-08T07:00:00.000Z";
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2024-02-18T15:59:59.999Z"),
    ).toBe(0);
    expect(
      marketFreshnessMs(CN_SECURITY, asOf, "2024-02-19T07:00:00.000Z"),
    ).toBe(DAY_MS);
  });

  it("excludes the extraordinary US mourning closure", () => {
    const asOf = "2025-01-08T21:00:00.000Z";
    expect(
      marketFreshnessMs(US_SECURITY, asOf, "2025-01-09T23:59:59.999Z"),
    ).toBe(0);
    expect(
      marketFreshnessMs(US_SECURITY, asOf, "2025-01-10T21:00:00.000Z"),
    ).toBe(DAY_MS);
  });

  it("excludes Good Friday and the current unfinished US session", () => {
    const asOf = "2026-04-02T20:00:00.000Z";
    expect(
      marketFreshnessMs(US_SECURITY, asOf, "2026-04-06T17:00:00.000Z"),
    ).toBe(0);
    expect(
      marketFreshnessMs(US_SECURITY, asOf, "2026-04-06T20:00:00.000Z"),
    ).toBe(DAY_MS);
  });

  it("counts an early close and uses the offset of each US trading date", () => {
    expect(
      marketFreshnessMs(
        US_SECURITY,
        "2026-11-25T21:00:00.000Z",
        "2026-11-27T17:59:59.999Z",
      ),
    ).toBe(0);
    expect(
      marketFreshnessMs(
        US_SECURITY,
        "2026-11-25T21:00:00.000Z",
        "2026-11-27T18:00:00.000Z",
      ),
    ).toBe(DAY_MS);
    expect(
      marketFreshnessMs(
        US_SECURITY,
        "2026-03-06T21:00:00.000Z",
        "2026-03-09T20:00:00.000Z",
      ),
    ).toBe(DAY_MS);
  });
});

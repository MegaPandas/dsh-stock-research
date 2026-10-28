import type { ISOTime, Security } from "../contracts/data.js";
import { sessionEnd } from "./market-session.js";

const DAY_MS = 86_400_000;
// Exchange notices and exceptional closures are linked in docs/market-sources.md.
const HOLIDAYS = {
  CN: new Set([
    "2024-01-01",
    "2024-02-09",
    "2024-02-12",
    "2024-02-13",
    "2024-02-14",
    "2024-02-15",
    "2024-02-16",
    "2024-04-04",
    "2024-04-05",
    "2024-05-01",
    "2024-05-02",
    "2024-05-03",
    "2024-06-10",
    "2024-09-16",
    "2024-09-17",
    "2024-10-01",
    "2024-10-02",
    "2024-10-03",
    "2024-10-04",
    "2024-10-07",
    "2025-01-01",
    "2025-01-28",
    "2025-01-29",
    "2025-01-30",
    "2025-01-31",
    "2025-02-03",
    "2025-02-04",
    "2025-04-04",
    "2025-05-01",
    "2025-05-02",
    "2025-05-05",
    "2025-06-02",
    "2025-10-01",
    "2025-10-02",
    "2025-10-03",
    "2025-10-06",
    "2025-10-07",
    "2025-10-08",
    "2026-01-01",
    "2026-01-02",
    "2026-02-16",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-02-20",
    "2026-02-23",
    "2026-04-06",
    "2026-05-01",
    "2026-05-04",
    "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-01",
    "2026-10-02",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
  ]),
  US: new Set([
    "2024-01-01",
    "2024-01-15",
    "2024-02-19",
    "2024-03-29",
    "2024-05-27",
    "2024-06-19",
    "2024-07-04",
    "2024-09-02",
    "2024-11-28",
    "2024-12-25",
    "2025-01-01",
    "2025-01-09",
    "2025-01-20",
    "2025-02-17",
    "2025-04-18",
    "2025-05-26",
    "2025-06-19",
    "2025-07-04",
    "2025-09-01",
    "2025-11-27",
    "2025-12-25",
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
  ]),
};

/** One completed trading date consumes one day of the configured freshness budget. */
export function marketFreshnessMs(
  security: Security,
  asOf: ISOTime,
  cutoff: ISOTime,
): number {
  let sessions = 0;
  const cutoffMs = Date.parse(cutoff);
  // CN and US daily session ends retain their exchange date in UTC.
  for (
    let timestamp = Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`) + DAY_MS;
    timestamp <= cutoffMs;
    timestamp += DAY_MS
  ) {
    const day = new Date(timestamp);
    const weekday = day.getUTCDay();
    const date = day.toISOString().slice(0, 10);
    if (
      weekday !== 0 &&
      weekday !== 6 &&
      !HOLIDAYS[security.market].has(date) &&
      sessionEnd(date, security) <= cutoff
    )
      sessions++;
  }
  return sessions * DAY_MS;
}

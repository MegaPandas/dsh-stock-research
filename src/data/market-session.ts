import type { ISOTime, LocalDate, Security } from "../contracts/data.js";

// Published exchange schedules; extending coverage requires checking that year.
export const SESSION_DATES = {
  start: "2024-01-01",
  end: "2026-12-31",
} as const;
const US_EARLY_CLOSE = new Set([
  "2024-07-03",
  "2024-11-29",
  "2024-12-24",
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
]);
const newYorkDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const newYorkHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
});
const CN_ALL_A_AFTER_HOURS = "2026-07-06";

export function usTradingDate(timestampMs: number): LocalDate {
  return newYorkDate.format(timestampMs);
}

export function sessionEnd(date: LocalDate, security: Security): ISOTime {
  if (security.market === "US") {
    // Noon UTC avoids DST transitions; the offset belongs to this trading date.
    const utcOffset =
      12 - Number(newYorkHour.format(new Date(`${date}T12:00:00Z`)));
    const closeHour = US_EARLY_CLOSE.has(date) ? 13 : 16;
    return `${date}T${closeHour + utcOffset}:00:00.000Z`;
  }
  const hasAfterHours =
    date >= CN_ALL_A_AFTER_HOURS ||
    security.symbol.startsWith("688") ||
    security.symbol.startsWith("689") ||
    security.symbol.startsWith("300") ||
    security.symbol.startsWith("301");
  return `${date}T07:${hasAfterHours ? "30" : "00"}:00.000Z`;
}

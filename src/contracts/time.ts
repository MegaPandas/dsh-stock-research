import type { ISOTime, LocalDate } from "./data.js";
import { ResearchError } from "./errors.js";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

/** Validate an external date without allowing Date's calendar rollover. */
export function parseLocalDate(value: unknown): LocalDate {
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
    throw new ResearchError("INVALID_INPUT", "Expected a YYYY-MM-DD date.");
  }
  const time = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString().slice(0, 10) !== value
  ) {
    throw new ResearchError("INVALID_INPUT", `Invalid calendar date: ${value}`);
  }
  return value;
}

/** UTC timestamps use the millisecond precision of the runtime and storage. */
export function parseISOTime(value: unknown): ISOTime {
  if (typeof value !== "string" || !UTC_TIME_PATTERN.test(value)) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Expected a UTC timestamp ending in Z with at most millisecond precision.",
    );
  }
  const time = new Date(value);
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new ResearchError("INVALID_INPUT", `Invalid UTC timestamp: ${value}`);
  }
  return time.toISOString();
}

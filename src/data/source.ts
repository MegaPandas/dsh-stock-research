import { ResearchError } from "../contracts/errors.js";
import { parseLocalDate } from "../contracts/time.js";

export function sourceError(field: string, detail: string): never {
  throw new ResearchError(
    "SOURCE_UNAVAILABLE",
    `Invalid source response at ${field}: ${detail}`,
  );
}

export function sourceObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sourceError(field, "expected an object");
  }
  return value as Record<string, unknown>;
}

export function sourceArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) sourceError(field, "expected an array");
  return value;
}

export function parseSourceJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Source returned invalid JSON.",
      { cause },
    );
  }
  return sourceObject(parsed, "response");
}

export function sourceDate(value: unknown): string {
  try {
    return parseLocalDate(value);
  } catch (cause) {
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Source returned an invalid date.",
      { cause },
    );
  }
}

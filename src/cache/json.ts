import { ResearchError } from "../contracts/errors.js";

export function serializeJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Cache values must be finite JSON data",
    );
  }
  if (ancestors.has(value)) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Cache values must not contain cycles",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ResearchError(
      "INVALID_INPUT",
      "Cache values must not contain symbol properties",
    );
  }

  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new ResearchError(
        "INVALID_INPUT",
        "Cache arrays must contain only indexed JSON values",
      );
    }
    result = `[${Array.from(value, (item: unknown) => serialize(item, ancestors)).join(",")}]`;
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ResearchError(
        "INVALID_INPUT",
        "Cache objects must be plain JSON objects",
      );
    }
    const object = value as Record<string, unknown>;
    result = `{${Object.keys(object)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${serialize(object[key], ancestors)}`,
      )
      .join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

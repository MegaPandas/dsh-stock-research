import { ResearchError } from "../contracts/errors.js";

export function assertJsonValue(value: unknown, label: string): void {
  visit(value, label, new Set());
}

function invalid(path: string): never {
  throw new ResearchError(
    "INVALID_INPUT",
    `${path} must be lossless JSON data.`,
  );
}

function visit(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid(path);
    return;
  }
  if (typeof value !== "object") invalid(path);
  if (ancestors.has(value)) invalid(path);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    invalid(path);
  const keys = Reflect.ownKeys(value);
  if (array) {
    if (keys.length !== value.length + 1) invalid(path);
    for (let index = 0; index < value.length; index++)
      if (keys[index] !== String(index)) invalid(path);
  }
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      invalid(path);
    visit(descriptor.value, `${path}/${key}`, ancestors);
  }
  ancestors.delete(value);
}

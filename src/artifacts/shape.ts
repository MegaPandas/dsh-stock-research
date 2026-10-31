import { ResearchError } from "../contracts/errors.js";

export type ObjectValue = Record<string, unknown>;
export type Check = (value: unknown, path: string) => void;
export function invalid(path: string, detail: string): never {
  throw new ResearchError("INVALID_ARTIFACT", `${path}: ${detail}`);
}
export function object(
  value: unknown,
  path: string,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(path, "expected an object");
  const item = value as ObjectValue;
  for (const key of keys)
    if (!Object.hasOwn(item, key)) invalid(`${path}/${key}`, "required field");
  for (const key of Object.keys(item))
    if (!keys.includes(key) && !optionalKeys.includes(key))
      invalid(`${path}/${key}`, "unknown field");
  return item;
}
export const string: Check = (value, path) => {
  if (typeof value !== "string") invalid(path, "expected a string");
};
export const text: Check = (value, path) => {
  string(value, path);
  if ((value as string).trim() === "") invalid(path, "expected nonempty text");
};
export function list(
  value: unknown,
  path: string,
  check: Check,
  minimum = 0,
): void {
  if (!Array.isArray(value) || value.length < minimum)
    invalid(path, `expected an array of at least ${minimum} items`);
  value.forEach((item, index) => check(item, `${path}/${index}`));
}

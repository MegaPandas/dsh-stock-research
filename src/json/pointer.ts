export class SelectorError extends Error {}

function bad(detail: string): never {
  throw new SelectorError(detail);
}

export function readPointer(
  value: unknown,
  selector: string,
): { value: unknown; tokens: string[] } {
  if (selector === "") return { value, tokens: [] };
  if (!selector.startsWith("/"))
    bad("A selector must be an absolute JSON Pointer.");
  const tokens = selector
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token)) bad("Invalid JSON Pointer escape.");
      return token.replace(/~[01]/g, (escape) => (escape === "~0" ? "~" : "/"));
    });
  let current = value;
  for (const token of tokens) {
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(token))
      bad("Invalid array index.");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, token)
    )
      bad("The selector does not identify an existing field.");
    current = (current as Record<string, unknown>)[token];
  }
  return { value: current, tokens };
}

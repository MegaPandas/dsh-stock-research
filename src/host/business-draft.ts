import { ResearchError } from "../contracts/errors.js";

export function parseBusinessJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new ResearchError(
      "INVALID_INPUT",
      `Invalid business JSON syntax: ${(cause as SyntaxError).message.split(', "')[0]}`,
      { cause },
    );
  }
}

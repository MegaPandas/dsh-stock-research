import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { securityFor, scopeAtDate } from "./research-scope.js";
import type { RunDefinition } from "../contracts/workflow.js";

export interface AskInput {
  scope: ResearchScope;
  question: string;
}

export interface ResearchInput {
  security: string;
  scope: ResearchScope;
}

/** Parse only at the human command boundary; downstream tools inherit this scope. */
export function parseAskInput(rawInput: string, startedAt: Date): AskInput {
  const match = /^\s*(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      "Usage: /stock-ask <exchange.symbol> <YYYY-MM-DD> <question>",
    );
  return {
    scope: researchScope(match[1]!, match[2]!, startedAt),
    question: match[3]!.trim(),
  };
}

export function parseResearchInput(
  rawInput: string,
  startedAt: Date,
  mode: RunDefinition["mode"],
): ResearchInput {
  const match = /^\s*(\S+)\s+(\S+)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      `Usage: /stock-${mode} <exchange.symbol> <YYYY-MM-DD>`,
    );
  return {
    security: match[1]!,
    scope: researchScope(match[1]!, match[2]!, startedAt),
  };
}

function researchScope(
  symbol: string,
  inputDate: string,
  startedAt: Date,
): ResearchScope {
  return scopeAtDate(securityFor(symbol), inputDate, startedAt);
}

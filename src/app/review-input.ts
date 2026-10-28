import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { RunService } from "../services/runs.js";
import { scopeAtDate } from "./ask-input.js";

export interface ReviewInput {
  runId: string;
  scope: ResearchScope;
  originalScope: ResearchScope;
  question: string;
}

export function parseReviewInput(
  rawInput: string,
  startedAt: Date,
  runs: RunService,
): ReviewInput {
  const match = /^\s*(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/.exec(rawInput);
  if (match === null)
    throw new ResearchError(
      "INVALID_INPUT",
      "Usage: /stock-review <runId> <YYYY-MM-DD> <question>",
    );
  const runId = match[1]!;
  const originalScope = runs.readDefinition(runId).scope;
  return {
    runId,
    scope: scopeAtDate(originalScope.security, match[2]!, startedAt),
    originalScope,
    question: match[3]!.trim(),
  };
}

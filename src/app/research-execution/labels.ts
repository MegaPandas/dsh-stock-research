import type { ResearchScope } from "../../contracts/data.js";
import type { RunDefinition } from "../../contracts/workflow.js";

export function researchStartLabel(
  scope: ResearchScope,
  mode: RunDefinition["mode"],
): string {
  return `${scope.security.symbol} · ${mode === "quick" ? "快速研究" : "深度研究"} · ${scope.date}`;
}

export function researchContinueLabel(runId: string): string {
  return `继续研究 ${runId}`;
}

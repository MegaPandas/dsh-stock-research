import type { DigestDraft, DigestModelInput } from "../contracts/digests.js";
import type { AgentReport } from "../contracts/agent-reports.js";

/** Bind the business report to fixed upstream versions outside model output. */
export function digestBusinessDraft(
  report: AgentReport<"digest">,
  input: DigestModelInput,
): DigestDraft {
  return structuredClone({
    report,
    title: `${input.scope.security.symbol} ${input.taskId}摘要`,
    body: report.summary,
    inputRefs: input.artifacts.map((artifact) => artifact.ref),
    facts: report.content.keyPoints.map((text) => ({
      text,
      inputRefs: [],
      numbers: [],
    })),
    disagreements: report.content.disagreements,
    riskSummaries: report.content.riskSummaries,
  });
}

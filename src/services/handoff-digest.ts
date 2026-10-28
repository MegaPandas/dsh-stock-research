import {
  DIGEST_MAX_CHARACTERS,
  DIGEST_TARGET_CHARACTERS,
  type AgentReport,
} from "../contracts/agent-reports.js";
import type { ResearchArtifactInput } from "../contracts/artifact-payloads.js";
import type { ArtifactRef } from "../contracts/data.js";
import type { DigestDraft, DigestModelInput } from "../contracts/digests.js";
import { ResearchError } from "../contracts/errors.js";
import type { StageHandoff } from "../contracts/stage-handoff.js";
import { parseAgentReport } from "./agent-reports.js";
import { artifactKey } from "./run-dependencies.js";

/** Assemble accepted role handoffs without generating another interpretation. */
export function handoffDigest(input: DigestModelInput): DigestDraft {
  const facts = new Map<string, ArtifactRef[]>();
  const disagreements = new Set<string>();
  const openQuestions = new Set<string>();
  const riskTexts = new Map<string, string>();
  const contributions: string[] = [];
  const append = (text: string, ref: ArtifactRef) => {
    const refs = facts.get(text) ?? [];
    if (!refs.some((known) => artifactKey(known) === artifactKey(ref)))
      refs.push(ref);
    facts.set(text, refs);
  };
  const retainRisk = (issueId: string, text: string) => {
    const prior = riskTexts.get(issueId);
    if (prior !== undefined && prior !== text)
      throw new ResearchError(
        "DATA_INSUFFICIENT",
        `Conflicting accepted handoffs for risk ${issueId}.`,
      );
    riskTexts.set(issueId, text);
  };
  for (const version of input.artifacts) {
    const artifact = version.content as ResearchArtifactInput;
    // Prior stage text remains available through the fixed report catalog.
    // Only required risk handoffs are carried forward automatically.
    if (artifact.kind === "digest") {
      if (artifact.payload.report === undefined)
        throw new ResearchError(
          "VERSION_UNAVAILABLE",
          `Task ${version.taskId} has no structured digest handoff.`,
        );
      for (const risk of artifact.payload.report.content.riskSummaries)
        retainRisk(risk.issueId, risk.text);
      continue;
    }
    const handoff = (artifact.payload as { stageHandoff?: StageHandoff })
      .stageHandoff;
    if (handoff === undefined)
      throw new ResearchError(
        "INVALID_INPUT",
        `Task ${version.taskId} has no stageHandoff; ask the original role to submit its structured handoff.`,
      );
    const prefix = `[${version.taskId}] `;
    for (const point of handoff.keyPoints)
      append(`${prefix}${point}`, version.ref);
    for (const point of handoff.disagreements)
      disagreements.add(`${prefix}${point}`);
    for (const point of handoff.openQuestions)
      openQuestions.add(`${prefix}${point}`);
    if (artifact.kind === "risk") {
      artifact.payload.issues.forEach((risk, index) => {
        const text = handoff.risks[index];
        if (text === undefined)
          throw new ResearchError(
            "INVALID_INPUT",
            `Task ${version.taskId} has no handoff for risk ${risk.issueId}; retain one risk handoff per submitted issue in order.`,
          );
        retainRisk(risk.issueId, text);
      });
    } else {
      for (const point of handoff.risks)
        append(`${prefix}风险：${point}`, version.ref);
    }
    contributions.push(
      `${version.taskId}=${[...JSON.stringify(handoff)].length}`,
    );
  }
  const report: AgentReport<"digest"> = {
    summary: `${input.taskId}阶段交接；各项判断保留原角色归属，完整报告按目录读取。`,
    content: {
      keyPoints: [...facts.keys()],
      disagreements: [...disagreements],
      riskSummaries: input.risks.map((risk) => {
        const text = riskTexts.get(risk.issueId);
        if (text === undefined)
          throw new ResearchError(
            "INVALID_INPUT",
            `Missing accepted handoff for risk ${risk.issueId}; ask its original role to provide the impact, trigger and constraint.`,
          );
        return { issueId: risk.issueId, text };
      }),
      openQuestions: [...openQuestions],
    },
  };
  const length = [...JSON.stringify(report)].length;
  if (length > DIGEST_MAX_CHARACTERS)
    throw new ResearchError(
      "INVALID_INPUT",
      `Stage handoff JSON: ${length}/${DIGEST_MAX_CHARACTERS} Unicode characters (target ${DIGEST_TARGET_CHARACTERS}, over by ${length - DIGEST_MAX_CHARACTERS}). Role contributions before attribution: ${contributions.join(", ")}; riskSummaries=${[...JSON.stringify(report.content.riskSummaries)].length}. Ask the original roles to compress their handoffs while retaining conditions, opposing views and every required risk; no content was truncated.`,
    );
  return structuredClone({
    report: parseAgentReport("digest", report),
    title: `${input.scope.security.symbol} ${input.taskId}交接摘要`,
    body: report.summary,
    inputRefs: input.artifacts.map(({ ref }) => ref),
    facts: [...facts].map(([text, inputRefs]) => ({
      text,
      inputRefs,
      numbers: [],
    })),
    disagreements: report.content.disagreements,
    riskSummaries: report.content.riskSummaries,
  });
}

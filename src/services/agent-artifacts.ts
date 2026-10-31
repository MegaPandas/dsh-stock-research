import type { AgentReport } from "../contracts/agent-reports.js";
import type { ResearchArtifactInput } from "../contracts/artifact-payloads.js";
import type { NumericClaim } from "../contracts/artifacts.js";
import type { ArtifactRef, ResearchScope } from "../contracts/data.js";
import type { StageHandoff } from "../contracts/stage-handoff.js";
import { renderAgentReport } from "../report/agent-report.js";
import { decisionPolicy, priceRating } from "../valuation/rating-policy.js";

type ResearchReportKind =
  "analysis" | "debate" | "risk" | "plan" | "decision_draft";

interface AgentArtifactContext {
  taskId: string;
  specialty: string;
  title: string;
  inputRefs: ArtifactRef[];
  currency: string;
  scope: ResearchScope;
  referencePrice: { artifact: ArtifactRef; claim: NumericClaim } | null;
}

const statement = (text: string) => ({ text, evidence: [], numbers: [] });

/** Assemble a validated role report; ArtifactService owns final submission validation. */
export function assembleAgentArtifact(
  kind: ResearchReportKind,
  report: AgentReport<ResearchReportKind>,
  context: AgentArtifactContext,
  claims: NumericClaim[] = [],
  stageHandoff?: StageHandoff,
): ResearchArtifactInput {
  const envelope = { title: context.title, inputRefs: context.inputRefs };
  const handoff = stageHandoff === undefined ? {} : { stageHandoff };
  if (kind === "analysis") {
    const analysis = report as AgentReport<"analysis">;
    return {
      ...envelope,
      kind,
      body: renderAgentReport(kind, analysis),
      claims,
      payload: { schemaVersion: 3, report: analysis, ...handoff },
    };
  }
  if (kind === "debate") {
    const debate = report as AgentReport<"debate">;
    return {
      ...envelope,
      kind,
      body: renderAgentReport(kind, debate),
      claims,
      payload: {
        schemaVersion: 3,
        side: context.specialty as "bull" | "bear",
        report: debate,
        ...handoff,
      },
    };
  }
  if (kind === "risk") {
    const risk = report as AgentReport<"risk">;
    const issues = risk.content.issues.map((issue, index) => ({
      ...issue,
      issueId: `${context.taskId}.${index + 1}`,
      evidence: [],
      numbers: [],
    }));
    return {
      ...envelope,
      kind,
      body: renderAgentReport(kind, risk, {
        riskIssueIds: issues.map(({ issueId }) => issueId),
      }),
      claims: [],
      payload: { issues, report: risk, ...handoff },
    };
  }
  if (kind === "plan") {
    const plan = report as AgentReport<"plan">;
    return {
      ...envelope,
      kind,
      body: renderAgentReport(kind, plan),
      claims: [],
      payload: {
        thesis: [statement(plan.summary)],
        questions: plan.content.questions.map(
          ({ question, whyItMatters, nextStep }) =>
            `${question}：${whyItMatters}；研究路径：${nextStep}`,
        ),
        constraints: plan.content.constraints,
        report: plan,
        ...handoff,
      },
    };
  }
  const decision = report as AgentReport<"decision_draft">;
  const {
    targetPrice,
    thesis,
    risks,
    riskResponses,
    invalidationConditions,
    limitations,
  } = decision.content;
  const policy = decisionPolicy(context.scope.date);
  return {
    ...envelope,
    kind,
    body: renderAgentReport(kind, decision),
    claims:
      targetPrice === null
        ? []
        : [
            {
              id: "decision.target",
              kind: "estimated",
              value: targetPrice.value,
              unit: `${context.currency}/share`,
              method: targetPrice.method,
              assumptions: targetPrice.assumptions,
              evidence: [],
              ...(targetPrice.calculationId === undefined
                ? {}
                : { calculationId: targetPrice.calculationId }),
            },
          ],
    payload: {
      rating: priceRating(
        context.referencePrice?.claim.value ?? null,
        targetPrice?.value ?? null,
      ),
      horizonEndDate: policy.horizonEndDate,
      thesis: thesis.map(statement),
      basePrice:
        context.referencePrice === null
          ? null
          : {
              kind: "artifact",
              artifact: context.referencePrice.artifact,
              claimId: context.referencePrice.claim.id,
            },
      targetPrice:
        targetPrice === null
          ? null
          : { kind: "local", claimId: "decision.target" },
      risks,
      riskResponses,
      invalidationConditions,
      limitations,
      ratingPolicy: policy.version,
      report: decision,
      ...handoff,
    },
  };
}

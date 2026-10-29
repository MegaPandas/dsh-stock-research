import type {
  DecisionProposal,
  ResearchArtifactInput,
  RiskIssue,
} from "../contracts/artifact-payloads.js";
import type { NumericClaim } from "../contracts/artifacts.js";
import type { AgentReport } from "../contracts/agent-reports.js";
import type { StageHandoff } from "../contracts/stage-handoff.js";
import { renderAgentReport } from "../report/agent-report.js";
import type { ArtifactRef, ResearchScope } from "../contracts/data.js";
import { decisionPolicy, priceRating } from "../contracts/rating-policy.js";
import { assembleDebate, parseAnalysisReport } from "./analysis-report.js";
import { parseArtifactInput } from "./artifact-schema.js";
import { invalid, list, object, text } from "./artifact-shape.js";

type BusinessRisk = Omit<RiskIssue, "issueId" | "evidence" | "numbers">;
type TargetPrice = {
  value: number;
  method: string;
  assumptions: string[];
  calculationId?: string;
};
type BusinessDecision = Omit<
  DecisionProposal,
  "thesis" | "basePrice" | "targetPrice"
> & { thesis: string[]; targetPrice: TargetPrice | null };
export type BusinessRoleKind = "debate" | "risk" | "plan" | "decision_draft";
export interface BusinessReportContext {
  kind: BusinessRoleKind;
  taskId: string;
  specialty: string;
  title: string;
  inputRefs: ArtifactRef[];
  currency: string;
  referencePrice: {
    artifact: ArtifactRef;
    claim: NumericClaim;
  } | null;
}

const riskKeys = [
  "description",
  "impact",
  "trigger",
  "constraint",
  "recommendation",
] as const;
const decisionKeys = [
  "rating",
  "horizonEndDate",
  "thesis",
  "targetPrice",
  "risks",
  "riskResponses",
  "invalidationConditions",
  "limitations",
] as const;
const strings = (value: unknown, path: string) => list(value, path, text);
function sections(title: string, items: readonly string[]): string {
  return items.length === 0
    ? ""
    : `\n\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function assembleBusinessReport(
  value: unknown,
  context: BusinessReportContext,
): ResearchArtifactInput {
  const { kind, title, inputRefs } = context;
  if (kind === "debate") {
    if (context.specialty !== "bull" && context.specialty !== "bear")
      invalid("debate/side", "expected the task to select bull or bear");
    return assembleDebate(
      parseAnalysisReport(value, "debate"),
      title,
      inputRefs,
      context.specialty,
    );
  }
  const statement = (text: string) => ({
    text,
    evidence: [],
    numbers: [],
  });
  let payload: unknown;
  let body: string;
  const claims: NumericClaim[] = [];
  if (kind === "risk") {
    const item = object(value, "risk", ["issues"]);
    list(item.issues, "risk/issues", (value, path) => {
      const issue = object(value, path, riskKeys);
      for (const key of riskKeys) text(issue[key], `${path}/${key}`);
    });
    const issues = (item.issues as BusinessRisk[]).map((issue, index) => ({
      ...issue,
      issueId: `${context.taskId}.${index + 1}`,
      evidence: [],
      numbers: [],
    }));
    payload = { issues };
    body =
      issues.length === 0
        ? "当前未识别出需要单独处置的风险。"
        : issues
            .map(
              (issue) =>
                `## ${issue.issueId}：${issue.description}\n\n影响：${issue.impact}\n\n触发条件：${issue.trigger}\n\n约束：${issue.constraint}\n\n建议：${issue.recommendation}`,
            )
            .join("\n\n");
  } else if (kind === "plan") {
    const item = object(value, "plan", ["thesis", "questions", "constraints"]);
    list(item.thesis, "plan/thesis", text, 1);
    strings(item.questions, "plan/questions");
    strings(item.constraints, "plan/constraints");
    const plan = item as {
      thesis: string[];
      questions: string[];
      constraints: string[];
    };
    payload = { ...plan, thesis: plan.thesis.map(statement) };
    body =
      plan.thesis.join("\n\n") +
      sections("研究问题", plan.questions) +
      sections("研究约束", plan.constraints);
  } else {
    const item = object(value, "decision", decisionKeys);
    list(item.thesis, "decision/thesis", text);
    if (item.targetPrice !== null) {
      const target = object(
        item.targetPrice,
        "decision/targetPrice",
        ["value", "method", "assumptions"],
        ["calculationId"],
      );
      text(target.method, "decision/targetPrice/method");
      list(target.assumptions, "decision/targetPrice/assumptions", text, 1);
      claims.push({
        id: "decision.target",
        kind: "estimated",
        value: target.value as number,
        unit: `${context.currency}/share`,
        method: target.method as string,
        assumptions: target.assumptions as string[],
        evidence: [],
        ...(target.calculationId === undefined
          ? {}
          : { calculationId: target.calculationId as string }),
      });
    }
    const decision = item as BusinessDecision;
    payload = {
      ...decision,
      thesis: decision.thesis.map(statement),
      basePrice:
        context.referencePrice === null
          ? null
          : {
              kind: "artifact",
              artifact: context.referencePrice.artifact,
              claimId: context.referencePrice.claim.id,
            },
      targetPrice:
        decision.targetPrice === null
          ? null
          : { kind: "local", claimId: "decision.target" },
    };
    body = decision.thesis.join("\n\n") || "决策结果见业务字段。";
  }
  const content = parseArtifactInput({
    kind,
    title,
    body,
    inputRefs,
    claims,
    payload,
  });
  return structuredClone(content);
}

export function assembleAgentArtifact(
  kind: "analysis" | BusinessRoleKind,
  report: AgentReport<"analysis" | BusinessRoleKind>,
  context: Omit<BusinessReportContext, "kind"> & { scope: ResearchScope },
  claims: NumericClaim[] = [],
  stageHandoff?: StageHandoff,
): ResearchArtifactInput {
  if (kind === "analysis" || kind === "debate") {
    return parseArtifactInput({
      kind,
      title: context.title,
      body:
        kind === "analysis"
          ? renderAgentReport("analysis", report as AgentReport<"analysis">)
          : renderAgentReport("debate", report as AgentReport<"debate">),
      inputRefs: context.inputRefs,
      claims,
      payload: {
        schemaVersion: 3,
        ...(kind === "debate" ? { side: context.specialty } : {}),
        report,
        ...(stageHandoff === undefined ? {} : { stageHandoff }),
      },
    });
  }
  const value =
    kind === "plan"
      ? {
          thesis: [report.summary],
          questions: (report as AgentReport<"plan">).content.questions.map(
            ({ question, whyItMatters, nextStep }) =>
              `${question}：${whyItMatters}；研究路径：${nextStep}`,
          ),
          constraints: (report as AgentReport<"plan">).content.constraints,
        }
      : kind === "decision_draft"
        ? {
            ...Object.fromEntries(
              Object.entries(report.content).filter(
                ([key]) => key !== "valuation",
              ),
            ),
            rating: priceRating(
              context.referencePrice?.claim.value ?? null,
              (report as AgentReport<"decision_draft">).content.targetPrice
                ?.value ?? null,
            ),
            horizonEndDate: decisionPolicy(context.scope.date).horizonEndDate,
          }
        : report.content;
  const artifact = assembleBusinessReport(value, { ...context, kind });
  return parseArtifactInput({
    ...artifact,
    body:
      kind === "risk"
        ? renderAgentReport("risk", report as AgentReport<"risk">, {
            riskIssueIds: (
              artifact as Extract<ResearchArtifactInput, { kind: "risk" }>
            ).payload.issues.map(({ issueId }) => issueId),
          })
        : renderAgentReport(kind, report as AgentReport<typeof kind>),
    payload: {
      ...artifact.payload,
      report,
      ...(stageHandoff === undefined ? {} : { stageHandoff }),
      ...(kind === "decision_draft"
        ? { ratingPolicy: decisionPolicy(context.scope.date).version }
        : {}),
    },
  });
}

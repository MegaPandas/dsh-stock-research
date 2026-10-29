import type { ResearchArtifactInput } from "../contracts/artifact-payloads.js";
import { ResearchError } from "../contracts/errors.js";
import { parseISOTime, parseLocalDate } from "../contracts/time.js";
import { parseAnalysisReport } from "./analysis-report.js";
import { validateStoredAgentReport } from "./agent-reports.js";
import { PRICE_RATING_POLICY } from "../contracts/rating-policy.js";
import { parseStageHandoff } from "./stage-handoff.js";
import {
  invalid,
  list,
  object,
  string,
  text,
  type Check,
  type ObjectValue,
} from "./artifact-shape.js";
export { list, object, text } from "./artifact-shape.js";
const numeric: Check = (value, path) => {
  if (typeof value !== "number") invalid(path, "expected a number");
};
function choice(
  value: unknown,
  path: string,
  choices: readonly unknown[],
): void {
  if (!choices.includes(value))
    invalid(path, `expected ${choices.join(" | ")}`);
}
const texts: Check = (value, path) => list(value, path, text);
export const artifactRef: Check = (value, path) => {
  const item = object(value, path, ["runId", "artifactId", "revision"]);
  text(item.runId, `${path}/runId`);
  text(item.artifactId, `${path}/artifactId`);
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1)
    invalid(`${path}/revision`, "expected a positive revision");
};
const sourceRef: Check = (value, path) => {
  const item = object(value, path, ["runId", "evidenceId", "selector"]);
  text(item.runId, `${path}/runId`);
  text(item.evidenceId, `${path}/evidenceId`);
  string(item.selector, `${path}/selector`);
};
const numberInput: Check = (value, path) => {
  const kind = (value as ObjectValue | null)?.kind;
  choice(kind, `${path}/kind`, ["local", "artifact"]);
  const item = object(
    value,
    path,
    kind === "local" ? ["kind", "claimId"] : ["kind", "artifact", "claimId"],
  );
  text(item.claimId, `${path}/claimId`);
  if (kind === "artifact") artifactRef(item.artifact, `${path}/artifact`);
};
function supports(item: ObjectValue, path: string): void {
  list(item.evidence, `${path}/evidence`, (value, location) => {
    if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "artifactId")
    )
      artifactRef(value, location);
    else sourceRef(value, location);
  });
  list(item.numbers, `${path}/numbers`, numberInput);
}
const statement: Check = (value, path) => {
  const item = object(value, path, ["text", "evidence", "numbers"]);
  text(item.text, `${path}/text`);
  supports(item, path);
};
const risk: Check = (value, path) => {
  const keys = [
    "issueId",
    "description",
    "impact",
    "trigger",
    "constraint",
    "recommendation",
  ];
  const item = object(value, path, [...keys, "evidence", "numbers"]);
  for (const key of keys) text(item[key], `${path}/${key}`);
  supports(item, path);
};
function uniqueIssues(items: unknown, path: string): void {
  const ids = (items as ObjectValue[]).map((item) => item.issueId);
  if (new Set(ids).size !== ids.length) invalid(path, "issueId must be unique");
}
const gap: Check = (value, path) => {
  const item = object(value, path, ["code", "field", "detail"]);
  choice(item.code, `${path}/code`, [
    "missing",
    "stale",
    "unverified_time",
    "incomparable",
  ]);
  text(item.field, `${path}/field`);
  text(item.detail, `${path}/detail`);
};
const gaps: Check = (value, path) => list(value, path, gap);
const reportedGap: Check = (value, location) => {
  const kind = (value as ObjectValue | null)?.kind;
  choice(kind, `${location}/kind`, ["source", "artifact"]);
  const entry = object(value, location, [
    "kind",
    kind === "source" ? "source" : "artifact",
    "gap",
  ]);
  if (kind === "source") sourceRef(entry.source, `${location}/source`);
  else artifactRef(entry.artifact, `${location}/artifact`);
  gap(entry.gap, `${location}/gap`);
};
const PROPOSAL_KEYS = [
  "rating",
  "horizonEndDate",
  "thesis",
  "basePrice",
  "targetPrice",
  "risks",
  "riskResponses",
  "invalidationConditions",
  "limitations",
];
const RESULT_KEYS = [
  ...PROPOSAL_KEYS,
  "schemaVersion",
  "runId",
  "securityId",
  "cutoff",
  "draftRef",
  "inputRefs",
  "computedReturn",
  "validation",
  "finalizedAt",
];
function date(value: unknown, path: string, timestamp: boolean): void {
  try {
    if (timestamp) parseISOTime(value);
    else parseLocalDate(value);
  } catch (cause) {
    throw new ResearchError(
      "INVALID_ARTIFACT",
      `${path}: invalid ${timestamp ? "UTC time" : "date"}`,
      { cause },
    );
  }
}
function proposal(item: ObjectValue, path: string): void {
  if (item.stageHandoff !== undefined) parseStageHandoff(item.stageHandoff);
  if (item.report !== undefined)
    validateStoredAgentReport("decision_draft", item.report);
  if (item.ratingPolicy !== undefined)
    choice(item.ratingPolicy, `${path}/ratingPolicy`, [PRICE_RATING_POLICY]);
  if (item.rating !== null)
    choice(item.rating, `${path}/rating`, [
      "strong_buy",
      "buy",
      "hold",
      "sell",
      "strong_sell",
      "overweight",
      "neutral",
      "underweight",
    ]);
  date(item.horizonEndDate, `${path}/horizonEndDate`, false);
  list(item.thesis, `${path}/thesis`, statement, item.rating === null ? 0 : 1);
  if (item.basePrice !== null) numberInput(item.basePrice, `${path}/basePrice`);
  if (item.targetPrice !== null)
    numberInput(item.targetPrice, `${path}/targetPrice`);
  texts(item.risks, `${path}/risks`);
  texts(item.invalidationConditions, `${path}/invalidationConditions`);
  texts(item.limitations, `${path}/limitations`);
  list(item.riskResponses, `${path}/riskResponses`, (value, location) => {
    const response = object(value, location, [
      "issueId",
      "disposition",
      "reason",
    ]);
    text(response.issueId, `${location}/issueId`);
    text(response.reason, `${location}/reason`);
    choice(response.disposition, `${location}/disposition`, [
      "accepted",
      "mitigated",
      "constrained",
      "unresolved",
    ]);
  });
  uniqueIssues(item.riskResponses, `${path}/riskResponses`);
}
const result: Check = (value, path) => {
  const item = object(value, path, RESULT_KEYS, [
    "report",
    "ratingPolicy",
    "stageHandoff",
  ]);
  proposal(item, path);
  choice(item.schemaVersion, `${path}/schemaVersion`, [1]);
  text(item.runId, `${path}/runId`);
  text(item.securityId, `${path}/securityId`);
  date(item.cutoff, `${path}/cutoff`, true);
  date(item.finalizedAt, `${path}/finalizedAt`, true);
  artifactRef(item.draftRef, `${path}/draftRef`);
  list(item.inputRefs, `${path}/inputRefs`, artifactRef);
  if (item.computedReturn !== null) {
    numeric(item.computedReturn, `${path}/computedReturn`);
    if (!Number.isFinite(item.computedReturn))
      invalid(`${path}/computedReturn`, "expected a finite return");
  }
  const validation = object(item.validation, `${path}/validation`, [
    "checkedRefs",
    "warnings",
  ]);
  list(validation.checkedRefs, `${path}/validation/checkedRefs`, artifactRef);
  texts(validation.warnings, `${path}/validation/warnings`);
};
function payload(kind: unknown, value: unknown, path: string): void {
  switch (kind) {
    case "analysis": {
      if (
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value
      ) {
        const { schemaVersion, ...report } = value as Record<string, unknown>;
        choice(schemaVersion, `${path}/schemaVersion`, [2, 3]);
        if (schemaVersion === 3) {
          object(
            report,
            path,
            ["report"],
            ["publicSearchAsOf", "stageHandoff"],
          );
          if (report.stageHandoff !== undefined)
            parseStageHandoff(report.stageHandoff);
          if (report.publicSearchAsOf !== undefined)
            date(report.publicSearchAsOf, `${path}/publicSearchAsOf`, true);
          validateStoredAgentReport("analysis", report.report);
        } else parseAnalysisReport(report, path);
        return;
      }
      const item = object(value, path, ["findings", "risks", "gaps"]);
      list(item.findings, `${path}/findings`, statement, 1);
      texts(item.risks, `${path}/risks`);
      gaps(item.gaps, `${path}/gaps`);
      return;
    }
    case "debate": {
      if (
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value
      ) {
        const { schemaVersion, side, ...report } = value as Record<
          string,
          unknown
        >;
        choice(schemaVersion, `${path}/schemaVersion`, [2, 3]);
        choice(side, `${path}/side`, ["bull", "bear"]);
        if (schemaVersion === 3) {
          object(report, path, ["report"], ["stageHandoff"]);
          if (report.stageHandoff !== undefined)
            parseStageHandoff(report.stageHandoff);
          validateStoredAgentReport("debate", report.report);
        } else parseAnalysisReport(report, path);
        return;
      }
      const item = object(value, path, [
        "side",
        "arguments",
        "rebuttals",
        "unresolved",
      ]);
      choice(item.side, `${path}/side`, ["bull", "bear"]);
      list(item.arguments, `${path}/arguments`, statement, 1);
      list(item.rebuttals, `${path}/rebuttals`, (value, location) => {
        const reply = object(value, location, [
          "target",
          "text",
          "evidence",
          "numbers",
        ]);
        artifactRef(reply.target, `${location}/target`);
        text(reply.text, `${location}/text`);
        supports(reply, location);
      });
      texts(item.unresolved, `${path}/unresolved`);
      return;
    }
    case "risk": {
      const item = object(value, path, ["issues"], ["report", "stageHandoff"]);
      if (item.stageHandoff !== undefined) parseStageHandoff(item.stageHandoff);
      if (item.report !== undefined)
        validateStoredAgentReport("risk", item.report);
      list(item.issues, `${path}/issues`, risk);
      uniqueIssues(item.issues, `${path}/issues`);
      return;
    }
    case "plan": {
      const item = object(
        value,
        path,
        ["thesis", "questions", "constraints"],
        ["report", "stageHandoff"],
      );
      if (item.stageHandoff !== undefined) parseStageHandoff(item.stageHandoff);
      if (item.report !== undefined)
        validateStoredAgentReport("plan", item.report);
      list(item.thesis, `${path}/thesis`, statement, 1);
      texts(item.questions, `${path}/questions`);
      texts(item.constraints, `${path}/constraints`);
      return;
    }
    case "digest": {
      const item = object(
        value,
        path,
        ["facts", "disagreements", "risks", "gaps", "upstreamRefs", "numbers"],
        ["report"],
      );
      if (item.report !== undefined)
        validateStoredAgentReport("digest", item.report);
      list(item.facts, `${path}/facts`, statement);
      texts(item.disagreements, `${path}/disagreements`);
      list(item.risks, `${path}/risks`, risk);
      uniqueIssues(item.risks, `${path}/risks`);
      list(item.gaps, `${path}/gaps`, reportedGap);
      list(item.upstreamRefs, `${path}/upstreamRefs`, artifactRef);
      list(item.numbers, `${path}/numbers`, (value, location) => {
        numberInput(value, location);
        choice((value as ObjectValue).kind, `${location}/kind`, ["artifact"]);
      });
      return;
    }
    case "decision_draft":
      proposal(
        object(value, path, PROPOSAL_KEYS, [
          "report",
          "ratingPolicy",
          "stageHandoff",
        ]),
        path,
      );
      return;
    case "decision":
      result(value, path);
      return;
    case "report": {
      const item = object(value, path, [
        "sections",
        "digests",
        "decision",
        "limitations",
        "gaps",
      ]);
      list(item.sections, `${path}/sections`, artifactRef);
      list(item.digests, `${path}/digests`, artifactRef);
      result(item.decision, `${path}/decision`);
      texts(item.limitations, `${path}/limitations`);
      list(item.gaps, `${path}/gaps`, reportedGap);
      return;
    }
    default:
      invalid(path, "unknown artifact kind");
  }
}
const claim: Check = (value, path) => {
  const kind = (value as ObjectValue | null)?.kind;
  choice(kind, `${path}/kind`, ["observed", "calculated", "estimated"]);
  const fields =
    kind === "observed"
      ? ["source"]
      : kind === "calculated"
        ? ["operation", "inputs"]
        : ["method", "assumptions", "evidence"];
  const item = object(
    value,
    path,
    ["id", "kind", "value", "unit", ...fields],
    kind === "estimated" ? ["calculationId"] : [],
  );
  text(item.id, `${path}/id`);
  if (/[{}]/.test(item.id as string))
    invalid(`${path}/id`, "braces cannot appear in claim identifiers");
  numeric(item.value, `${path}/value`);
  text(item.unit, `${path}/unit`);
  if (kind === "observed") sourceRef(item.source, `${path}/source`);
  else if (kind === "calculated") {
    choice(item.operation, `${path}/operation`, ["simple_return"]);
    list(item.inputs, `${path}/inputs`, numberInput);
  } else {
    if (item.calculationId !== undefined)
      text(item.calculationId, `${path}/calculationId`);
    string(item.method, `${path}/method`);
    list(item.assumptions, `${path}/assumptions`, string);
    list(item.evidence, `${path}/evidence`, sourceRef);
  }
};

/** The single structural boundary for untrusted research/model content. */
export function parseArtifactInput(value: unknown): ResearchArtifactInput {
  const path = "artifact";
  const item = object(value, path, [
    "kind",
    "title",
    "body",
    "inputRefs",
    "claims",
    "payload",
  ]);
  text(item.title, `${path}/title`);
  text(item.body, `${path}/body`);
  list(item.inputRefs, `${path}/inputRefs`, artifactRef);
  list(item.claims, `${path}/claims`, claim);
  payload(item.kind, item.payload, `${path}/payload`);
  return value as ResearchArtifactInput;
}

import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  AGENT_SUMMARY_MAX_CHARACTERS,
  DIGEST_MAX_CHARACTERS,
  agentReportSchemas,
  legacyDecisionReportSchema,
  type AgentReport,
  type AgentReportKind,
} from "../contracts/agent-reports.js";
import { ResearchError } from "../contracts/errors.js";
import { parseLocalDate } from "../contracts/time.js";

function invalid(path: string, reason: string): never {
  throw new ResearchError("INVALID_INPUT", `${path}: ${reason}`);
}

function nonemptyText(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.trim() === "") invalid(path, "expected nonempty text");
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => nonemptyText(item, `${path}/${index}`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      nonemptyText(item, `${path}/${key}`);
  }
}

function atLeastOne(items: unknown[], path: string): void {
  if (items.length === 0) invalid(path, "expected at least one item");
}

function digestBudgetDetail(digest: AgentReport<"digest">): string {
  const total = [...JSON.stringify(digest)].length;
  const summary = [...digest.summary].length;
  const fields = Object.entries(digest.content)
    .map(([name, value]) => `${name}=${[...JSON.stringify(value)].length}`)
    .join(", ");
  return `summary/content JSON: ${total}/${DIGEST_MAX_CHARACTERS} Unicode characters (over by ${Math.max(0, total - DIGEST_MAX_CHARACTERS)}); summary: ${summary}/${AGENT_SUMMARY_MAX_CHARACTERS} (over by ${Math.max(0, summary - AGENT_SUMMARY_MAX_CHARACTERS)}). Content field JSON value lengths: ${fields}. Counts include JSON escaping; total also includes field names and punctuation. Compress the handoff and retain each required risk once.`;
}

/** Validate model output once at the submission boundary. */
function readReport<Kind extends AgentReportKind>(
  kind: Kind,
  value: unknown,
): AgentReport<Kind> {
  const errors = validateJsonSchemaValue(agentReportSchemas[kind], value, kind);
  if (errors.length > 0)
    throw new ResearchError("INVALID_INPUT", errors.join("\n"));
  nonemptyText(value, kind);
  const report = value as AgentReport<Kind>;
  if ([...report.summary].length > AGENT_SUMMARY_MAX_CHARACTERS) {
    if (kind === "digest")
      invalid("digest", digestBudgetDetail(report as AgentReport<"digest">));
    invalid(
      `${kind}/summary`,
      `expected at most ${AGENT_SUMMARY_MAX_CHARACTERS} Unicode characters`,
    );
  }
  if (kind === "analysis") {
    const { content } = report as AgentReport<"analysis">;
    atLeastOne(content.currentState, "analysis/content/currentState");
    atLeastOne(
      content.analysisModel.drivers,
      "analysis/content/analysisModel/drivers",
    );
  } else if (kind === "debate") {
    atLeastOne(
      (report as AgentReport<"debate">).content.arguments,
      "debate/content/arguments",
    );
  } else if (kind === "decision_draft") {
    const { content } = report as AgentReport<"decision_draft">;
    atLeastOne(content.thesis, "decision_draft/content/thesis");
    if (content.targetPrice !== null) {
      if (
        !Number.isFinite(content.targetPrice.value) ||
        content.targetPrice.value < 0
      )
        invalid(
          "decision_draft/content/targetPrice/value",
          "expected a finite nonnegative price",
        );
      atLeastOne(
        content.targetPrice.assumptions,
        "decision_draft/content/targetPrice/assumptions",
      );
    }
  }
  return structuredClone(report);
}

export function parseAgentReport<Kind extends AgentReportKind>(
  kind: Kind,
  value: unknown,
): AgentReport<Kind> {
  const report = readReport(kind, value);
  if (kind === "digest") {
    const digest = report as AgentReport<"digest">;
    const total = [...JSON.stringify(digest)].length;
    if (total > DIGEST_MAX_CHARACTERS)
      invalid("digest", digestBudgetDetail(digest));
  }
  return report;
}

/** Read recorded reports using their saved shape; current submission budgets apply at entry. */
export function validateStoredAgentReport(
  kind: AgentReportKind,
  value: unknown,
): void {
  if (
    kind === "decision_draft" &&
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "object" &&
    value.content !== null &&
    "rating" in value.content
  ) {
    const errors = validateJsonSchemaValue(
      legacyDecisionReportSchema,
      value,
      kind,
    );
    if (errors.length > 0)
      throw new ResearchError("INVALID_INPUT", errors.join("\n"));
    nonemptyText(value, kind);
    parseLocalDate((value.content as Record<string, unknown>).horizonEndDate);
    return;
  }
  readReport(kind, value);
}

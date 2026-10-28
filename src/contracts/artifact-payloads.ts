import type { ArtifactInput, ArtifactKind, NumberInput } from "./artifacts.js";
import type { AgentReport } from "./agent-reports.js";
import type { StageHandoff } from "./stage-handoff.js";
import type {
  ArtifactRef,
  DataGap,
  EvidenceRef,
  ISOTime,
  LocalDate,
  SourceRef,
} from "./data.js";

export type SupportedStatement = {
  text: string;
  evidence: EvidenceRef[];
  numbers: NumberInput[];
};
export type RiskIssue = {
  issueId: string;
  description: string;
  impact: string;
  trigger: string;
  constraint: string;
  recommendation: string;
  evidence: EvidenceRef[];
  numbers: NumberInput[];
};
export type AnalysisPayload = {
  findings: SupportedStatement[];
  risks: string[];
  gaps: DataGap[];
};
export type AnalysisReport = {
  assessment: string;
  current_state: string[];
  analysis_model: {
    drivers: string[];
    mechanism: string;
    assumptions: string[];
    alternative_explanations: string[];
  };
  outlook: {
    horizon: string;
    base_case: { conditions: string[]; expectation: string };
    alternative_case: { conditions: string[]; expectation: string };
    watch_points: string[];
  };
  risks: { factor: string; impact: string; invalidation: string }[];
  handoff: {
    implications: string[];
    open_questions: string[];
    limitations: string[];
  };
};
export type AnalysisNotePayload = AnalysisReport & { schemaVersion: 2 };
export type AnalysisAgentPayload = {
  schemaVersion: 3;
  report: AgentReport<"analysis">;
  publicSearchAsOf?: ISOTime;
  stageHandoff?: StageHandoff;
};
export type DebatePayload = {
  side: "bull" | "bear";
  arguments: SupportedStatement[];
  rebuttals: (SupportedStatement & { target: ArtifactRef })[];
  unresolved: string[];
};
export type DebateNotePayload = AnalysisReport & {
  schemaVersion: 2;
  side: "bull" | "bear";
};
export type DebateAgentPayload = {
  schemaVersion: 3;
  side: "bull" | "bear";
  report: AgentReport<"debate">;
  stageHandoff?: StageHandoff;
};
export type RiskPayload = {
  issues: RiskIssue[];
  report?: AgentReport<"risk">;
  stageHandoff?: StageHandoff;
};
export type PlanPayload = {
  thesis: SupportedStatement[];
  questions: string[];
  constraints: string[];
  report?: AgentReport<"plan">;
  stageHandoff?: StageHandoff;
};
export type DigestPayload = {
  facts: SupportedStatement[];
  disagreements: string[];
  risks: RiskIssue[];
  gaps: ReportedGap[];
  numbers: Extract<NumberInput, { kind: "artifact" }>[];
  upstreamRefs: ArtifactRef[];
  report?: AgentReport<"digest">;
};
export type Rating =
  | import("./rating-policy.js").PriceRating
  | "strong_buy"
  | "hold"
  | "strong_sell";
export type DecisionProposal = {
  stageHandoff?: StageHandoff;
  rating: Rating | null;
  horizonEndDate: LocalDate;
  thesis: SupportedStatement[];
  basePrice: NumberInput | null;
  targetPrice: NumberInput | null;
  risks: string[];
  riskResponses: {
    issueId: string;
    disposition: "accepted" | "mitigated" | "constrained" | "unresolved";
    reason: string;
  }[];
  invalidationConditions: string[];
  limitations: string[];
  ratingPolicy?: typeof import("./rating-policy.js").PRICE_RATING_POLICY;
  report?:
    | AgentReport<"decision_draft">
    | import("./agent-reports.js").LegacyDecisionAgentReport;
};
export type DecisionResult = DecisionProposal & {
  schemaVersion: 1;
  runId: string;
  securityId: string;
  cutoff: ISOTime;
  draftRef: ArtifactRef;
  inputRefs: ArtifactRef[];
  computedReturn: number | null;
  validation: { checkedRefs: ArtifactRef[]; warnings: string[] };
  finalizedAt: ISOTime;
};
export type ReportedGap =
  | { kind: "source"; source: SourceRef; gap: DataGap }
  | { kind: "artifact"; artifact: ArtifactRef; gap: DataGap };
export type ReportPayload = {
  sections: ArtifactRef[];
  digests: ArtifactRef[];
  decision: DecisionResult;
  limitations: string[];
  gaps: ReportedGap[];
};
export type ArtifactPayloads = {
  analysis: AnalysisPayload | AnalysisNotePayload | AnalysisAgentPayload;
  debate: DebatePayload | DebateNotePayload | DebateAgentPayload;
  risk: RiskPayload;
  plan: PlanPayload;
  digest: DigestPayload;
  decision_draft: DecisionProposal;
  decision: DecisionResult;
  report: ReportPayload;
};
export type ResearchArtifactInput = {
  [Kind in ArtifactKind]: Omit<ArtifactInput, "kind" | "payload"> & {
    kind: Kind;
    payload: ArtifactPayloads[Kind];
  };
}[ArtifactKind];

import type { ArtifactRef, ResearchScope } from "./data.js";
import type {
  ArtifactVersion,
  NumberInput,
  NumericClaim,
} from "./artifacts.js";
import type { ReportedGap, RiskIssue } from "./artifact-payloads.js";
import type { ArtifactCommitResult, TaskOperation } from "./runs.js";
import type { AgentReport } from "./agent-reports.js";

export const DIGEST_HANDOFF_VERSION = "12";

export interface DigestNumberCandidate {
  candidateId: string;
  input: Extract<NumberInput, { kind: "artifact" }>;
  claim: NumericClaim;
  estimated: boolean;
}
export interface DigestModelInput {
  scope: ResearchScope;
  taskId: string;
  instructionVersion: number;
  instruction: string | null;
  artifacts: ArtifactVersion[];
  reports: ArtifactVersion[];
  references: ArtifactRef[];
  numbers: DigestNumberCandidate[];
  risks: RiskIssue[];
  gaps: ReportedGap[];
}
export interface DigestDraft {
  report?: AgentReport<"digest">;
  title: string;
  body: string;
  inputRefs: ArtifactRef[];
  facts: { text: string; inputRefs: ArtifactRef[]; numbers: string[] }[];
  disagreements: string[];
  riskSummaries: { issueId: string; text: string }[];
}
/** Digest generation publishes through the domain's validation boundary. */
export type GenerateDigest = (
  input: DigestModelInput,
  signal: AbortSignal,
  operation: TaskOperation,
  submit: (draft: unknown) => ArtifactCommitResult,
) => Promise<ArtifactCommitResult>;

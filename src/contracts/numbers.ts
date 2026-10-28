import type { ArtifactInput, NumericClaim } from "./artifacts.js";
import type { ArtifactRef, DataGap, ResearchScope, SourceRef } from "./data.js";
import type { ResearchRun } from "./runs.js";

export type NumberTarget =
  | { kind: "pending"; contentId: string; content: ArtifactInput }
  | { kind: "artifact"; ref: ArtifactRef };
export type NumberTargetRef =
  | { kind: "pending"; contentId: string }
  | { kind: "artifact"; ref: ArtifactRef };
export type NumberIssueCode =
  | "reference"
  | "selector"
  | "value"
  | "unit"
  | "time"
  | "calculation"
  | "cycle"
  | "estimate";
export interface NumberIssue {
  code: NumberIssueCode;
  detail: string;
}
export interface NumberWarning {
  code: "source_gap" | "estimate" | "stale";
  detail: string;
  source?: SourceRef;
  gap?: DataGap;
}
export interface ClaimCheck {
  claim: NumericClaim;
  passed: boolean;
  issues: NumberIssue[];
  warnings: NumberWarning[];
}
export interface NumberCheck {
  checkerVersion: string;
  target: NumberTargetRef;
  scope: ResearchScope;
  passed: boolean;
  claims: ClaimCheck[];
}
export type NumberContext = Pick<
  ResearchRun,
  "runId" | "scope" | "tasks" | "evidence" | "artifacts"
>;

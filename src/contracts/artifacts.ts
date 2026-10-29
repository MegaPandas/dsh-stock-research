import type { ArtifactRef, ISOTime, SourceRef } from "./data.js";

export type ArtifactKind =
  | "analysis"
  | "debate"
  | "risk"
  | "plan"
  | "digest"
  | "decision_draft"
  | "decision"
  | "report";

export type NumberInput =
  | { kind: "local"; claimId: string }
  | { kind: "artifact"; artifact: ArtifactRef; claimId: string };

export type NumericClaim =
  | {
      id: string;
      kind: "observed";
      value: number;
      unit: string;
      source: SourceRef;
    }
  | {
      id: string;
      kind: "calculated";
      value: number;
      unit: string;
      operation: "simple_return";
      inputs: NumberInput[];
    }
  | {
      id: string;
      kind: "estimated";
      calculationId?: string;
      value: number;
      unit: string;
      method: string;
      assumptions: string[];
      evidence: SourceRef[];
    };

export interface ArtifactInput {
  kind: ArtifactKind;
  title: string;
  body: string;
  inputRefs: ArtifactRef[];
  claims: NumericClaim[];
  payload: Record<string, unknown>;
}

export interface DecisionDraftValidation {
  version: 1;
  computedReturn: number | null;
  warnings: string[];
}

export interface ArtifactVersion {
  ref: ArtifactRef;
  taskId: string;
  attempt: number;
  producerSessionId: string | null;
  createdAt: ISOTime;
  schemaVersion: 1;
  decisionValidation?: DecisionDraftValidation;
  content: ArtifactInput;
}

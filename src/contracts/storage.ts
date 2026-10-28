import type { LocalDate } from "./data.js";

export type ContentRef =
  | { readonly kind: "input" | "evidence"; readonly id: string }
  | {
      readonly kind: "artifact";
      readonly id: string;
      readonly revision: number;
    };

export type ArtifactContentRef = Extract<ContentRef, { kind: "artifact" }>;

export interface RunLocation {
  date: LocalDate;
  securityId: string;
  mode: "quick" | "deep";
}

export type StoredRun<State extends object> = State & {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly revision: number;
  readonly contents: readonly ContentRef[];
};

export interface ContentWriter {
  input(build: (id: string) => unknown): ContentRef;
  evidence(build: (id: string) => unknown): ContentRef;
  artifact(
    previous: ArtifactContentRef | null,
    build: (ref: ArtifactContentRef) => unknown,
  ): ArtifactContentRef;
}

export const PROJECTION_FILES = [
  "digest.md",
  "plan.md",
  "decision.draft.md",
  "decision.json",
  "report.md",
] as const;

export type ProjectionTarget =
  | { readonly filename: (typeof PROJECTION_FILES)[number] }
  | { readonly directory: "reports" | "debate"; readonly name: string };

export interface ProjectionWrite {
  readonly target: ProjectionTarget;
  readonly content: string;
}

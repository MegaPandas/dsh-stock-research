import type { CollectionProgress } from "./collection.js";
import type { RunDefinition } from "./workflow.js";

export interface ResearchIdentity {
  symbol: string;
  date: string;
  mode: RunDefinition["mode"];
}

export type CollectionCounts = Pick<
  CollectionProgress,
  | "completed"
  | "total"
  | "succeeded"
  | "failed"
  | "cacheHits"
  | "cacheMisses"
  | "current"
>;

export type ResearchPhase =
  | { kind: "preparing" }
  | { kind: "collection"; counts: CollectionCounts }
  | {
      kind: "tasks";
      completed: number;
      total: number;
      currentTaskIds: string[];
    }
  | { kind: "review"; stageId: string; feedback: string | null }
  | { kind: "ended" };

export interface ResearchState {
  status:
    "preparing" | "active" | "blocked" | "completed" | "cancelled" | "failed";
  phase: ResearchPhase;
  runId?: string;
  identity?: ResearchIdentity;
  operationIds: string[];
}

export interface ResearchProgress {
  state: ResearchState;
  text: string;
}

/** Each record is one complete JSON line in the owning native Job's log channel. */
export type ResearchJobRecord =
  | { type: "research/progress"; progress: ResearchProgress }
  | {
      type: "research/diagnostic";
      dataset: string;
      source: string;
      code: string;
      message: string;
    }
  | { type: "research/collection-record"; path: string }
  | { type: "research/message"; text: string };

export const RESEARCH_JOB_KIND = "stock-research";
export const RESEARCH_STEP_JOB_KIND = "stock-research-step";

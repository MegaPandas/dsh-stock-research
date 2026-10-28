import type { JobId } from "@deepseek-ai/dsh-jobs/brand";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export const RESEARCH_JOB_KIND = "stock-research";
export const RESEARCH_STEP_JOB_KIND = "stock-research-step";

/** Display-only payload retained for repaired history written by earlier bundles. */
export interface ResearchActivity {
  jobId: JobId;
  owner: SessionId;
  label: string;
  runId?: string;
  status:
    "preparing" | "active" | "blocked" | "completed" | "cancelled" | "failed";
  progress: string;
  operationIds: JobId[];
  startedAt: number;
  finishedAt?: number;
}

/** Full user-visible result, retained independently of the bounded job output ring. */
export interface ResearchJobResult {
  jobId: JobId;
  runId?: string;
  text: string;
  outcome: "success" | "error";
}

declare module "@deepseek-ai/dsh-jobs/view" {
  interface JobKindMap {
    "stock-research": typeof RESEARCH_JOB_KIND;
    "stock-research-step": typeof RESEARCH_STEP_JOB_KIND;
  }
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "stock-research/result": ResearchJobResult;
    "stock-research/activity": ResearchActivity;
  }
}

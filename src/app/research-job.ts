import {
  RESEARCH_JOB_KIND,
  RESEARCH_STEP_JOB_KIND,
} from "../contracts/research-progress.js";

declare module "@deepseek-ai/dsh-jobs/view" {
  interface JobKindMap {
    "stock-research": typeof RESEARCH_JOB_KIND;
    "stock-research-step": typeof RESEARCH_STEP_JOB_KIND;
  }
}

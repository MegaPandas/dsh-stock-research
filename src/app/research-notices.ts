import type { Agent } from "@deepseek-ai/dsh-agent";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";
import type { ResearchNotice } from "./research-actions.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "stock-research": {
      kind: "stock-research";
      notice: ResearchNotice["kind"];
      jobId: string;
      runId?: string;
    } & ContextFormed;
  }
}

export function notifyResearch(owner: Agent, notice: ResearchNotice): void {
  const update = { ...notice, kind: "update", notice: notice.kind };
  owner.followup(
    createUserMessage({
      source: {
        kind: "stock-research",
        notice: notice.kind,
        jobId: notice.jobId,
        ...(notice.runId === undefined ? {} : { runId: notice.runId }),
        form: "notice",
        summary: boundContextSummary(
          `研究 ${notice.kind} · ${notice.runId ?? notice.jobId}`,
        ),
      },
      content: [
        {
          type: "text",
          text: `Background research update. Read its handle or canonical run to review the current result. Stage acceptance, revisions and final delivery remain your responsibility.\nResearch request: ${JSON.stringify(update)}`,
        },
      ],
    }),
  );
}

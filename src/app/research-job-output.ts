import type { JobHandle } from "@deepseek-ai/dsh-jobs";
import type { ResearchJobRecord } from "../contracts/research-progress.js";
import { serializeJson } from "../json/serialize.js";

export function appendResearchRecord(
  job: Pick<JobHandle, "append">,
  record: ResearchJobRecord,
): void {
  job.append(`${serializeJson(record)}\n`, { channel: "log" });
}

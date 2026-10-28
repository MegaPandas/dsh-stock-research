import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import type { DataEnvelope } from "../contracts/data.js";
import type { ResearchData } from "../contracts/research.js";
import { ResearchError } from "../contracts/errors.js";
import { HostResearchAdapter } from "../data/host-research.js";
import type { EvidenceQuery } from "../contracts/task-data.js";
import type { RunService } from "../services/runs.js";
import { type SessionBindings, taskOperation } from "./bindings.js";

export async function searchPublic(
  ctx: Context,
  runs: RunService,
  bindings: SessionBindings,
  query: string,
  exec: ToolRunContext,
  parent?: Agent,
): Promise<DataEnvelope<ResearchData>> {
  const operation = taskOperation(bindings.require(exec.agent));
  const request: EvidenceQuery = {
    dataset: "research",
    provider: "dsh-web",
    parameters: { query },
  };
  const prepared = runs.evidenceForCall(operation, request, exec.callId);
  exec.signal.throwIfAborted();
  if (prepared.sourceRef !== null)
    return runs.readEvidence<ResearchData>(prepared.sourceRef).envelope;
  if (prepared.lineage !== null) {
    const ref = runs.replayEvidence(operation, request, exec.callId);
    return runs.readEvidence<ResearchData>(ref).envelope;
  }
  const scope = prepared.scope;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: scope.security.timeZone,
  }).format(new Date());
  if (scope.date !== today)
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "Historical research requires an existing public search snapshot.",
    );
  const native =
    ctx.tools.get("web_search", parent) ?? ctx.tools.get("web_search");
  if (native === undefined)
    throw new ResearchError(
      "SOURCE_UNAVAILABLE",
      "The host web_search tool is unavailable. Stop searching and complete the analysis from existing materials, recording information gaps.",
    );
  const raw = await native.execute({ queries: [query] }, exec);
  exec.signal.throwIfAborted();
  const envelope = await new HostResearchAdapter(async () => raw).query(
    { scope, query },
    exec.signal,
  );
  exec.signal.throwIfAborted();
  const ref = runs.recordEvidence(
    operation,
    request,
    { envelope, candidates: [] },
    exec.callId,
  );
  return runs.readEvidence<ResearchData>(ref).envelope;
}

export async function approvePublicSearch(
  ctx: Context,
  query: string,
  exec: ToolRunContext,
  used: number,
  parent?: Agent,
): Promise<boolean> {
  exec.signal.throwIfAborted();
  const approval = ctx.get("approval");
  if (approval === undefined)
    throw new ResearchError(
      "ACCESS_DENIED",
      "Public search approval is unavailable.",
    );
  const reason = `已使用 ${used} 次公开检索；申请本次检索：${query}`;
  const outcome = await approval.request({
    agent: parent ?? exec.agent!,
    toolName: "stock_search_public",
    ...(parent === undefined ? { callId: exec.callId } : {}),
    reason,
    displayReason: {
      "zh-CN": reason,
      en: `Public searches used: ${used}. Approve this search: ${query}`,
    },
    signal: exec.signal,
  });
  exec.signal.throwIfAborted();
  if (outcome === "rejected") return false;
  if (outcome !== "allowed-once")
    throw new ResearchError(
      "ACCESS_DENIED",
      `Public search approval ${outcome}.`,
    );
  return true;
}

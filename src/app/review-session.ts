import type { AgentReport } from "../contracts/agent-reports.js";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { MemoryRef } from "../contracts/memory.js";
import type {
  QueryMemoryReturns,
  RememberInput,
} from "../contracts/memory-service.js";
import type { PriceReturnsQuery, QueryResponse } from "../contracts/query.js";
import { renderAgentReport } from "../report/agent-report.js";
import type { MemoryService } from "../services/memory.js";
import type { ReviewInput } from "./review-input.js";

interface ReturnsAttempt {
  request: PriceReturnsQuery;
  result:
    | { kind: "pending" }
    | { kind: "succeeded"; envelope: QueryResponse<PriceReturnsQuery> }
    | { kind: "failed"; cause: unknown };
}
export interface ReviewSessionPorts {
  memory: Pick<MemoryService, "read" | "remember">;
  queryReturns: QueryMemoryReturns;
}

export class ReviewSession {
  private previous: MemoryRef | null = null;
  private lastReturns: ReturnsAttempt | undefined;

  constructor(
    private readonly input: Pick<ReviewInput, "runId" | "scope">,
    private readonly evidence: ArtifactRef[],
    private readonly ports: ReviewSessionPorts,
  ) {}

  async queryReturns(
    request: PriceReturnsQuery,
    signal: AbortSignal,
  ): Promise<QueryResponse<PriceReturnsQuery>> {
    signal.throwIfAborted();
    const attempt: ReturnsAttempt = { request, result: { kind: "pending" } };
    this.lastReturns = attempt;
    try {
      const envelope = await this.ports.queryReturns(
        this.input.scope,
        request,
        signal,
      );
      attempt.result = { kind: "succeeded", envelope };
      return envelope;
    } catch (cause) {
      attempt.result = { kind: "failed", cause };
      throw cause;
    }
  }

  select(ref: MemoryRef) {
    const entry = this.ports.memory.read(ref);
    if (
      entry.runId !== this.input.runId ||
      entry.securityId !== this.input.scope.security.id ||
      Date.parse(entry.recordedAt) > Date.parse(this.input.scope.cutoff)
    )
      throw new ResearchError(
        "ACCESS_DENIED",
        "The selected review is outside this run or review cutoff.",
      );
    this.previous = ref;
    return { previous: ref, outcome: entry.outcome, note: entry.note };
  }

  async submit(
    report: AgentReport<"review">,
    identity: string,
    callId: string,
    signal: AbortSignal,
  ): Promise<MemoryRef> {
    signal.throwIfAborted();
    const note =
      renderAgentReport("review", report, {
        includeSummary: false,
      }).trimEnd() || report.summary;
    const attempt = this.lastReturns;
    let returns: RememberInput["returns"];
    if (attempt?.result.kind === "succeeded")
      returns = { kind: "query", request: attempt.request };
    else if (attempt?.result.kind === "failed") {
      const cause = attempt.result.cause;
      returns = {
        kind: "unavailable",
        gaps: [
          {
            code: "missing",
            field: "returns",
            detail: cause instanceof Error ? cause.message : String(cause),
          },
        ],
      };
    } else if (attempt !== undefined)
      throw new ResearchError(
        "INVALID_INPUT",
        "The explicit returns query has not completed.",
      );
    else
      returns = {
        kind: "unavailable",
        gaps: [
          { code: "missing", field: "returns", detail: "本次复盘未查询收益。" },
        ],
      };
    return this.ports.memory.remember(
      { runId: this.input.runId, identity, scope: this.input.scope },
      {
        previous: this.previous,
        outcome: report.summary,
        note,
        evidence: this.evidence,
        returns,
      },
      `review:${callId}`,
      signal,
      attempt?.result.kind === "succeeded"
        ? attempt.result.envelope
        : undefined,
    );
  }
}

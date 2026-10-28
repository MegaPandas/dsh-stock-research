import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { TaskOperation } from "../contracts/runs.js";

export interface ModelCallRecord {
  kind: "digest" | "role";
  runId: string;
  taskId: string;
  attempt: number;
  callId: string;
  sessionId: string | null;
  provider: string;
  model: string;
  usage: TokenUsage | null;
  finish: string | null;
  outcome: "completed" | "failed" | "cancelled" | "committed" | "abandoned";
  durationMs: number;
  turn?: number;
  step?: number;
}

function usageRecord(usage: TokenUsage | null): TokenUsage | null {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
  };
}

/** Log only execution metadata; model inputs, output, and transport details stay out. */
export function logModelCall(ctx: Context, record: ModelCallRecord): void {
  ctx.logger.info({
    event: "stock.model",
    kind: record.kind,
    runId: record.runId,
    taskId: record.taskId,
    attempt: record.attempt,
    callId: record.callId,
    sessionId: record.sessionId,
    provider: record.provider,
    model: record.model,
    usage: usageRecord(record.usage),
    finish: record.finish,
    outcome: record.outcome,
    durationMs: record.durationMs,
    ...(record.turn === undefined ? {} : { turn: record.turn }),
    ...(record.step === undefined ? {} : { step: record.step }),
  });
}

/** Install before the first input; SDK frames are ordered for this exact Agent. */
export function observeModelCalls(
  agent: Agent,
  operation: TaskOperation,
  kind: ModelCallRecord["kind"],
): void {
  let pending:
    | {
        record: Omit<ModelCallRecord, "outcome" | "durationMs">;
        startedAt: number;
      }
    | undefined;
  agent.ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
    if (subject !== agent) return;
    if (frame.type === "start") {
      const { provider, model } = agent.session.requestHeader()!.config;
      pending = {
        record: {
          kind,
          runId: operation.runId,
          taskId: operation.taskId,
          attempt: operation.attempt,
          callId: frame.attemptId,
          sessionId: agent.id,
          provider,
          model,
          usage: null,
          finish: null,
          turn: frame.turn,
          step: frame.step,
        },
        startedAt: performance.now(),
      };
    } else if (frame.type === "chunk") {
      if (frame.chunk.type === "usage")
        pending!.record.usage = frame.chunk.usage;
      if (frame.chunk.type === "finish")
        pending!.record.finish = frame.chunk.reason.kind;
    } else {
      logModelCall(agent.ctx, {
        ...pending!.record,
        outcome: frame.outcome.kind,
        durationMs: performance.now() - pending!.startedAt,
      });
      pending = undefined;
    }
  });
}

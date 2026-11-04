import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";

const READS = new Set([
  "stock_read_run",
  "stock_read_research",
  "stock_read_report_draft",
]);
const DRAFT_WRITES = new Set(["stock_write_report", "stock_write_handoff"]);

/** Retain logs and call identity while removing superseded mutable reads from model history. */
export function setupResearchContext(
  ctx: Context,
  agent: Agent,
  queries: Pick<SessionQueryEngine, "readSurface">,
): () => void {
  let dirty = true;
  const unlisten = ctx.on("session/event", (session, event) => {
    if (
      session === agent.session &&
      event.type === "tool/call" &&
      (READS.has(event.data.name) || DRAFT_WRITES.has(event.data.name))
    )
      dirty = true;
  });
  const unstep = ctx.on("agent/pre-step", async ({ signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || !dirty) return decision;
    signal.throwIfAborted();
    const { events } = await queries.readSurface(agent.id);
    signal.throwIfAborted();
    const calls = new Map<ToolCallId, { name: string; arguments: string }>();
    const latest = new Map<
      string,
      {
        name: string;
        event: SessionEvent<"tool/result">;
      }
    >();
    const retire = (event: SessionEvent<"tool/result">, name: string) => {
      if (!agent.session.surface.nodes.includes(event.seq)) return;
      agent.session.append(
        "tool/result",
        {
          ...event.data,
          message: {
            ...event.data.message,
            content: [
              {
                type: "text",
                text: `${name}: this mutable snapshot is superseded. Use the latest result or read the current state again.`,
              },
            ],
          },
        },
        {
          surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq },
          sourceEventSeqs: [event.seq],
        },
      );
    };
    for (const event of events) {
      if (event.type === "assistant/message") {
        for (const block of event.data.message.content)
          if (
            block.type === "tool-call" &&
            (READS.has(block.name) || DRAFT_WRITES.has(block.name))
          )
            calls.set(block.id, {
              name: block.name,
              arguments: block.arguments,
            });
      }
      if (
        event.type !== "tool/result" ||
        event.surfaceOp !== "append" ||
        event.data.message.isError ||
        !agent.session.isOwnSeq(event.seq)
      )
        continue;
      const call = calls.get(event.data.message.toolCallId);
      if (call === undefined) continue;
      if (DRAFT_WRITES.has(call.name)) {
        for (const [key, prior] of latest)
          if (prior.name === "stock_read_report_draft") {
            retire(prior.event, prior.name);
            latest.delete(key);
          }
      } else {
        const key = JSON.stringify([call.name, JSON.parse(call.arguments)]);
        const prior = latest.get(key);
        if (prior !== undefined) retire(prior.event, prior.name);
        latest.set(key, { name: call.name, event });
      }
    }
    dirty = false;
    return decision;
  });
  return () => {
    unstep();
    unlisten();
  };
}

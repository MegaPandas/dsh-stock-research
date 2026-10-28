import type { Agent } from "@deepseek-ai/dsh-agent";

/** DSH 0.2.1-rc.2 drops malformed pi-ai arguments from completed tool blocks. */
export function preserveToolArguments(agent: Agent): void {
  agent.ctx.on("llm/stream", async function* (request, next) {
    // llm/stream is a host event; Agent ownership alone does not scope delivery.
    if (request.sessionId !== agent.id) {
      yield* next();
      return;
    }
    const fragments = new Map<number, string[]>();
    for await (const chunk of next()) {
      if (chunk.type === "tool-call-delta") {
        const parts = fragments.get(chunk.index);
        if (parts === undefined)
          fragments.set(chunk.index, [chunk.argumentsDelta]);
        else parts.push(chunk.argumentsDelta);
      }
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
        const raw = fragments.get(chunk.index)?.join("");
        fragments.delete(chunk.index);
        if (chunk.block.arguments === "{}" && raw !== undefined && raw !== "") {
          yield { ...chunk, block: { ...chunk.block, arguments: raw } };
          continue;
        }
      }
      yield chunk;
    }
  });
}

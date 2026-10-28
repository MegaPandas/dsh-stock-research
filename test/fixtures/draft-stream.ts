import { ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm";

export function draftMarkdown(value: object): string {
  const { body, ...metadata } = value as { body?: unknown };
  return `\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n${String(body ?? "")}`;
}

/** External model reply: write its draft, then submit the fixed file. */
export async function* draftSubmission(
  name: "stock_save_report" | "stock_submit_digest",
  draft: object,
  requestId = "submit",
  callId = requestId,
  format: "markdown" | "json" = "markdown",
): AsyncIterable<StreamChunk> {
  const calls = [
    {
      name: "stock_write_draft",
      arguments: {
        content:
          format === "json" ? JSON.stringify(draft) : draftMarkdown(draft),
      },
    },
    { name, arguments: name === "stock_save_report" ? { requestId } : {} },
  ];
  for (const [index, call] of calls.entries()) {
    const id = ToolCallId(`${callId}-${index}`);
    const args = JSON.stringify(call.arguments);
    yield { type: "block-start", index, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index,
      id,
      name: call.name,
      argumentsDelta: args,
    };
    yield {
      type: "block-end",
      index,
      block: { type: "tool-call", id, name: call.name, arguments: args },
    };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

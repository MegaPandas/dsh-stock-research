import type { Context } from "@deepseek-ai/cordis";
import { NativeToolExecutor } from "@deepseek-ai/dsh-tool-executor-native";
import {
  ToolRuntime,
  type ToolExecutionInput,
  type ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";

export function createToolRuntime(ctx: Context): ToolRuntime {
  const tools = new ToolRuntime(ctx);
  tools.setExecutor(new NativeToolExecutor(ctx));
  return tools;
}

export async function executeTool(
  tools: Pick<ToolRuntime, "execute">,
  input: Pick<
    ToolExecutionInput,
    "agent" | "callId" | "name" | "arguments" | "signal"
  >,
): Promise<ToolExecutionResult> {
  const { name, arguments: args, callId, ...context } = input;
  const batch = await tools.execute({
    ...context,
    calls: [
      { type: "tool-call", id: callId, name, arguments: JSON.stringify(args) },
    ],
  });
  return batch.results[0]!.result;
}

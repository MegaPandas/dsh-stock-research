import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {
  SubagentActivation,
  SubagentResult,
} from "@deepseek-ai/dsh-subagent";

/** Continue a settled child; the caller serializes activations for this id. */
export async function continueChild(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  prompt: ContentBlock[],
  signal: AbortSignal,
): Promise<SubagentActivation> {
  let resolve!: (result: SubagentResult) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<SubagentResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let ended = false;
  const unlisten = ctx.on("subagent/end", (info) => {
    if (info.id !== childId) return;
    ended = true;
    unlisten();
    resolve({
      output: info.lastAssistantMessage ?? [],
      stopReason: info.stopReason,
    });
  });
  let messageId;
  try {
    messageId = await ctx.subagents.sendMessage(parent, childId, prompt, {
      signal,
    });
  } catch (error) {
    unlisten();
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    childId,
    messageId,
    result,
    dispose() {
      if (ended) return disposal ?? Promise.resolve();
      disposal ??= ctx.subagents.drainChildren(parent, [childId]).then(
        () => {
          unlisten();
        },
        (error: unknown) => {
          unlisten();
          reject(error);
          throw error;
        },
      );
      return disposal;
    },
  };
}

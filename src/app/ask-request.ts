import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import { agentInput } from "../host/agent-protocol/input.js";
import { createSubmission } from "../host/agent-protocol/submission.js";
import { renderAgentReport } from "../report/agent-report.js";
import type { CollectionAccess } from "../contracts/collection.js";
import type { AskInput } from "./ask-input.js";
import { researchCutoff } from "./research-scope.js";
import { collectionReadTools } from "./collection-tools.js";
import { collectionDirectory } from "./collection-input.js";
import { requireCollectionData } from "./collection-snapshot.js";

export interface AskRequestPorts {
  collection: Pick<CollectionAccess, "collect" | "finalizeScope">;
  recallTool(): ToolDefinition;
}
export interface PreparedAsk {
  scope: ResearchScope;
  tools: readonly ToolDefinition[];
  input: ReturnType<typeof agentInput>;
  result(): string;
}

export async function prepareAskRequest(
  ports: AskRequestPorts,
  input: AskInput,
  signal: AbortSignal,
): Promise<PreparedAsk> {
  signal.throwIfAborted();
  const collection = await ports.collection.collect(input.scope, signal);
  requireCollectionData(collection);
  const scope = {
    ...input.scope,
    cutoff: researchCutoff(input.scope, new Date()),
  };
  ports.collection.finalizeScope(collection, scope);
  const submission = createSubmission("ask", (report) =>
    renderAgentReport("ask", report).trimEnd(),
  );
  return {
    scope,
    tools: [
      ports.recallTool(),
      ...collectionReadTools(collection.packets),
      submission.tool,
    ],
    input: agentInput({
      scope,
      task: { role: "ask", objective: input.question },
      context: {
        dataCatalog: collectionDirectory(collection.packets),
        collectionFailures: collection.failures,
      },
    }),
    result: submission.result,
  };
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import type { MemoryInputRegistration } from "../contracts/task-data.js";
import { taskOperation, type SessionBindings } from "../host/bindings.js";
import type { MemoryAccess } from "../contracts/memory-service.js";
import { researchTool } from "../host/tool-protocol/errors.js";
import { scopedQueryParameters } from "./query-scope.js";
import {
  invalid,
  object,
  objectSchema,
  opaqueObjectSchema,
  positive,
  resultOutput as output,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";

const kind = (value: string) => ({ type: "string" as const, const: value });
export function createRecallTool(
  memory: Pick<MemoryAccess, "recall" | "recallForTask">,
  bindings: SessionBindings,
  includeReplaySource = true,
): ToolDefinition {
  const parameters = objectSchema(
    {
      relatedRunId: { oneOf: [stringSchema, { type: "null" }] },
      text: { oneOf: [stringSchema, { type: "null" }] },
      limit: {
        type: "integer",
        description: "Positive safe integer limiting the number of results.",
      },
      source: {
        ...objectSchema({
          runId: stringSchema,
          inputRef: objectSchema({ kind: kind("input"), id: stringSchema }),
        }),
        description: "Saved memory snapshot selected for task replay.",
      },
    },
    ["relatedRunId", "text", "limit"],
  );
  return researchTool({
    name: "stock_recall",
    description:
      "Recall memory for the bound security and cutoff. relatedRunId filters associated runs; text searches outcome/note content, with null allowing any keyword. Return notes and version references.",
    parameters: includeReplaySource
      ? parameters
      : scopedQueryParameters(parameters, false),
    output: output({
      oneOf: [
        objectSchema({
          kind: kind("ordinary"),
          scope: opaqueObjectSchema,
          entries: { type: "array", items: opaqueObjectSchema },
        }),
        objectSchema({ kind: kind("task"), snapshot: opaqueObjectSchema }),
      ],
    }),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      const caller = bindings.require(exec.agent);
      if (caller.binding.kind === "coordinator")
        throw new ResearchError(
          "ACCESS_DENIED",
          "Memory recall requires a research, ask or review binding.",
        );
      const item = object(value, ["relatedRunId", "text", "limit", "source"]);
      const query = {
        runId:
          item.relatedRunId === null
            ? null
            : text(item.relatedRunId, "relatedRunId"),
        text: item.text === null ? null : text(item.text, "text"),
        limit: positive(item.limit, "limit"),
      };
      let source: MemoryInputRegistration | null = null;
      if (item.source !== undefined) {
        const selected = object(item.source, ["runId", "inputRef"]);
        const ref = object(selected.inputRef, ["kind", "id"]);
        if (ref.kind !== "input")
          invalid("source.inputRef must identify a saved input.");
        source = {
          runId: text(selected.runId, "source.runId"),
          inputRef: { kind: "input", id: text(ref.id, "source.inputRef.id") },
        };
      }
      if (caller.binding.kind === "task")
        return {
          kind: "task",
          snapshot: memory.recallForTask(
            taskOperation(caller),
            query,
            exec.callId,
            exec.signal,
            source,
          ),
        };
      if (source !== null)
        invalid("A saved source selection requires a replay task.");
      const scope = caller.binding.scope;
      return {
        kind: "ordinary",
        scope,
        entries: memory.recall(scope, query, exec.signal),
      };
    },
  });
}

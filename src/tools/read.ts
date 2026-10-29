import type { ToolDefinition, JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import type { EvidenceData } from "../contracts/query.js";
import type { MemoryInputRegistration } from "../contracts/task-data.js";
import { ResearchError } from "../contracts/errors.js";
import {
  authorizeRun,
  taskOperation,
  type BoundCaller,
  type SessionBindings,
} from "../host/bindings.js";
import { parseArtifactInput } from "../services/artifact-schema.js";
import {
  checkNumbersParameters,
  checkPendingNumbersParameters,
} from "./artifact-inputs.js";
import type { MemoryService } from "../services/memory.js";
import type { NumberService } from "../services/numbers.js";
import { readPointer, SelectorError } from "../services/number-fields.js";
import type { QueryService } from "../services/query.js";
import type { RunService } from "../services/runs.js";
import {
  collectionGaps,
  collectionRowSelectors,
} from "../services/collection-view.js";
import { researchTool } from "./errors.js";
import {
  artifactRef,
  artifactRefSchema,
  invalid,
  object,
  objectSchema,
  positive,
  sourceRef,
  sourceRefSchema,
  stringSchema,
  text,
  resultOutput as output,
} from "./parameters.js";

export interface ReadToolServices {
  runs: RunService;
  queries: Pick<QueryService, "health">;
  memory: MemoryService;
  numbers: NumberService;
}
function scopeFor(
  caller: BoundCaller,
  args: Record<string, unknown>,
  runs: RunService,
): ResearchScope {
  const binding = caller.binding;
  if (binding.kind === "coordinator") {
    const runId = text(args.runId, "runId");
    authorizeRun(binding, runId);
    return runs.view({ runId }).scope;
  }
  if (Object.hasOwn(args, "runId"))
    invalid(
      "This Agent inherits its research scope; runId cannot override it.",
    );
  return binding.kind === "task" ? runs.view(binding).scope : binding.scope;
}
const opaqueObject: JsonSchemaNode = {
  type: "object",
  additionalProperties: true,
};
const kind = (value: string): JsonSchemaNode => ({
  type: "string",
  const: value,
});
const numberCheckOutput = objectSchema({
  checkerVersion: stringSchema,
  target: opaqueObject,
  scope: opaqueObject,
  passed: { type: "boolean" },
  claims: { type: "array", items: opaqueObject },
});
export function createReadTools(
  services: ReadToolServices,
  bindings: SessionBindings,
): ToolDefinition[] {
  const { runs, queries, memory, numbers } = services;
  const tools: ToolDefinition[] = [
    {
      name: "stock_read_run",
      description: "Read an authorized run's status, tasks and artifact index.",
      parameters: objectSchema({ runId: stringSchema }),
      output: output(
        objectSchema({ kind: kind("run_view"), view: opaqueObject }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["runId"]);
        const runId = text(item.runId, "runId");
        authorizeRun(caller.binding, runId);
        return { kind: "run_view", view: runs.view({ runId }) };
      },
    },
    {
      name: "stock_read_artifact",
      description:
        "Read a fixed artifact version by reference in an authorized run.",
      parameters: objectSchema({ ref: artifactRefSchema }),
      output: output(
        objectSchema({ kind: kind("artifact"), artifact: opaqueObject }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["ref"]);
        const ref = artifactRef(item.ref);
        authorizeRun(caller.binding, ref.runId);
        return { kind: "artifact", artifact: runs.readArtifact(ref) };
      },
    },
    {
      name: "stock_read_evidence",
      description:
        "Read authorized evidence fields and source metadata by reference.",
      parameters: objectSchema({ ref: sourceRefSchema }),
      output: output(
        objectSchema({
          kind: kind("evidence"),
          ref: sourceRefSchema,
          value: {},
          metadata: opaqueObject,
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["ref"]);
        const ref = sourceRef(item.ref);
        authorizeRun(caller.binding, ref.runId);
        const envelope = runs.readEvidence<EvidenceData>(ref).envelope;
        let selected: unknown;
        try {
          selected = readPointer(envelope, ref.selector).value;
        } catch (cause) {
          if (!(cause instanceof SelectorError)) throw cause;
          throw new ResearchError("INVALID_INPUT", cause.message, { cause });
        }
        const metadata = { ...envelope };
        Reflect.deleteProperty(metadata, "data");
        Reflect.deleteProperty(metadata, "candidateClaims");
        if ("table" in envelope.data) {
          const row = /^\/data\/rows\/(\d+)(?:\/|$)/.exec(ref.selector);
          metadata.gaps = collectionGaps(envelope.gaps, [
            ref.selector,
            ...(row === null ? [] : collectionRowSelectors(Number(row[1]))),
          ]);
        }
        return { kind: "evidence", ref, value: selected, metadata };
      },
    },
    {
      name: "stock_data_health",
      description:
        "Read configured source capabilities, gaps and call counts without fetching data.",
      parameters: objectSchema(
        {
          runId: {
            ...stringSchema,
            description:
              "Coordinators supply an authorized runId; other roles inherit their bound scope.",
          },
        },
        [],
      ),
      output: output(
        objectSchema({
          scope: opaqueObject,
          sources: { type: "array", items: opaqueObject },
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        return queries.health(scopeFor(caller, object(value, ["runId"]), runs));
      },
    },
    {
      name: "stock_recall",
      description:
        "Recall memory for the bound security and cutoff. relatedRunId filters associated runs; text searches outcome/note content, with null allowing any keyword. Return notes and version references.",
      parameters: objectSchema(
        {
          relatedRunId: { oneOf: [stringSchema, { type: "null" }] },
          text: { oneOf: [stringSchema, { type: "null" }] },
          limit: {
            type: "integer",
            description:
              "Positive safe integer limiting the number of results.",
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
      ),
      output: output({
        oneOf: [
          objectSchema({
            kind: kind("ordinary"),
            scope: opaqueObject,
            entries: { type: "array", items: opaqueObject },
          }),
          objectSchema({ kind: kind("task"), snapshot: opaqueObject }),
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
    },
    {
      name: "stock_check_numbers",
      description:
        "Check numeric claims in an authorized fixed artifact and return results without modifying it.",
      parameters: checkNumbersParameters(),
      output: output(numberCheckOutput),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["ref"]);
        const ref = artifactRef(item.ref);
        authorizeRun(caller.binding, ref.runId);
        return numbers.checkNumbers(
          { runId: ref.runId, identity: caller.agent.id },
          { kind: "artifact", ref },
        );
      },
    },
    {
      name: "stock_check_pending_numbers",
      description:
        "Check numeric claims in the current task's complete pending artifact and return results without modifying it.",
      parameters: checkPendingNumbersParameters(),
      output: output(numberCheckOutput),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["contentId", "content"]);
        const runId = taskOperation(caller).runId;
        return numbers.checkNumbers(
          { runId, identity: caller.agent.id },
          {
            kind: "pending",
            contentId: text(item.contentId, "contentId"),
            content: parseArtifactInput(item.content),
          },
        );
      },
    },
  ];
  return tools.map(researchTool);
}

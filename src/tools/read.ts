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
      description: "读取绑定允许的运行视图。没有文件路径参数。",
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
      description: "读取绑定允许的固定产物。没有文件路径参数。",
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
      description: "读取绑定允许的证据字段。没有文件路径参数。",
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
        "读取已装配来源的能力、缺口和调用计数，不发起取数。调度员须提供获准 runId，其他角色继承绑定范围。",
      parameters: objectSchema({ runId: stringSchema }, []),
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
        "按绑定标的及截止时间检索记忆。relatedRunId筛选关联运行；text只匹配outcome/note正文，不按entryId匹配，text=null不限制关键词。正式任务保存完整快照，重跑可用source明确选择旧输入。",
      parameters: objectSchema(
        {
          relatedRunId: { oneOf: [stringSchema, { type: "null" }] },
          text: { oneOf: [stringSchema, { type: "null" }] },
          limit: { type: "integer", description: "正安全整数，限制返回条数。" },
          source: objectSchema({
            runId: stringSchema,
            inputRef: objectSchema({ kind: kind("input"), id: stringSchema }),
          }),
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
      description: "只读核验获准的固定产物。不会提交或自动修正声明。",
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
        "只读核验当前绑定任务的完整待提交产物。不会提交或自动修正声明。",
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

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import {
  taskOperation,
  type BoundCaller,
  type SessionBindings,
} from "../host/bindings.js";
import type { QueryService } from "../services/query.js";
import type { RunService } from "../services/runs.js";
import { researchTool } from "./errors.js";
import {
  invalid,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  sourceRefSchema,
} from "./parameters.js";
import {
  captureQueryPolicy,
  dataSchemas,
  parseDataRequest,
  type DataToolName,
  type QueryToolPolicy,
} from "./query-inputs.js";

export interface DataToolServices {
  runs: RunService;
  queries: Pick<QueryService, "query" | "queryForTask" | "replayForTask">;
}
function dataScope(caller: BoundCaller, runs: RunService): ResearchScope {
  const binding = caller.binding;
  if (binding.kind === "coordinator")
    throw new ResearchError(
      "ACCESS_DENIED",
      "Data queries require a research, ask or review binding.",
    );
  return binding.kind === "task" ? runs.view(binding).scope : binding.scope;
}
const definitions: readonly [DataToolName, string][] = [
  [
    "stock_get_market",
    "查询明确选择来源的日线及所需指标；任务继承研究范围，返回已登记证据与候选。",
  ],
  [
    "stock_get_fundamentals",
    "按所选SEC/东方财富/新浪查询必要财务字段；SEC发行人由可信标的映射确定。",
  ],
  ["stock_get_macro", "只查询指定FRED序列与日期区间，保留原单位和时间缺口。"],
  [
    "stock_get_returns",
    "查询明确来源及区间的价格收益端点。现有源未核实公司行动，收益保留可比性缺口。",
  ],
  [
    "stock_research",
    "通过宿主检索明确查询词及结果上限；任务登记实际片段，不自动扩大检索。",
  ],
];
export function createDataTools(
  services: DataToolServices,
  bindings: SessionBindings,
  policy: QueryToolPolicy,
): ToolDefinition[] {
  const captured = captureQueryPolicy(policy);
  const output = resultOutput({
    oneOf: [
      objectSchema({
        kind: { type: "string", const: "ordinary" },
        envelope: opaqueObjectSchema,
      }),
      objectSchema({
        kind: { type: "string", const: "task" },
        sourceRef: sourceRefSchema,
        envelope: opaqueObjectSchema,
      }),
    ],
  });
  return definitions
    .map(([name, description]): ToolDefinition => ({
      name,
      description,
      parameters: dataSchemas[name],
      output,
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        if (
          caller.binding.kind === "review" &&
          name !== "stock_get_market" &&
          name !== "stock_get_returns"
        )
          throw new ResearchError(
            "ACCESS_DENIED",
            "Review data access is limited to market and return queries.",
          );
        const scope = dataScope(caller, services.runs);
        const { request, source } = parseDataRequest(
          name,
          value,
          scope,
          captured,
        );
        if (caller.binding.kind === "task") {
          const operation = taskOperation(caller);
          const result =
            source === null
              ? await services.queries.queryForTask(
                  operation,
                  request,
                  exec.callId,
                  exec.signal,
                )
              : await services.queries.replayForTask(
                  operation,
                  request,
                  exec.callId,
                  source,
                  exec.signal,
                );
          return { kind: "task", ...result };
        }
        if (source !== null)
          invalid("A saved source selection requires a replay task.");
        return {
          kind: "ordinary",
          envelope: await services.queries.query(scope, request, exec.signal),
        };
      },
    }))
    .map(researchTool);
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import {
  taskOperation,
  type BoundCaller,
  type SessionBindings,
} from "../host/bindings.js";
import type { QueryService } from "../services/query.js";
import type { TaskQueryService } from "../services/task-query.js";
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
  queries: Pick<QueryService, "query">;
  taskQueries: Pick<TaskQueryService, "queryForTask" | "replayForTask">;
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
    "Query daily prices and requested indicators from an explicitly selected source. Tasks inherit the research scope; return registered evidence and candidate claims.",
  ],
  [
    "stock_get_fundamentals",
    "Query required financial fields from SEC, Eastmoney or Sina. SEC issuers are resolved through trusted security mappings.",
  ],
  [
    "stock_get_macro",
    "Query a specified FRED series and date range; return original units and temporal gaps.",
  ],
  [
    "stock_get_returns",
    "Query price-return endpoints for an explicit source and interval. Current sources do not verify corporate actions, so returns retain comparability gaps.",
  ],
  [
    "stock_research",
    "Call host search with a query and result limit; research tasks register the returned snippets.",
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
              ? await services.taskQueries.queryForTask(
                  operation,
                  request,
                  exec.callId,
                  exec.signal,
                )
              : await services.taskQueries.replayForTask(
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

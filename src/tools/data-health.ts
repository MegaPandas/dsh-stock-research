import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../contracts/data.js";
import {
  authorizeRun,
  type BoundCaller,
  type SessionBindings,
} from "../host/bindings.js";
import type { QueryAccess } from "../contracts/query-service.js";
import type { RunReader } from "../contracts/run-access.js";
import { researchTool } from "../host/tool-protocol/errors.js";
import {
  invalid,
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput as output,
  stringSchema,
  text,
} from "../host/tool-protocol/parameters.js";

function scopeFor(
  caller: BoundCaller,
  args: Record<string, unknown>,
  runs: Pick<RunReader, "view">,
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
export function createDataHealthTool(
  queries: Pick<QueryAccess, "health">,
  runs: Pick<RunReader, "view">,
  bindings: SessionBindings,
  includeRunId = true,
): ToolDefinition {
  return researchTool({
    name: "stock_data_health",
    description:
      "Read configured source capabilities, gaps and call counts without fetching data.",
    parameters: includeRunId
      ? objectSchema(
          {
            runId: {
              ...stringSchema,
              description:
                "Coordinators supply an authorized runId; other roles inherit their bound scope.",
            },
          },
          [],
        )
      : objectSchema({}),
    output: output(
      objectSchema({
        scope: opaqueObjectSchema,
        sources: { type: "array", items: opaqueObjectSchema },
      }),
    ),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      const caller = bindings.require(exec.agent);
      return queries.health(scopeFor(caller, object(value, ["runId"]), runs));
    },
  });
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResearchScope } from "../../contracts/data.js";
import type { QueryPolicy } from "../../contracts/query.js";
import { researchTool } from "../../host/tool-protocol/errors.js";
import {
  invalid,
  object,
  objectSchema,
  opaqueObjectSchema,
  positive,
  resultOutput,
  stringSchema,
  text,
} from "../../host/tool-protocol/parameters.js";
import { dataSchemas, parseDataRequest } from "../../tools/query-inputs.js";
import { scopedQueryParameters } from "../../tools/query-scope.js";
import type { ReviewSession } from "../review-session.js";

export function createReviewTools(
  session: Pick<ReviewSession, "queryReturns" | "select">,
  scope: ResearchScope,
  policy: QueryPolicy,
): ToolDefinition[] {
  return [
    researchTool({
      name: "stock_get_returns",
      description:
        "Query price-return endpoints for an explicit source and interval. Current sources do not verify corporate actions, so returns retain comparability gaps.",
      parameters: scopedQueryParameters(dataSchemas.stock_get_returns, false),
      output: resultOutput(
        objectSchema({
          kind: { type: "string", const: "ordinary" },
          envelope: opaqueObjectSchema,
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const { request, source } = parseDataRequest(
          "stock_get_returns",
          value,
          scope,
          policy,
        );
        if (source !== null)
          invalid("A review cannot select a task replay source.");
        return {
          kind: "ordinary",
          envelope: await session.queryReturns(request, exec.signal),
        };
      },
    }),
    researchTool({
      name: "stock_select_review",
      description:
        "Select an existing review of this run for a user-requested revision.",
      parameters: objectSchema({
        entryId: stringSchema,
        revision: { type: "integer" },
      }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const item = object(value, ["entryId", "revision"]);
        return session.select({
          entryId: text(item.entryId, "entryId"),
          revision: positive(item.revision, "revision"),
        });
      },
    }),
  ];
}

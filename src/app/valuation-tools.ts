import {
  validateJsonSchemaValue,
  type ToolDefinition,
  type JsonSchemaNode,
} from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { calculatedReportSections } from "../contracts/agent-reports.js";
import type { RunService } from "../services/runs.js";
import {
  materializeTargetPrice,
  materializeValuation,
  type ValuationSelection,
} from "../services/valuation-calculations.js";
import { objectSchema, stringSchema } from "../tools/parameters.js";
import { researchTool } from "../tools/errors.js";

/** Current model input contains references; numeric sections are assembled by trusted code. */
export function computedValuationDraftTools(
  tools: ToolDefinition[],
  runs: RunService,
  runId: string,
): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name !== "stock_write_report") return tool;
    const properties = calculatedReportSections(
      (tool.parameters as JsonSchemaNode).properties!,
    );
    const parameters = objectSchema(properties, []);
    return researchTool({
      ...tool,
      parameters,
      async execute(value, exec) {
        const errors = validateJsonSchemaValue(
          parameters,
          value,
          "reportDraft",
        );
        if (errors.length)
          throw new ResearchError("INVALID_INPUT", errors.join("\n"));
        const input = value as Record<string, unknown>;
        const resolved = { ...input };
        if (input.valuation !== undefined && input.valuation !== null)
          resolved.valuation = materializeValuation(
            runs,
            runId,
            input.valuation as ValuationSelection,
          );
        if (input.targetPrice !== undefined && input.targetPrice !== null)
          resolved.targetPrice = materializeTargetPrice(
            runs,
            runId,
            (input.targetPrice as { calculationId: string }).calculationId,
          );
        return tool.execute(resolved, exec);
      },
    });
  });
}

export function scopedCalculationReader(
  tool: ToolDefinition,
  runId: string,
): ToolDefinition {
  const parameters = objectSchema({ calculationId: stringSchema });
  return {
    ...tool,
    parameters,
    async execute(value, exec) {
      const errors = validateJsonSchemaValue(parameters, value);
      if (errors.length)
        throw new ResearchError("INVALID_INPUT", errors.join("\n"));
      return tool.execute({ ...(value as object), runId }, exec);
    },
  };
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  authorizeRun,
  taskOperation,
  type SessionBindings,
} from "../host/bindings.js";
import type { RunService } from "../services/runs.js";
import {
  calculateValuation,
  readValuationCalculation,
  savedValuationMethods,
} from "../services/valuation-calculations.js";
import {
  VALUATION_INPUT_SCHEMAS,
  valuationCalculationParameters,
} from "../services/valuation-inputs.js";
import {
  VALUATION_ENGINE_VERSION,
  type ValuationMethodId,
} from "../contracts/valuation.js";
import { ResearchError } from "../contracts/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "./parameters.js";
import { researchTool } from "./errors.js";

export function valuationMethodDetail(
  methods: ReturnType<typeof savedValuationMethods>,
  methodId: string,
) {
  const method = methods.methods.find(({ id }) => id === methodId);
  if (method === undefined)
    throw new ResearchError(
      "INVALID_INPUT",
      `Unknown valuation method ${methodId}.`,
    );
  return structuredClone({
    version: methods.version,
    calculationEngineVersion: VALUATION_ENGINE_VERSION,
    conventions: methods.conventions,
    method,
    sources: methods.sources.filter(({ id }) => method.sourceIds.includes(id)),
    calculationInputSchema:
      VALUATION_INPUT_SCHEMAS[methodId as ValuationMethodId],
  });
}

export function createValuationTools(
  runs: RunService,
  bindings: SessionBindings,
): ToolDefinition[] {
  return [
    researchTool({
      name: "stock_calculate_valuation",
      description:
        "Calculate and save research-date valuations, target-date prices and sensitivities for the current task; return calculationId, per-share results, steps and diagnostics. Read the selected method's input schema with stock_read_valuation_method; inputs are validated against methodId. Declare amount and share scales separately; use decimal rates and probabilities. Currency comes from the run. Code discounts by day and clips elapsed periods. Equity multiples yield equity value directly; EV multiples require a debt/cash bridge. Retain negative residual equity for solvency analysis; target prices must be nonnegative.",
      parameters:
        valuationCalculationParameters as typeof valuationCalculationParameters &
          Record<string, unknown>,
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        return calculateValuation(
          runs,
          taskOperation(bindings.require(exec.agent)),
          value,
          exec.callId,
        );
      },
    }),
    researchTool({
      name: "stock_read_valuation_calculation",
      description:
        "Read an immutable valuation calculation, input rationale, algorithm version and intermediate steps from an authorized run.",
      parameters: objectSchema({
        runId: stringSchema,
        calculationId: stringSchema,
      }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const input = object(value, ["runId", "calculationId"]);
        const runId = text(input.runId, "runId");
        authorizeRun(bindings.require(exec.agent).binding, runId);
        return readValuationCalculation(
          runs,
          runId,
          text(input.calculationId, "calculationId"),
        );
      },
    }),
    researchTool({
      name: "stock_read_valuation_method",
      description:
        "Read valuation methods, input constraints, references and calculation input schemas saved in an authorized run.",
      parameters: objectSchema({ runId: stringSchema, methodId: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const input = object(value, ["runId", "methodId"]);
        const runId = text(input.runId, "runId");
        authorizeRun(bindings.require(exec.agent).binding, runId);
        return valuationMethodDetail(
          savedValuationMethods(runs, runId),
          text(input.methodId, "methodId"),
        );
      },
    }),
  ];
}

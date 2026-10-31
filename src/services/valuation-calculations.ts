import { ResearchError } from "../contracts/errors.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import type { RunCommands, RunReader } from "../contracts/run-access.js";
import type { TaskOperation } from "../contracts/runs.js";
import {
  VALUATION_ENGINE_VERSION,
  type ValuationCalculation,
  type ValuationOutput,
  type ValuationRequest,
} from "../contracts/valuation.js";
import { evaluateValuation } from "../valuation/index.js";
import { valuationDependencyIds } from "../valuation/dependencies.js";
import {
  parseValuationRequest,
  sensitivityRequest,
} from "../valuation/requests.js";
import {
  createValuationReader,
  readValuationCalculation,
  savedValuationMethods,
} from "./valuation-records.js";

type CalculationReader = Pick<
  RunReader,
  "numberContext" | "inputCatalog" | "readInput"
>;

function invalid(message: string): never {
  throw new ResearchError("INVALID_INPUT", `valuation: ${message}`);
}

function dependencies(
  read: (id: string) => ValuationCalculation,
  request: ValuationRequest,
  currency: string,
  valueDate: string,
): Map<string, ValuationOutput> {
  const ids = valuationDependencyIds(request);
  return new Map(
    ids.map((id) => {
      const record = read(id);
      if (
        record.currency !== currency ||
        record.valueDate !== valueDate ||
        record.request.purpose !== request.purpose
      )
        invalid(
          "Combined calculations must use the same currency, value date and purpose.",
        );
      return [id, record.result];
    }),
  );
}

export function calculateValuation(
  runs: CalculationReader &
    Pick<RunReader, "view"> &
    Pick<
      RunCommands,
      "valuationCalculationForCall" | "recordValuationCalculation"
    >,
  operation: TaskOperation,
  value: unknown,
  callId: string,
): ValuationCalculation {
  const versions = runs.inputCatalog(operation.runId).versions;
  if (versions.prompts.valuationEngine !== VALUATION_ENGINE_VERSION)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The run's valuation calculation engine is unavailable.",
    );
  const request = parseValuationRequest(value);
  const saved = runs.valuationCalculationForCall(operation, request, callId);
  if (saved !== null) return saved;
  const scope = runs.view(operation).scope;
  const valueDate =
    request.purpose === "valuation"
      ? scope.date
      : decisionPolicy(scope.date).horizonEndDate;
  let registry: ReturnType<typeof createValuationReader> | undefined;
  const read = (id: string) =>
    (registry ??= createValuationReader(runs, operation.runId)).read(id);
  const evaluate = (input: ValuationRequest) =>
    evaluateValuation(
      input,
      scope.security.currency,
      dependencies(read, input, scope.security.currency, valueDate),
      valueDate,
    );
  const result = evaluate(request);
  const sensitivities = request.sensitivities.map((scenario) => ({
    ...scenario,
    result: evaluate(
      sensitivityRequest(request, scenario.path, scenario.value),
    ),
  }));
  const registration = runs.recordValuationCalculation(
    operation,
    {
      engineVersion: VALUATION_ENGINE_VERSION,
      methodVersion: savedValuationMethods(runs, operation.runId).version,
      currency: scope.security.currency,
      valueDate,
      request,
      result,
      sensitivities,
    },
    callId,
  );
  return readValuationCalculation(
    runs,
    operation.runId,
    registration.calculationId,
  );
}

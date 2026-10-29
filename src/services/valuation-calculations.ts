import { isDeepStrictEqual } from "node:util";
import catalogue from "../valuation/methods.json" with { type: "json" };
import {
  DETERMINISTIC_VALUATION_PROTOCOL,
  VALUATION_ENGINE_VERSION,
  VALUATION_METHODS_INPUT,
  type ValuationCalculation,
  type ValuationOutput,
  type ValuationRequest,
} from "../contracts/valuation.js";
import type {
  AgentReport,
  ValuationRecord,
} from "../contracts/agent-reports.js";
import type { DecisionProposal } from "../contracts/artifact-payloads.js";
import type { NumericClaim } from "../contracts/artifacts.js";
import type { TaskOperation } from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { evaluateValuation } from "../valuation/index.js";
import { valuationDependencyIds } from "../valuation/dependencies.js";
import type { RunService } from "./runs.js";
import {
  parseValuationRequest,
  sensitivityRequest,
  valuationInputAt,
} from "./valuation-inputs.js";
import { validateRoleValuation } from "./valuation.js";

function invalid(message: string): never {
  throw new ResearchError("INVALID_INPUT", `valuation: ${message}`);
}
export function savedValuationMethods(
  runs: RunService,
  runId: string,
): typeof catalogue {
  const catalog = runs.inputCatalog(runId);
  const entries = catalog.inputs.filter(
    ({ name }) => name === VALUATION_METHODS_INPUT,
  );
  if (entries.length !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "This run requires its recorded valuation methods.",
    );
  const methods = runs.readInput<typeof catalogue>(runId, entries[0]!.ref);
  if (methods.version !== catalog.versions.prompts.valuationMethods)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The recorded valuation methods do not match the run version.",
    );
  return methods;
}
function calculationRegistry(runs: RunService, runId: string) {
  const tasks = runs.numberContext(runId).tasks;
  const entries = new Map(
    runs
      .inputCatalog(runId)
      .inputs.filter((entry) => entry.calculation !== undefined)
      .map((entry) => [entry.ref.id, entry]),
  );
  function current(id: string): boolean {
    const calculation = entries.get(id)!.calculation!;
    const latest = tasks
      .find(({ taskId }) => taskId === calculation.taskId)!
      .attempts.at(-1)!;
    return (
      latest.number === calculation.attempt &&
      !["invalidated", "failed", "cancelled"].includes(latest.status) &&
      calculation.dependencies.every(current)
    );
  }
  return { entries, current };
}
export function valuationCalculationCatalog(runs: RunService, runId: string) {
  const { entries, current } = calculationRegistry(runs, runId);
  return [...entries.values()]
    .filter(({ ref }) => current(ref.id))
    .map(({ ref }) => {
      const record = runs.readInput<ValuationCalculation>(runId, ref);
      return {
        calculationId: record.calculationId,
        taskId: record.taskId,
        methodId: record.request.methodId,
        purpose: record.request.purpose,
        valueDate: record.valueDate,
        perShareValues: record.result.perShareValues,
        diagnostics: record.result.diagnostics,
        currency: record.currency,
        engineVersion: record.engineVersion,
      };
    });
}
export function readValuationCalculation(
  runs: RunService,
  runId: string,
  calculationId: string,
): ValuationCalculation {
  const { entries, current } = calculationRegistry(runs, runId);
  const entry = entries.get(calculationId);
  if (entry === undefined)
    invalid(`Calculation ${calculationId} is not registered in this run.`);
  if (!current(calculationId))
    invalid(
      `Calculation ${calculationId} or its dependency belongs to a superseded or unsuccessful attempt.`,
    );
  return runs.readInput<ValuationCalculation>(runId, entry.ref);
}
function dependencies(
  runs: RunService,
  runId: string,
  request: ValuationRequest,
  currency: string,
  valueDate: string,
): Map<string, ValuationOutput> {
  const ids = valuationDependencyIds(request);
  return new Map(
    ids.map((id) => {
      const record = readValuationCalculation(runs, runId, id);
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
  runs: RunService,
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
  const evaluate = (input: ValuationRequest) =>
    evaluateValuation(
      input,
      scope.security.currency,
      dependencies(
        runs,
        operation.runId,
        input,
        scope.security.currency,
        valueDate,
      ),
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
export interface ValuationSelection {
  companyProfile: string;
  methods: {
    methodId: string;
    suitability: string;
    calculationIds: string[];
    limitations: string[];
  }[];
  targetPriceBasis: string | null;
}
function materializeMethod(
  runs: RunService,
  runId: string,
  selection: ValuationSelection["methods"][number],
): ValuationRecord["methods"][number] {
  const scope = runs.view({ runId }).scope;
  const records = selection.calculationIds.map((id) => {
    const record = readValuationCalculation(runs, runId, id);
    if (
      record.request.methodId !== selection.methodId ||
      record.request.purpose !== "valuation" ||
      record.valueDate !== scope.date
    )
      invalid(
        "Valuation methods must reference matching research-date calculations.",
      );
    return record;
  });
  const values = records
    .flatMap(({ result }) => result.perShareValues)
    .filter((value) => value >= 0);
  if (records.length === 0 && selection.limitations.length === 0)
    invalid("Explain missing inputs when a method has no calculation.");
  return {
    methodId: selection.methodId,
    suitability: selection.suitability,
    calculationIds: [...selection.calculationIds],
    valueObject: "per_share",
    inputs: records.flatMap(({ request, calculationId }) =>
      request.provenance.map((entry) => ({
        name: `${calculationId}:${entry.path}`,
        value: `${JSON.stringify(valuationInputAt(request, entry.path))} (amountUnit=${request.amountUnit}; shareUnit=${request.shares.unit})`,
        kind: entry.kind,
        basis: entry.basis,
      })),
    ),
    assumptions: [
      ...new Set(records.flatMap(({ request }) => request.assumptions)),
    ],
    calculation: records.flatMap((record) => [
      `计算 ${record.calculationId}；算法版本 ${record.engineVersion}`,
      ...record.result.steps.map(
        ({ label, value, unit }) => `${label}=${value} ${unit}`,
      ),
    ]),
    valueRange:
      values.length === 0
        ? null
        : {
            low: Math.min(...values),
            high: Math.max(...values),
            unit: `${scope.security.currency}/share`,
          },
    sensitivity: records.flatMap((record) =>
      record.sensitivities.map(
        (scenario) =>
          `${scenario.label}：${scenario.path}=${scenario.value}；每股结果=${scenario.result.perShareValues.join(", ")} ${record.currency}/share；依据：${scenario.basis}`,
      ),
    ),
    limitations: [
      ...new Set([
        ...selection.limitations,
        ...records.flatMap(({ result }) => result.diagnostics),
      ]),
    ],
  };
}
export function materializeValuation(
  runs: RunService,
  runId: string,
  selection: ValuationSelection,
): ValuationRecord {
  const scope = runs.view({ runId }).scope;
  return {
    companyProfile: selection.companyProfile,
    valuationDate: scope.date,
    targetDate: decisionPolicy(scope.date).horizonEndDate,
    methods: selection.methods.map((method) =>
      materializeMethod(runs, runId, method),
    ),
    targetPriceBasis: selection.targetPriceBasis,
  };
}
export function materializeTargetPrice(
  runs: RunService,
  runId: string,
  calculationId: string,
): NonNullable<AgentReport<"decision_draft">["content"]["targetPrice"]> {
  const record = readValuationCalculation(runs, runId, calculationId);
  const scope = runs.view({ runId }).scope;
  if (
    record.request.purpose !== "target_price" ||
    record.valueDate !== decisionPolicy(scope.date).horizonEndDate ||
    record.result.perShareValues.length !== 1 ||
    record.result.perShareValues[0]! < 0
  )
    invalid(
      "A target price requires one nonnegative target-date calculated per-share value. Negative equity residuals remain available for analysis; retain targetPrice=null.",
    );
  return {
    calculationId,
    value: record.result.perShareValues[0]!,
    method: `${record.request.methodId}; engine=${record.engineVersion}`,
    assumptions: [...record.request.assumptions],
  };
}
export function validateCalculatedReport(
  runs: RunService,
  operation: TaskOperation,
  report: AgentReport,
): void {
  if (
    runs.inputCatalog(operation.runId).versions.prompts.roles !==
    DETERMINISTIC_VALUATION_PROTOCOL
  )
    return;
  validateRoleValuation(
    report,
    operation.taskId,
    runs.view(operation).scope,
    savedValuationMethods(runs, operation.runId).methods.map(({ id }) => id),
  );
  if ("valuation" in report.content && report.content.valuation != null) {
    const record = report.content.valuation;
    for (const method of record.methods) {
      if (method.calculationIds === undefined)
        invalid(
          "Use calculationIds; model-written valuation results are not accepted.",
        );
      const expected = materializeMethod(runs, operation.runId, {
        ...method,
        calculationIds: method.calculationIds,
      });
      for (const key of [
        "inputs",
        "assumptions",
        "calculation",
        "valueObject",
        "valueRange",
        "sensitivity",
        "limitations",
      ] as const)
        if (!isDeepStrictEqual(method[key], expected[key]))
          invalid(
            `Stored ${method.methodId}.${key} must equal the referenced calculation results.`,
          );
    }
  }
  if ("targetPrice" in report.content && report.content.targetPrice !== null) {
    const target = report.content.targetPrice;
    if (
      target.calculationId === undefined ||
      !isDeepStrictEqual(
        target,
        materializeTargetPrice(runs, operation.runId, target.calculationId),
      )
    )
      invalid(
        "The target price must be the immutable referenced calculation result.",
      );
  }
}

export function validateCalculatedTarget(
  proposal: DecisionProposal,
  claims: NumericClaim[],
  currency: string,
): void {
  const target = (proposal.report as AgentReport<"decision_draft">).content
    .targetPrice;
  if (target === null) {
    if (proposal.targetPrice !== null)
      invalid("The decision target price must match its calculated report.");
    return;
  }
  const input = proposal.targetPrice;
  if (input === null || input.kind !== "local")
    invalid(
      "The decision target price must reference its local calculated claim.",
    );
  const claim = claims.find(({ id }) => id === input.claimId);
  if (
    claim?.kind !== "estimated" ||
    !isDeepStrictEqual(
      {
        calculationId: claim.calculationId,
        value: claim.value,
        method: claim.method,
        assumptions: claim.assumptions,
        unit: claim.unit,
      },
      { ...target, unit: `${currency}/share` },
    )
  )
    invalid(
      "The decision target price must equal its calculated report and calculationId.",
    );
}

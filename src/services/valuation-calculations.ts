import { isDeepStrictEqual } from "node:util";
import catalogue from "../valuation/methods.json" with { type: "json" };
import {
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
import type { TaskDefinition } from "../contracts/workflow.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { decisionPolicy } from "../contracts/rating-policy.js";
import { evaluateValuation } from "../valuation/index.js";
import { formatNumber, valueText } from "../report/render.js";
import { valuationDependencyIds } from "../valuation/dependencies.js";
import {
  formatValuationDiagnostic,
  formatValuationStep,
} from "../report/valuation-labels.js";
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
  const { tasks, scope } = runs.numberContext(runId);
  const attempts = new Map(
    tasks.map((task) => [task.taskId, task.attempts.at(-1)!]),
  );
  const entries = new Map(
    runs
      .inputCatalog(runId)
      .inputs.filter((entry) => entry.calculation !== undefined)
      .map((entry) => [entry.ref.id, entry]),
  );
  const validity = new Map<string, boolean>();
  const records = new Map<string, ValuationCalculation>();
  function current(id: string): boolean {
    const known = validity.get(id);
    if (known !== undefined) return known;
    const calculation = entries.get(id)!.calculation!;
    const latest = attempts.get(calculation.taskId)!;
    const valid =
      latest.number === calculation.attempt &&
      !["invalidated", "failed", "cancelled"].includes(latest.status) &&
      calculation.dependencies.every(current);
    validity.set(id, valid);
    return valid;
  }
  function read(id: string): ValuationCalculation {
    const entry = entries.get(id);
    if (entry === undefined)
      invalid(`Calculation ${id} is not registered in this run.`);
    if (!current(id))
      invalid(
        `Calculation ${id} or its dependency belongs to a superseded or unsuccessful attempt.`,
      );
    let record = records.get(id);
    if (record === undefined) {
      record = runs.readInput<ValuationCalculation>(runId, entry.ref);
      records.set(id, record);
    }
    return record;
  }
  // A registry belongs to one synchronous operation; later calls observe redo/cancellation.
  return { scope, entries, current, read };
}
export function valuationCalculationCatalog(runs: RunService, runId: string) {
  const { entries, current } = calculationRegistry(runs, runId);
  const refs = [...entries.values()]
    .filter(({ ref }) => current(ref.id))
    .map(({ ref }) => ref);
  if (refs.length === 0) return [];
  return runs.readInputs<ValuationCalculation>(runId, refs).map((record) => {
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
  return calculationRegistry(runs, runId).read(calculationId);
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
  let registry: ReturnType<typeof calculationRegistry> | undefined;
  const read = (id: string) =>
    (registry ??= calculationRegistry(runs, operation.runId)).read(id);
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
  scope: ResearchScope,
  read: (id: string) => ValuationCalculation,
  selection: ValuationSelection["methods"][number],
): ValuationRecord["methods"][number] {
  const records = selection.calculationIds.map((id) => {
    const record = read(id);
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
      request.provenance.map((entry) => {
        const value = JSON.stringify(
          valuationInputAt(request, entry.path),
          (_key, input: unknown) =>
            typeof input === "number" ? Number(formatNumber(input)) : input,
        );
        return {
          name: `${calculationId}:${entry.path}`,
          value: `${value} (amountUnit=${request.amountUnit}; shareUnit=${request.shares.unit})`,
          kind: entry.kind,
          basis: entry.basis,
        };
      }),
    ),
    assumptions: [
      ...new Set(records.flatMap(({ request }) => request.assumptions)),
    ],
    calculation: records.flatMap((record) => [
      `计算 ${record.calculationId}；算法版本 ${record.engineVersion}`,
      ...record.result.steps.map((step) =>
        formatValuationStep(step, record.request.methodId),
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
      record.sensitivities.map((scenario) => {
        const values = scenario.result.perShareValues
          .map((value) => valueText(value, `${record.currency}/share`))
          .join(", ");
        return `${scenario.label}：${scenario.path}=${formatNumber(scenario.value)}；每股结果=${values}；依据：${scenario.basis}`;
      }),
    ),
    limitations: [
      ...new Set([
        ...selection.limitations,
        ...records.flatMap(({ result }) =>
          result.diagnostics.map(formatValuationDiagnostic),
        ),
      ]),
    ],
  };
}
export function materializeValuation(
  runs: RunService,
  runId: string,
  selection: ValuationSelection,
): ValuationRecord {
  const { scope, read } = calculationRegistry(runs, runId);
  return {
    companyProfile: selection.companyProfile,
    valuationDate: scope.date,
    targetDate: decisionPolicy(scope.date).horizonEndDate,
    methods: selection.methods.map((method) =>
      materializeMethod(scope, read, method),
    ),
    targetPriceBasis: selection.targetPriceBasis,
  };
}
export function materializeTargetPrice(
  runs: RunService,
  runId: string,
  calculationId: string,
): NonNullable<AgentReport<"decision_draft">["content"]["targetPrice"]> {
  const { scope, read } = calculationRegistry(runs, runId);
  return targetPrice(scope, read(calculationId));
}
function targetPrice(
  scope: ResearchScope,
  record: ValuationCalculation,
): NonNullable<AgentReport<"decision_draft">["content"]["targetPrice"]> {
  if (
    record.request.purpose !== "target_price" ||
    record.valueDate !== decisionPolicy(scope.date).horizonEndDate ||
    record.result.perShareValues.length !== 1 ||
    record.result.perShareValues[0]! < 0
  )
    invalid(
      "A target price requires one nonnegative target-date calculated per-share value. A negative equity residual supports solvency analysis; calculate an applicable common-share pricing scenario for the target price.",
    );
  return {
    calculationId: record.calculationId,
    value: record.result.perShareValues[0]!,
    method: `${record.request.methodId}; engine=${record.engineVersion}`,
    assumptions: [...record.request.assumptions],
  };
}
export function validateCalculatedReport(
  runs: RunService,
  runId: string,
  report: AgentReport,
  requirement: TaskDefinition["valuation"],
): void {
  const hasValuation =
    "valuation" in report.content && report.content.valuation != null;
  const hasTarget =
    "targetPrice" in report.content && report.content.targetPrice !== null;
  if (requirement === undefined && !hasValuation && !hasTarget) return;
  const { scope, read } = calculationRegistry(runs, runId);
  validateRoleValuation(
    report,
    requirement,
    scope,
    hasValuation
      ? savedValuationMethods(runs, runId).methods.map(({ id }) => id)
      : [],
  );
  if ("valuation" in report.content && report.content.valuation != null) {
    const record = report.content.valuation;
    for (const method of record.methods) {
      if (method.calculationIds === undefined)
        invalid(
          "Use calculationIds; model-written valuation results are not accepted.",
        );
      const expected = materializeMethod(scope, read, {
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
    if (
      requirement === "research" &&
      !record.methods.some(({ calculationIds }) => calculationIds!.length > 0)
    )
      invalid(
        "This task requires at least one saved research-date valuation calculation. Read the financial statement details, select an applicable model, justify forecast assumptions and call stock_calculate_valuation before submitting.",
      );
  }
  if ("targetPrice" in report.content && report.content.targetPrice !== null) {
    const target = report.content.targetPrice;
    if (
      target.calculationId === undefined ||
      !isDeepStrictEqual(target, targetPrice(scope, read(target.calculationId)))
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

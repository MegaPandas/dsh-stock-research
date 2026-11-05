import catalogue from "../../valuation/methods.json" with { type: "json" };
import { ResearchError } from "../../contracts/errors.js";
import type { RunReader } from "../../contracts/run-access.js";
import { VALUATION_METHODS_INPUT } from "../../contracts/valuation.js";
import type { ValuationCalculation } from "../../contracts/valuation.js";
import type { RunInputCatalog } from "../../contracts/runs.js";

type CalculationReader = Pick<
  RunReader,
  "numberContext" | "inputCatalog" | "readInput"
>;

function invalid(message: string): never {
  throw new ResearchError("INVALID_INPUT", `valuation: ${message}`);
}

export function savedValuationMethods(
  runs: Pick<RunReader, "inputCatalog" | "readInput">,
  runId: string,
): typeof catalogue {
  return readMethods(runs, runId, runs.inputCatalog(runId));
}

function readMethods(
  runs: Pick<RunReader, "readInput">,
  runId: string,
  catalog: RunInputCatalog,
): typeof catalogue {
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

function calculationIndex(
  runs: Pick<RunReader, "numberContext" | "inputCatalog">,
  runId: string,
) {
  const { tasks, scope } = runs.numberContext(runId);
  const attempts = new Map(
    tasks.map((task) => [task.taskId, task.attempts.at(-1)!]),
  );
  const catalog = runs.inputCatalog(runId);
  const entries = new Map(
    catalog.inputs
      .filter((entry) => entry.calculation !== undefined)
      .map((entry) => [entry.ref.id, entry]),
  );
  const validity = new Map<string, boolean>();
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
  return { scope, entries, current, catalog };
}

/** The reader belongs to one synchronous operation; later calls observe redo/cancellation. */
export function createValuationReader(runs: CalculationReader, runId: string) {
  let index: ReturnType<typeof calculationIndex> | undefined;
  const resolveIndex = () => (index ??= calculationIndex(runs, runId));
  let methodIds: string[] | undefined;
  const records = new Map<string, ValuationCalculation>();
  function read(id: string): ValuationCalculation {
    const { entries, current } = resolveIndex();
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
  return {
    get scope() {
      return resolveIndex().scope;
    },
    read,
    methodIds() {
      return (methodIds ??= readMethods(
        runs,
        runId,
        resolveIndex().catalog,
      ).methods.map(({ id }) => id));
    },
  };
}

export type ValuationReader = ReturnType<typeof createValuationReader>;

export function valuationCalculationCatalog(
  runs: Pick<RunReader, "numberContext" | "inputCatalog" | "readInputs">,
  runId: string,
) {
  const { entries, current } = calculationIndex(runs, runId);
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
  runs: CalculationReader,
  runId: string,
  calculationId: string,
): ValuationCalculation {
  return createValuationReader(runs, runId).read(calculationId);
}

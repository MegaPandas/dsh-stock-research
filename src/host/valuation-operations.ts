import type { ValuationCalculation } from "../contracts/valuation.js";
import type { RunCommands, RunReader } from "../contracts/run-access.js";
import { calculateValuation } from "../services/valuation/calculate.js";
import { readValuationCalculation } from "../services/valuation/records.js";
import {
  authorizeRun,
  taskOperation,
  type SessionBindings,
  type ResearchCaller,
} from "./bindings.js";

export interface ValuationOperations {
  calculate(
    value: unknown,
    requestId: string,
    caller: ResearchCaller,
  ): ValuationCalculation;
  read(
    runId: string,
    calculationId: string,
    caller: ResearchCaller,
  ): ValuationCalculation;
}

export function createValuationOperations(
  runs: Pick<
    RunReader,
    "numberContext" | "inputCatalog" | "readInput" | "view"
  > &
    Pick<
      RunCommands,
      "valuationCalculationForCall" | "recordValuationCalculation"
    >,
  bindings: SessionBindings,
): ValuationOperations {
  return {
    calculate(value, requestId, caller) {
      caller.signal.throwIfAborted();
      return calculateValuation(
        runs,
        taskOperation(bindings.require(caller.agent)),
        value,
        requestId,
      );
    },
    read(runId, calculationId, caller) {
      caller.signal.throwIfAborted();
      authorizeRun(bindings.require(caller.agent).binding, runId);
      return readValuationCalculation(runs, runId, calculationId);
    },
  };
}

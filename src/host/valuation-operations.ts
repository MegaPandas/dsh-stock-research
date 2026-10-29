import type { ValuationCalculation } from "../contracts/valuation.js";
import type { RunService } from "../services/runs.js";
import {
  calculateValuation,
  readValuationCalculation,
} from "../services/valuation-calculations.js";
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
  runs: RunService,
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

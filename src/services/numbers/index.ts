import type {
  NumberCheck,
  NumberChecker,
  NumberTarget,
} from "../../contracts/numbers.js";
import type { RunOperation } from "../../contracts/runs.js";
import type { ValuationCalculation } from "../../contracts/valuation.js";
import { NumberCheckSession, type NumberReads } from "./session.js";

export { NUMBER_CHECK_VERSION } from "./session.js";

export class NumberService implements NumberChecker {
  constructor(private readonly runs: NumberReads) {}

  checkNumbers(operation: RunOperation, target: NumberTarget): NumberCheck {
    return this.checkNumbersBatch(operation, [target])[0]!;
  }

  checkNumbersBatch(
    operation: RunOperation,
    targets: readonly NumberTarget[],
    readCalculation?: (id: string) => ValuationCalculation,
  ): NumberCheck[] {
    const captured = targets.map((target) => structuredClone(target));
    if (captured.length === 0) return [];
    const session = new NumberCheckSession(
      this.runs,
      operation.runId,
      readCalculation,
    );
    return captured.map((target) => session.check(target));
  }
}

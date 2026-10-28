import type {
  DigestModelInput,
  GenerateDigest,
} from "../../src/contracts/digests.js";
import type { TaskOperation } from "../../src/contracts/runs.js";

/** Submit one fixture draft through the domain validation boundary. */
export function oneDigest(
  generate: (
    input: DigestModelInput,
    signal: AbortSignal,
    operation: TaskOperation,
  ) => unknown | Promise<unknown>,
): GenerateDigest {
  return async (input, signal, operation, submit) => {
    return submit(await generate(input, signal, operation));
  };
}

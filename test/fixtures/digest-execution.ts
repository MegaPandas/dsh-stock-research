import type { GenerateDigest } from "../../src/contracts/digests.js";
import { handoffDigest } from "../../src/services/handoff-digest.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function digestGate() {
  return { started: deferred(), aborted: deferred(), released: deferred() };
}

/** Hold an owned execution until the test releases it, including after cancellation. */
export function gatedDigest(
  gate: ReturnType<typeof digestGate>,
): GenerateDigest {
  return async (input, signal, _operation, submit) => {
    const aborted = () => gate.aborted.resolve();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    gate.started.resolve();
    try {
      await gate.released.promise;
      signal.throwIfAborted();
      return submit(handoffDigest(input));
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  };
}

import type { Context } from "@deepseek-ai/cordis";
import { SubagentError } from "@deepseek-ai/dsh-subagent";

// SDK end events omit startup rollback and live capacity changes.
const CAPACITY_RECHECK_MS = 50;

function capacityChange(ctx: Context, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (cause?: unknown) => {
      clearTimeout(timer);
      release();
      signal.removeEventListener("abort", abort);
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const release = ctx.on("subagent/end", () => finish());
    const timer = setTimeout(finish, CAPACITY_RECHECK_MS);
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** A rejected capacity reservation has not created a child or accepted input. */
export async function admitChild<T>(
  ctx: Context,
  signal: AbortSignal,
  start: () => Promise<T>,
): Promise<T> {
  while (true) {
    signal.throwIfAborted();
    try {
      return await start();
    } catch (cause) {
      if (
        !(cause instanceof SubagentError) ||
        cause.code !== "ACTIVATION_LIMIT_REACHED"
      )
        throw cause;
      await capacityChange(ctx, signal);
    }
  }
}

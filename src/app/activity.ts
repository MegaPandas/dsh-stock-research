import { ResearchError } from "../contracts/errors.js";
import type { ResearchRuntime } from "../host/runtime.js";

const activities = new WeakMap<
  ResearchRuntime,
  { count: number; cleaning: boolean }
>();

function state(runtime: ResearchRuntime) {
  let value = activities.get(runtime);
  if (value === undefined) {
    value = { count: 0, cleaning: false };
    activities.set(runtime, value);
  }
  return value;
}

export async function withActivity<T>(
  runtime: ResearchRuntime,
  run: () => Promise<T>,
): Promise<T> {
  const release = holdActivity(runtime);
  try {
    return await run();
  } finally {
    release();
  }
}

export function holdActivity(runtime: ResearchRuntime): () => void {
  const value = state(runtime);
  if (value.cleaning)
    throw new ResearchError(
      "ACCESS_DENIED",
      "Stock research is being cleaned.",
    );
  value.count++;
  return () => {
    value.count--;
  };
}

export function beginCleanup(runtime: ResearchRuntime): void {
  const value = state(runtime);
  if (value.cleaning || value.count > 0 || runtime.isBusy())
    throw new ResearchError(
      "ACCESS_DENIED",
      "Cannot clean while stock research tasks are running.",
    );
  value.cleaning = true;
}

export function isApplicationBusy(runtime: ResearchRuntime): boolean {
  const value = state(runtime);
  return value.cleaning || value.count > 0 || runtime.isBusy();
}

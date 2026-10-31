import { ResearchError } from "../contracts/errors.js";

interface ActivityOwner {
  isBusy(): boolean;
}

const activities = new WeakMap<
  ActivityOwner,
  { count: number; cleaning: boolean }
>();

function state(runtime: ActivityOwner) {
  let value = activities.get(runtime);
  if (value === undefined) {
    value = { count: 0, cleaning: false };
    activities.set(runtime, value);
  }
  return value;
}

export async function withActivity<T>(
  runtime: ActivityOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = holdActivity(runtime);
  try {
    return await run();
  } finally {
    release();
  }
}

export function holdActivity(runtime: ActivityOwner): () => void {
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

export function beginCleanup(runtime: ActivityOwner): void {
  const value = state(runtime);
  if (value.cleaning || value.count > 0 || runtime.isBusy())
    throw new ResearchError(
      "ACCESS_DENIED",
      "Cannot clean while stock research tasks are running.",
    );
  value.cleaning = true;
}

export function isApplicationBusy(runtime: ActivityOwner): boolean {
  const value = state(runtime);
  return value.cleaning || value.count > 0 || runtime.isBusy();
}

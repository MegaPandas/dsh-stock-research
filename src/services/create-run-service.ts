import type { ISOTime } from "../contracts/data.js";
import type { RunAccess } from "../contracts/run-access.js";
import type { RunState } from "../contracts/runs.js";
import type { RunStore } from "../runs/store.js";
import { createRunProjector } from "./run-projections.js";
import { RunService } from "./runs.js";

export function createRunService(
  store: RunStore<RunState>,
  now: () => ISOTime,
): RunAccess {
  return new RunService(store, now, createRunProjector(store));
}

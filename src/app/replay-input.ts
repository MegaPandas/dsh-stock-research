import type { ReplayRunInput } from "../contracts/replay.js";
import {
  SOURCE_VERSIONS,
  COLLECTION_SOURCE_VERSIONS,
} from "../data/versions.js";
import type { RunService } from "../services/runs.js";
import { savedCoordinator } from "./coordinator-input.js";
import { DEEP_MODE_VERSION } from "./deep-plan.js";
import { QUICK_MODE_VERSION } from "./quick-plan.js";
import { researchVersions } from "./research-plan.js";

export function createReplayInput(
  runs: RunService,
  runId: string,
): ReplayRunInput {
  const { definition } = savedCoordinator(runs, runId);
  const saved = runs.inputCatalog(runId).versions.prompts;
  const versions = researchVersions(
    definition.mode === "quick" ? QUICK_MODE_VERSION : DEEP_MODE_VERSION,
    { ...SOURCE_VERSIONS, ...COLLECTION_SOURCE_VERSIONS },
  );
  const supported = {
    roles: ["11", "12", "13", "14", "15", "16", "17", "19", "20", "21", "22"],
    digest: ["10", "11", "12"],
    coordinator: ["4", "5", "6", "7", "8", "9", "10", "11"],
  };
  for (const key of ["roles", "digest", "coordinator"] as const) {
    const version = saved[key];
    if (version !== undefined && supported[key].includes(version))
      versions.prompts[key] = version;
  }
  return {
    replay: { runId },
    versions,
  };
}

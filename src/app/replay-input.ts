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
import { VALUATION_ENGINE_VERSION } from "../contracts/valuation.js";
import { ResearchError } from "../contracts/errors.js";

export function createReplayInput(
  runs: RunService,
  runId: string,
): ReplayRunInput {
  const { definition } = savedCoordinator(runs, runId);
  const recorded = runs.inputCatalog(runId).versions;
  const saved = recorded.prompts;
  if (
    saved.valuationEngine !== undefined &&
    saved.valuationEngine !== VALUATION_ENGINE_VERSION
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The recorded valuation engine is unavailable for replay; start a new research run. Saved reports and calculations remain readable.",
    );
  const versions = researchVersions(
    definition.mode === "quick" ? QUICK_MODE_VERSION : DEEP_MODE_VERSION,
    { ...SOURCE_VERSIONS, ...COLLECTION_SOURCE_VERSIONS },
  );
  const supported = {
    digest: ["10", "11", "12"],
    coordinator: ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13"],
  };
  if (
    [
      QUICK_MODE_VERSION,
      DEEP_MODE_VERSION,
      "quick/7",
      "quick/8",
      "deep/5",
      "deep/6",
    ].includes(recorded.mode)
  )
    versions.mode = recorded.mode;
  // Method knowledge is replayed from the saved input, independent of the installed catalogue.
  if (saved.valuationMethods !== undefined)
    versions.prompts.valuationMethods = saved.valuationMethods;
  for (const key of ["digest", "coordinator"] as const) {
    const version = saved[key];
    if (version !== undefined && supported[key].includes(version))
      versions.prompts[key] = version;
  }
  return {
    replay: { runId },
    versions,
  };
}

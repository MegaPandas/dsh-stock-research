import type { ReplayRunInput } from "../contracts/replay.js";
import {
  SOURCE_VERSIONS,
  COLLECTION_SOURCE_VERSIONS,
} from "../data/versions.js";
import type { RunReader } from "../contracts/run-access.js";
import { savedCoordinator } from "./coordinator-input.js";
import { DEEP_MODE_VERSION } from "./plan/deep.js";
import { QUICK_MODE_VERSION } from "./plan/quick.js";
import { researchVersions } from "./plan/versions.js";
import { VALUATION_ENGINE_VERSION } from "../contracts/valuation.js";
import { ResearchError } from "../contracts/errors.js";
import { savedValuationMethods } from "../services/valuation/records.js";

export function createReplayInput(
  runs: Pick<RunReader, "readDefinition" | "inputCatalog" | "readInput">,
  runId: string,
): ReplayRunInput {
  const { definition } = savedCoordinator(runs, runId);
  const recorded = runs.inputCatalog(runId).versions;
  const saved = recorded.prompts;
  if (saved.valuationEngine !== VALUATION_ENGINE_VERSION)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The recorded valuation engine is unavailable for replay; start a new research run. Saved reports and calculations remain readable.",
    );
  const versions = researchVersions(
    definition.mode === "quick" ? QUICK_MODE_VERSION : DEEP_MODE_VERSION,
    { ...SOURCE_VERSIONS, ...COLLECTION_SOURCE_VERSIONS },
  );
  // Method knowledge is replayed from the saved input, independent of the installed catalogue.
  versions.prompts.valuationMethods = savedValuationMethods(
    runs,
    runId,
  ).version;
  return {
    replay: { runId },
    versions,
  };
}

import { ResearchError } from "../contracts/errors.js";
import type { RunService } from "../services/runs.js";
import { COORDINATOR_PROMPT_VERSION } from "./coordinator-prompt.js";
import { ROLE_PROMPT_VERSION } from "./research-prompts.js";

export function savedCoordinator(runs: RunService, runId: string) {
  const definition = runs.readDefinition(runId);
  const catalog = runs.inputCatalog(runId);
  const inputs = catalog.inputs.filter(
    (input) => input.name === "prompt:coordinator",
  );
  const version = catalog.versions.prompts.coordinator;
  if (
    catalog.versions.prompts.roles !== ROLE_PROMPT_VERSION ||
    (version !== "4" &&
      version !== "5" &&
      version !== "6" &&
      version !== "7" &&
      version !== "8" &&
      version !== "9" &&
      version !== "10" &&
      version !== "11" &&
      version !== COORDINATOR_PROMPT_VERSION) ||
    inputs.length !== 1
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "This run does not have a supported research coordinator input.",
    );
  const prompt = runs.readInput<unknown>(runId, inputs[0]!.ref);
  if (typeof prompt !== "string" || prompt.trim() === "")
    throw new ResearchError(
      "STORAGE_FAILED",
      "Invalid saved coordinator prompt.",
    );
  return { definition, prompt };
}

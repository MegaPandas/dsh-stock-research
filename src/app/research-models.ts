import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { RunReader } from "../contracts/run-access.js";
import { ResearchError } from "../contracts/errors.js";
import { resolveModelOptions } from "./model-config.js";
import type { ModelConfig } from "../contracts/settings.js";

export const RESEARCH_MODELS_INPUT = "stock-research:models";

export interface ResearchModels {
  research: AgentOptions;
}

export function captureResearchModels(
  parent: Agent,
  researchOverride?: ModelConfig,
): ResearchModels {
  return { research: resolveModelOptions(parent, researchOverride) };
}

export function readResearchModels(
  runs: Pick<RunReader, "inputCatalog" | "readInput">,
  runId: string,
): ResearchModels | undefined {
  const inputs = runs
    .inputCatalog(runId)
    .inputs.filter(({ name }) => name === RESEARCH_MODELS_INPUT);
  if (inputs.length === 0) return undefined;
  if (inputs.length !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "Research requires one recorded model configuration.",
    );
  return runs.readInput<ResearchModels>(runId, inputs[0]!.ref);
}

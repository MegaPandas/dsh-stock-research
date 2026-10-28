import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { RunService } from "../services/runs.js";
import { ResearchError } from "../contracts/errors.js";
import {
  overrideModelOptions,
  resolveModelOptions,
  type ModelConfig,
} from "./model-config.js";

export const RESEARCH_MODELS_INPUT = "stock-research:models";

export interface ResearchModels {
  research: AgentOptions;
  digest: AgentOptions;
}

export function captureResearchModels(
  parent: Agent,
  researchOverride?: ModelConfig,
  digestOverride?: ModelConfig,
): ResearchModels {
  const research = resolveModelOptions(parent, researchOverride);
  return { research, digest: overrideModelOptions(research, digestOverride) };
}

export function readResearchModels(
  runs: RunService,
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

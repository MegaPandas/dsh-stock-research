import z from "@deepseek-ai/schemastery";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";
import { ResearchError } from "../contracts/errors.js";

export interface ModelConfig {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffortId | null;
}
const fields = {
  provider: z.string().pattern(/\S/),
  model: z.string().pattern(/\S/),
  reasoningEffort: z.union([
    z.const(null),
    z.transform(z.string().pattern(/\S/).required(), ReasoningEffortId),
  ]),
};
export const ModelConfig = z
  .transform(z.object(fields).required(), (value): ModelConfig => {
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key))
        throw new ResearchError(
          "INVALID_INPUT",
          `Unknown research model configuration field ${key}.`,
        );
    if (
      value.provider === null ||
      value.model === null ||
      (value.provider === undefined) !== (value.model === undefined)
    )
      throw new ResearchError(
        "INVALID_INPUT",
        "Research model overrides require both provider and model.",
      );
    return value as ModelConfig;
  })
  .required();

export function resolveModelOptions(
  parent: Agent,
  config?: ModelConfig,
): AgentOptions {
  return overrideModelOptions(parentAgentOptionsForDelegation(parent), config);
}

export function overrideModelOptions(
  inherited: AgentOptions,
  config?: ModelConfig,
): AgentOptions {
  const options = { ...inherited };
  if (config?.provider !== undefined) {
    options.provider = config.provider;
    options.model = config.model!;
    delete options.reasoningEffort;
  }
  if (config?.reasoningEffort === null) delete options.reasoningEffort;
  else if (config?.reasoningEffort !== undefined)
    options.reasoningEffort = config.reasoningEffort;
  return options;
}

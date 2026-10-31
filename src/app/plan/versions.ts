import packageMetadata from "../../../package.json" with { type: "json" };
import type { RunVersions } from "../../contracts/runs.js";
import type { SourceCodeVersions } from "../../contracts/sources.js";
import { DIGEST_HANDOFF_VERSION } from "../../contracts/digests.js";
import { VALUATION_ENGINE_VERSION } from "../../contracts/valuation.js";
import VALUATION_METHODS from "../../valuation/methods.json" with { type: "json" };
import { ROLE_PROMPT_VERSION } from "../research-prompts.js";
import { COORDINATOR_PROMPT_VERSION } from "../coordinator-prompt.js";

const PLUGIN_VERSION = packageMetadata.version;

export function researchVersions(
  modeVersion: string,
  sources: Readonly<Record<string, SourceCodeVersions>>,
): RunVersions {
  const adapters: Record<string, string> = {};
  const normalization: Record<string, string> = {};
  for (const [key, source] of Object.entries(sources)) {
    adapters[key] = source.adapterVersion;
    normalization[key] = source.normalizationVersion;
  }
  return {
    plugin: PLUGIN_VERSION,
    mode: modeVersion,
    prompts: {
      roles: ROLE_PROMPT_VERSION,
      digest: DIGEST_HANDOFF_VERSION,
      coordinator: COORDINATOR_PROMPT_VERSION,
      valuationMethods: VALUATION_METHODS.version,
      valuationEngine: VALUATION_ENGINE_VERSION,
    },
    skills: {},
    adapters,
    normalization,
  };
}

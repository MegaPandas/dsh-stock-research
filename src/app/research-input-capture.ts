import type { JsonValue } from "../contracts/json.js";
import type { QueryPolicy } from "../contracts/query.js";
import type { SourceDescription } from "../contracts/sources.js";
import { serializeJson } from "../json/serialize.js";
import {
  ARTIFACT_GUIDES,
  CALCULATION_RULES,
  ROLE_PROMPTS,
} from "./research-prompts.js";
import { PUBLIC_SEARCH_LIMITS } from "./public-research.js";

export const APPLICATION_INPUT_NAME = "stock-research:application";

export function captureApplicationInput(
  policy: QueryPolicy,
  sources: readonly SourceDescription[],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): JsonValue {
  return JSON.parse(
    serializeJson({
      schemaVersion: 2,
      publicSearchLimit,
      policy,
      sourceCatalogue: sources
        .filter((source) => source.capability !== null)
        .map(({ dataset, provider, capability }) => ({
          dataset,
          provider,
          capability,
        })),
      prompts: { ...ROLE_PROMPTS, valuation: CALCULATION_RULES },
      guides: ARTIFACT_GUIDES,
    }),
  ) as JsonValue;
}

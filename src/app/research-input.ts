import z from "@deepseek-ai/schemastery";
import type { JsonValue } from "../contracts/cache.js";
import { ResearchError } from "../contracts/errors.js";
import { serializeJson } from "../cache/json.js";
import type { RunService } from "../services/runs.js";
import type { SourceDescription } from "../services/query-sources.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import { ARTIFACT_GUIDES, ROLE_PROMPTS } from "./research-prompts.js";
import { PUBLIC_SEARCH_LIMITS } from "./public-research.js";

export const APPLICATION_INPUT_NAME = "stock-research:application";
const text = z.string().pattern(/\S/).required();
const policy = z
  .object({
    freshness: z
      .object({
        market: z.number().required(),
        fundamentals: z.number().required(),
        macro: z.number().required(),
      })
      .required(),
    secCiks: z.dict(text).required(),
  })
  .required();
const schema = z
  .object({
    schemaVersion: z.const(1).required(),
    publicSearchLimit: z
      .natural()
      .max(Number.MAX_SAFE_INTEGER)
      .default(PUBLIC_SEARCH_LIMITS.maxSearches),
    policy,
    sourceCatalogue: z.array(z.any().required()).required(),
    prompts: z
      .object({ analyst: text, discussion: text, manager: text })
      .required(),
    guides: z
      .object({
        analysis: text,
        debate: text,
        risk: text,
        plan: text,
        decision_draft: text,
      })
      .required(),
  })
  .required();

export function captureApplicationInput(
  policy: QueryToolPolicy,
  sources: readonly SourceDescription[],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): JsonValue {
  return JSON.parse(
    serializeJson({
      schemaVersion: 1,
      publicSearchLimit,
      policy,
      sourceCatalogue: sources
        .filter((source) => source.capability !== null)
        .map(({ dataset, provider, capability }) => ({
          dataset,
          provider,
          capability,
        })),
      prompts: ROLE_PROMPTS,
      guides: ARTIFACT_GUIDES,
    }),
  ) as JsonValue;
}

export function readApplicationInput(runs: RunService, runId: string) {
  const saved = runs
    .inputCatalog(runId)
    .inputs.filter((input) => input.name === APPLICATION_INPUT_NAME);
  if (saved.length !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "This run requires one recorded research application input.",
    );
  const input = runs.readInput<unknown>(runId, saved[0]!.ref);
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion !== 1
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The recorded research application input version is unavailable.",
    );
  try {
    return z.resolve(input, schema, {})[0] as ReturnType<typeof schema>;
  } catch (cause) {
    throw new ResearchError(
      "STORAGE_FAILED",
      "Invalid recorded research application input.",
      { cause },
    );
  }
}

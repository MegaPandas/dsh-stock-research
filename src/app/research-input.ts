import z from "@deepseek-ai/schemastery";
import { ResearchError } from "../contracts/errors.js";
import type { RunReader } from "../contracts/run-access.js";
import { APPLICATION_INPUT_NAME } from "./research-input-capture.js";

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
    schemaVersion: z.const(2).required(),
    publicSearchLimit: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
    policy,
    sourceCatalogue: z.array(z.any().required()).required(),
    prompts: z
      .object({
        analyst: text,
        discussion: text,
        manager: text,
        valuation: text,
      })
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

export function readApplicationInput(
  runs: Pick<RunReader, "inputCatalog" | "readInput">,
  runId: string,
) {
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
    input.schemaVersion !== 2
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

import z from "@deepseek-ai/schemastery";
import { ResearchError } from "../contracts/errors.js";
import type { RunReader } from "../contracts/run-access.js";
import {
  QUICK_SNAPSHOTS_INPUT,
  type QuickQuerySnapshot,
} from "./plan/protocol.js";

const text = z.string().pattern(/\S/).required();
const dataset = z
  .string()
  .pattern(/^(market|fundamentals|macro|returns|research)$/)
  .required();
const nullableTime = z.union([z.const(null), text]);
const schema = z
  .object({
    schemaVersion: z.const(1).required(),
    snapshots: z
      .array(
        z
          .object({
            taskId: text,
            scope: z
              .object({
                security: z
                  .object({
                    id: text,
                    market: z
                      .string()
                      .pattern(/^(US|CN)$/)
                      .required(),
                    symbol: text,
                    exchange: text,
                    currency: text,
                    timeZone: text,
                  })
                  .required(),
                date: text,
                cutoff: text,
              })
              .required(),
            request: z
              .object({
                dataset,
                provider: text,
                parameters: z.dict(z.any().required()).required(),
              })
              .required(),
            envelope: z
              .object({
                dataset,
                data: z.any().required(),
                source: z
                  .object({
                    provider: text,
                    url: text,
                    adapterVersion: text,
                    normalizationVersion: text,
                  })
                  .required(),
                asOf: text,
                availableAt: nullableTime,
                retrievedAt: text,
                cutoff: text,
                ageMs: z.number().required(),
                stale: z.boolean().required(),
                historicalKnowledge: z
                  .string()
                  .pattern(/^(verified|unverified)$/)
                  .required(),
                gaps: z
                  .array(
                    z
                      .object({
                        code: z
                          .string()
                          .pattern(
                            /^(missing|stale|unverified_time|incomparable)$/,
                          )
                          .required(),
                        field: text,
                        detail: text,
                      })
                      .required(),
                  )
                  .required(),
              })
              .required(),
          })
          .required(),
      )
      .required(),
  })
  .required();

export function readQuickSnapshots(
  runs: Pick<RunReader, "inputCatalog" | "readInput">,
  runId: string,
): QuickQuerySnapshot[] {
  const saved = runs
    .inputCatalog(runId)
    .inputs.filter((input) => input.name === QUICK_SNAPSHOTS_INPUT);
  if (saved.length === 0) return [];
  if (saved.length !== 1)
    throw new ResearchError(
      "STORAGE_FAILED",
      "Duplicate recorded quick query snapshots.",
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
      "The recorded quick query snapshot version is unavailable.",
    );
  try {
    z.resolve(input, schema, {});
    return (input as { snapshots: QuickQuerySnapshot[] }).snapshots;
  } catch (cause) {
    throw new ResearchError(
      "STORAGE_FAILED",
      "Invalid recorded quick query snapshots.",
      { cause },
    );
  }
}

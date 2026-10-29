import z from "@deepseek-ai/schemastery";
import { serializeJson } from "../cache/json.js";
import type { JsonValue } from "../contracts/cache.js";
import type {
  CollectionPacket,
  CollectionSnapshot,
} from "../contracts/collection.js";
import type { DataEnvelope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { EvidenceData } from "../contracts/query.js";
import type { ReplayEvidenceSource } from "../contracts/replay.js";
import type { OpenRunInput, TaskOperation } from "../contracts/runs.js";
import type { RunService } from "../services/runs.js";
import { extractCandidates } from "../services/candidates.js";
import { collectionSummary } from "../services/collection-view.js";
import { readQuickSnapshots } from "./quick-snapshots.js";

export const COLLECTION_INPUT = "stock-research:collection";
export function requireCollectionData(snapshot: CollectionSnapshot): void {
  if (!snapshot.packets.some((packet) => packet.id === "market.daily")) {
    const failures = snapshot.failures.filter(
      (failure) => failure.id === "market.daily",
    );
    throw new ResearchError(
      "DATA_INSUFFICIENT",
      `Daily market data is required before analysis.${failures.map((failure) => ` ${failure.provider}: ${failure.detail}`).join("")}${snapshot.recordPath === undefined ? "" : ` Collection record: ${snapshot.recordPath}`}`,
    );
  }
}
const text = z.string().pattern(/\S/).required();
const schema = z
  .object({
    schemaVersion: z.const(1).required(),
    scope: z.any().required(),
    packets: z
      .array(z.object({ id: text, envelope: z.any().required() }).required())
      .required(),
    failures: z
      .array(
        z
          .object({ id: text, provider: text, code: text, detail: text })
          .required(),
      )
      .required(),
  })
  .required();

export function attachCollection(
  input: OpenRunInput,
  snapshot: CollectionSnapshot,
): OpenRunInput {
  const captured = JSON.parse(serializeJson(snapshot)) as JsonValue;
  for (const { envelope } of snapshot.packets) {
    const key = `collection/${envelope.dataset}/${envelope.source.provider}`;
    input.versions.adapters[key] = envelope.source.adapterVersion;
    input.versions.normalization[key] = envelope.source.normalizationVersion;
  }
  input.inputs.push({ name: COLLECTION_INPUT, content: captured });
  return input;
}

export function readCollection(
  runs: RunService,
  runId: string,
): CollectionSnapshot | null {
  const saved = runs
    .inputCatalog(runId)
    .inputs.filter((input) => input.name === COLLECTION_INPUT);
  if (saved.length === 0) return null;
  if (saved.length !== 1)
    throw new ResearchError(
      "STORAGE_FAILED",
      "Duplicate deterministic collection inputs.",
    );
  const value = runs.readInput<unknown>(runId, saved[0]!.ref);
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1
  )
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      "The collection snapshot version is unavailable.",
    );
  try {
    z.resolve(value, schema, {});
    return value as CollectionSnapshot;
  } catch (cause) {
    throw new ResearchError(
      "STORAGE_FAILED",
      "Invalid deterministic collection snapshot.",
      { cause },
    );
  }
}

function belongsToTask(
  taskId: string,
  dataset: DataEnvelope<unknown>["dataset"],
  id: string,
): boolean {
  const equityBenchmark =
    /^benchmark\.(shanghai|shenzhen|csi300|chinext)\./.test(id);
  if (taskId === "analysis.market" || taskId === "analysis.sentiment") {
    return (
      dataset === "market" && (!id.startsWith("benchmark.") || equityBenchmark)
    );
  }
  if (taskId === "analysis.fundamentals" || taskId === "analysis.business")
    return dataset === "fundamentals";
  if (taskId === "analysis.macro" || taskId === "analysis.geopolitics")
    return (
      dataset === "macro" || (id.startsWith("benchmark.") && !equityBenchmark)
    );
  return false;
}

/** Register prepared inputs before the role starts; no query or network capability is exposed. */
export function registerCollectionSources(
  runs: RunService,
  operation: TaskOperation,
) {
  const snapshot = readCollection(runs, operation.runId);
  const scope = runs.view(operation).scope;
  const replay =
    snapshot === null ? null : runs.replaySnapshot(operation.runId);
  const originalTask = replay?.tasks.find(
    (task) => task.taskId === operation.taskId,
  );
  const originalEvidence =
    replay === null ? [] : runs.numberContext(replay.sourceRunId).evidence;
  const packets: {
    id: string;
    envelope: DataEnvelope<EvidenceData>;
    parameters: Record<string, unknown>;
  }[] =
    snapshot === null
      ? readQuickSnapshots(runs, operation.runId)
          .filter((item) => item.taskId === operation.taskId)
          .map((item, index) => ({
            id: `saved.${index}`,
            envelope: item.envelope,
            parameters: item.request.parameters,
          }))
      : snapshot.packets
          .filter((packet) =>
            belongsToTask(operation.taskId, packet.envelope.dataset, packet.id),
          )
          .map((packet) => ({
            ...packet,
            parameters: { table: packet.id, collectionVersion: 1 },
          }));
  return packets.map((packet) => {
    const envelope = structuredClone(packet.envelope);
    envelope.cutoff = scope.cutoff;
    envelope.ageMs = Date.parse(scope.cutoff) - Date.parse(envelope.asOf);
    const query = {
      dataset: envelope.dataset,
      provider: envelope.source.provider,
      parameters: packet.parameters,
    };
    const callId = `collection:${packet.id}`;
    let source: ReplayEvidenceSource | null = null;
    if (replay !== null) {
      const selected = originalEvidence.filter(
        (entry) =>
          entry.taskId === operation.taskId &&
          entry.attempt === originalTask?.attempt &&
          entry.callId === callId,
      );
      if (selected.length !== 1)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          `The original task ${operation.taskId} has no unique saved collection input for ${packet.id}.`,
        );
      source = {
        runId: replay.sourceRunId,
        evidenceId: selected[0]!.evidenceId,
      };
    }
    const existing = runs.evidenceForCall(operation, query, callId, source);
    const sourceRef =
      existing.sourceRef ??
      (existing.lineage === null
        ? runs.recordEvidence(
            operation,
            query,
            { envelope, candidates: extractCandidates(envelope) },
            callId,
          )
        : runs.replayEvidence(operation, query, callId, source));
    const saved = runs.readEvidence<EvidenceData>(sourceRef).envelope;
    const data = saved.data;
    return "table" in data
      ? { ...collectionSummary(packet.id, { ...saved, data }), sourceRef }
      : {
          id: packet.id,
          dataset: saved.dataset,
          sourceRef,
          recordCount:
            "bars" in data
              ? data.bars.length
              : "observations" in data
                ? data.observations.length
                : 0,
          quality: {
            stale: saved.stale,
            historicalKnowledge: saved.historicalKnowledge,
          },
        };
  });
}

export function collectionDirectory(packets: readonly CollectionPacket[]) {
  return packets.map(({ id, envelope }) => collectionSummary(id, envelope));
}

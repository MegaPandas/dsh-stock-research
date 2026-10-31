import type { CollectionSnapshot } from "../contracts/collection.js";
import type { JsonValue } from "../contracts/json.js";
import type { OpenRunInput } from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import { serializeJson } from "../json/serialize.js";

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

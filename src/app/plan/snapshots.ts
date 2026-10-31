import type { JsonValue } from "../../contracts/json.js";
import type { QuickQuerySnapshot } from "./protocol.js";
import { serializeJson } from "../../json/serialize.js";

export function captureQuickSnapshots(
  snapshots: readonly QuickQuerySnapshot[],
): JsonValue {
  return JSON.parse(
    serializeJson({ schemaVersion: 1, snapshots }),
  ) as JsonValue;
}

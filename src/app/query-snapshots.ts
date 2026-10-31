import type { JsonValue } from "../contracts/json.js";
import type { QuerySnapshot } from "../contracts/query.js";
import { serializeJson } from "../json/serialize.js";

export interface QuickQuerySnapshot extends QuerySnapshot {
  taskId: string;
}

export const QUICK_SNAPSHOTS_INPUT = "stock-research:queries";

export function captureQuickSnapshots(
  snapshots: readonly QuickQuerySnapshot[],
): JsonValue {
  return JSON.parse(
    serializeJson({ schemaVersion: 1, snapshots }),
  ) as JsonValue;
}

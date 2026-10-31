import type { ContentRef } from "./storage.js";

export interface RunLineage {
  sourceRunId: string;
  sourceRevision: number;
  snapshotRef: ContentRef;
}

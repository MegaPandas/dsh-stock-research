import type { ArtifactRef } from "./data.js";

export function artifactKey(ref: ArtifactRef): string {
  return JSON.stringify([ref.runId, ref.artifactId, ref.revision]);
}

import { createHash } from "node:crypto";

export const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// This namespace and encoding are persistent lookup contracts, not cache keys.
export function creationRunId(key: string): string {
  const bytes = createHash("sha256")
    .update("stock-research:create:v1\0")
    .update(key)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isKeyedRunId(runId: string): boolean {
  return runId[14] === "8";
}

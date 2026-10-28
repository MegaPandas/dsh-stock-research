import type {
  DataEnvelope,
  DataGap,
  EvidenceRef,
  ISOTime,
  ResearchScope,
} from "./data.js";
import type { MemoryRef } from "./memory.js";
import type {
  PriceReturnsData,
  PriceReturnsQuery,
  QueryResponse,
} from "./query.js";
import type { RunOperation } from "./runs.js";

export interface RememberOperation extends RunOperation {
  /** Authorized review scope; its security must match the linked run. */
  scope: ResearchScope;
}
export interface RememberInput {
  previous: MemoryRef | null;
  outcome: string;
  note: string;
  evidence: EvidenceRef[];
  returns:
    | { kind: "query"; request: PriceReturnsQuery }
    | { kind: "unavailable"; gaps: [DataGap, ...DataGap[]] };
}
export interface MemoryReturnSnapshot {
  scope: ResearchScope;
  request: PriceReturnsQuery;
  envelope: Omit<
    DataEnvelope<Omit<PriceReturnsData, "market">>,
    "candidateClaims"
  >;
}
export interface MemoryEntry {
  ref: MemoryRef;
  previous: MemoryRef | null;
  runId: string;
  securityId: string;
  recordedAt: ISOTime;
  identity: string;
  outcome: string;
  note: string;
  evidence: EvidenceRef[];
  returns:
    | { kind: "recorded"; snapshot: MemoryReturnSnapshot }
    | { kind: "unavailable"; gaps: [DataGap, ...DataGap[]] };
}
export interface RecallQuery {
  runId: string | null;
  /** Case-insensitive literal substring over outcome and note. */
  text: string | null;
  limit: number;
}
export interface MemoryReceipt {
  scope: string;
  requestId: string;
  request: string;
  ref: MemoryRef;
}
export interface MemoryState {
  stateVersion: 1;
  receipts: MemoryReceipt[];
}
export type QueryMemoryReturns = (
  scope: ResearchScope,
  request: PriceReturnsQuery,
  signal?: AbortSignal,
) => Promise<QueryResponse<PriceReturnsQuery>>;

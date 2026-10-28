export type ISOTime = string;
export type LocalDate = string;
export type Mode = "quick" | "deep" | "ask";
export type Dataset =
  "market" | "fundamentals" | "macro" | "returns" | "research";

export interface Security {
  id: string;
  market: "US" | "CN";
  symbol: string;
  exchange: string;
  currency: string;
  timeZone: string;
}

export interface ResearchScope {
  security: Security;
  date: LocalDate;
  cutoff: ISOTime;
}

export interface ArtifactRef {
  runId: string;
  artifactId: string;
  revision: number;
}

export interface SourceRef {
  runId: string;
  evidenceId: string;
  selector: string;
}
export type EvidenceRef = SourceRef | ArtifactRef;

export interface DataGap {
  code: "missing" | "stale" | "unverified_time" | "incomparable";
  field: string;
  detail: string;
}

export interface CandidateClaim {
  candidateId: string;
  label: string;
  value: number;
  unit: string;
  asOf: ISOTime;
  source: SourceRef;
}

export interface DataEnvelope<T> {
  dataset: Dataset;
  data: T;
  source: {
    provider: string;
    url: string;
    adapterVersion: string;
    normalizationVersion: string;
  };
  asOf: ISOTime;
  availableAt: ISOTime | null;
  retrievedAt: ISOTime;
  cutoff: ISOTime;
  ageMs: number;
  stale: boolean;
  historicalKnowledge: "verified" | "unverified";
  gaps: DataGap[];
  candidateClaims?: CandidateClaim[];
}

export interface EvidenceRecord<T> {
  evidenceId: string;
  runId: string;
  taskId: string;
  attempt: number;
  request: {
    dataset: Dataset;
    provider: string;
    securityId: string;
    parameters: Record<string, unknown>;
  };
  envelope: DataEnvelope<T>;
  recordedAt: ISOTime;
  replayedFrom?: SourceRef;
}

export type PriceAdjustment =
  "unadjusted" | "split_adjusted" | "total_return_adjusted";

export interface MarketBar {
  date: LocalDate;
  asOf: ISOTime;
  availableAt: ISOTime | null;
  sessionComplete: boolean;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface MarketData {
  currency: string;
  adjustment: PriceAdjustment;
  bars: MarketBar[];
}

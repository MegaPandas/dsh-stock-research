import type {
  DataEnvelope,
  Dataset,
  ISOTime,
  LocalDate,
  PriceAdjustment,
  ResearchScope,
  SourceRef,
} from "./data.js";

export interface CollectionColumn {
  label: string;
  unit: string;
  price?: boolean;
}

export interface CollectionRow {
  date: LocalDate;
  periodStart?: LocalDate;
  publishedDate?: LocalDate | null;
  filing?: { accession: string; form: string; url: string };
  asOf: ISOTime;
  availableAt: ISOTime | null;
  complete: boolean;
  values: Record<string, number | null>;
}

/** Source tables and explicitly labeled financial metrics derived from collected inputs. */
export interface CollectedTableData {
  table: string;
  title: string;
  columns: Record<string, CollectionColumn>;
  rows: CollectionRow[];
  currency?: string;
  adjustment?: PriceAdjustment;
  interval?: "1d" | "1wk" | "1mo";
  basis?: string;
  attributes?: Record<string, string>;
}

export type CollectionDataset = Extract<
  Dataset,
  "market" | "fundamentals" | "macro"
>;

export interface CollectionTask {
  id: string;
  dataset: CollectionDataset;
  provider: string;
  endpoint?: string;
  run(signal?: AbortSignal): Promise<DataEnvelope<CollectedTableData>>;
  fallback?: CollectionTask;
}

export interface CollectionPacket {
  id: string;
  envelope: DataEnvelope<CollectedTableData>;
}

export interface CollectionReadSource extends CollectionPacket {
  sourceRef?: SourceRef;
}

export interface CollectionSummary {
  id: string;
  dataset: Dataset;
  title: string;
  recordCount: number;
  range: { from: LocalDate; to: LocalDate } | null;
  interval?: CollectedTableData["interval"];
  basis?: string;
  quality: {
    stale: boolean;
    historicalKnowledge: DataEnvelope<unknown>["historicalKnowledge"];
    missingValues: number;
  };
}

export type CollectionReadRequest =
  | { kind: "schema"; table: string }
  | {
      kind: "rows";
      table: string;
      fields: string[];
      offset: number;
      limit: number;
      dateFrom?: LocalDate;
      dateTo?: LocalDate;
    };

export interface CollectionFailure {
  id: string;
  provider: string;
  code: string;
  detail: string;
  endpoint?: string;
  attempt?: number;
  durationMs?: number;
  error?: CollectionError;
}

export interface CollectionError {
  name: string;
  message: string;
  code?: string;
  cause?: CollectionError;
  errors?: CollectionError[];
}

export interface CollectionAttempt {
  id: string;
  provider: string;
  endpoint?: string;
  attempt: number;
  startedAt: ISOTime;
  durationMs: number;
  outcome: "success" | "failed" | "cancelled";
  error?: CollectionError;
}

export interface CollectionDiagnostics {
  startedAt: ISOTime;
  finishedAt: ISOTime;
  cacheHits: number;
  cacheMisses: number;
  attempts: CollectionAttempt[];
}

export interface CollectionSnapshot {
  schemaVersion: 1;
  scope: ResearchScope;
  packets: CollectionPacket[];
  failures: CollectionFailure[];
  diagnostics?: CollectionDiagnostics;
  recordPath?: string;
}

export interface CollectionRecord {
  schemaVersion: 1;
  status: "complete" | "missing_required" | "failed" | "cancelled";
  snapshot: CollectionSnapshot;
  error?: CollectionError;
}

export interface CollectionProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  cacheHits: number;
  cacheMisses: number;
  current?: { id: string; provider: string };
  failures?: CollectionFailure[];
  recordPath?: string;
}

import type { Dataset, ISOTime } from "./data.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface QueryCacheKey {
  provider: string;
  securityId: string;
  dataset: Dataset;
  cutoff: ISOTime;
  parameters: Readonly<Record<string, JsonValue>>;
  adapterVersion: string;
  normalizationVersion: string;
}

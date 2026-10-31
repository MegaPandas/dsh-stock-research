import type { Dataset, ISOTime } from "./data.js";
import type { JsonValue } from "./json.js";

export type QueryCachePolicy = Record<Exclude<Dataset, "returns">, number>;

export interface QueryCacheKey {
  provider: string;
  securityId: string;
  dataset: Dataset;
  cutoff: ISOTime;
  parameters: Readonly<Record<string, JsonValue>>;
  adapterVersion: string;
  normalizationVersion: string;
}

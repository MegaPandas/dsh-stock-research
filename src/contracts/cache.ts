import type { Dataset, ISOTime } from "./data.js";
import type { JsonValue } from "./json.js";

export interface QueryCacheKey {
  provider: string;
  securityId: string;
  dataset: Dataset;
  cutoff: ISOTime;
  parameters: Readonly<Record<string, JsonValue>>;
  adapterVersion: string;
  normalizationVersion: string;
}

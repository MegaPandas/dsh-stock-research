import type { HttpClientOptions } from "./http.js";
import type { QueryCachePolicy, QueryPolicy } from "./query.js";

export const SOURCE_IDS = [
  "yahoo",
  "eastmoney-market",
  "tencent",
  "sec",
  "eastmoney-income",
  "sina",
  "xueqiu",
  "fred",
  "china-macro",
  "benchmarks",
  "dsh-web",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface ModelConfig {
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
}

export interface ResearchConfig {
  dataRoot: string;
  enabledSources: SourceId[];
  http: HttpClientOptions;
  cache: { maxEntries: number; ttl: QueryCachePolicy };
  policy: QueryPolicy;
  secUserAgent?: string;
  xueqiuCookie?: string;
}

export interface ApplicationConfig {
  runtime: ResearchConfig;
  model?: ModelConfig;
  publicSearchLimit?: number;
}

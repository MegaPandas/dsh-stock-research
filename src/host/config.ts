import z from "@deepseek-ai/schemastery";
import type { QueryCachePolicy } from "../contracts/query.js";
import { ResearchError } from "../contracts/errors.js";
import type { HttpClientOptions } from "../data/http.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";

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
export interface ResearchConfig {
  dataRoot: string;
  enabledSources: SourceId[];
  http: HttpClientOptions;
  cache: { maxEntries: number; ttl: QueryCachePolicy };
  policy: QueryToolPolicy;
  secUserAgent?: string;
  xueqiuCookie?: string;
}

const MAX_TIMER_MS = 2_147_483_647;
const text = z.string().pattern(/\S/).required();
const duration = z
  .transform(z.number().min(0).required(), (value) => {
    if (!Number.isFinite(value))
      throw new ResearchError("INVALID_INPUT", "Durations must be finite.");
    return value;
  })
  .required();
function closed<T extends Parameters<typeof z.object>[0]>(fields: T) {
  return z
    .transform(z.object(fields), (value) => {
      for (const key of Object.keys(value))
        if (!Object.hasOwn(fields, key))
          throw new ResearchError(
            "INVALID_INPUT",
            `Unknown configuration field ${key}.`,
          );
      return value;
    })
    .required();
}
const schema = closed({
  dataRoot: text,
  enabledSources: z
    .array(z.union(SOURCE_IDS.map((id) => z.const(id))))
    .required(),
  http: closed({
    timeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
    maxConcurrency: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    minIntervalMs: z.natural().max(MAX_TIMER_MS).required(),
  }),
  cache: closed({
    maxEntries: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    ttl: closed({
      market: duration,
      fundamentals: duration,
      macro: duration,
      research: duration,
    }),
  }),
  policy: closed({
    freshness: closed({
      market: duration,
      fundamentals: duration,
      macro: duration,
    }),
    secCiks: z
      .dict(
        z
          .string()
          .pattern(/^(?!0000000000)\d{10}$/)
          .required(),
        text,
      )
      .required(),
  }),
  secUserAgent: text.required(false),
  xueqiuCookie: z.string().required(false),
});

export const Config = z
  .transform(schema, (value): ResearchConfig => {
    const config = value as ResearchConfig;
    if (
      config.xueqiuCookie === null ||
      (config.xueqiuCookie !== undefined && /[\r\n]/.test(config.xueqiuCookie))
    )
      throw new ResearchError(
        "INVALID_INPUT",
        "Xueqiu Cookie must be a single-line string when supplied.",
      );
    if (
      config.enabledSources.includes("xueqiu") &&
      !config.xueqiuCookie?.trim()
    )
      throw new ResearchError(
        "INVALID_INPUT",
        "The enabled Xueqiu source requires a Cookie.",
      );
    if (config.secUserAgent === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "SEC User-Agent must be a string when supplied.",
      );
    if (
      config.enabledSources.includes("sec") &&
      config.secUserAgent === undefined
    )
      return {
        ...config,
        enabledSources: config.enabledSources.filter(
          (source) => source !== "sec",
        ),
      };
    return config;
  })
  .required();

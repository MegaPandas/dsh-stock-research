export const DAILY_BAR_VERSIONS = {
  adapterVersion: "1",
  normalizationVersion: "2",
} as const;

/** Installed code versions are available without enabling or contacting a source. */
export const SOURCE_VERSIONS = {
  "market/yahoo": { ...DAILY_BAR_VERSIONS, adapterVersion: "2" },
  "market/eastmoney": { ...DAILY_BAR_VERSIONS, adapterVersion: "2" },
  "market/tencent": DAILY_BAR_VERSIONS,
  "fundamentals/sec": { adapterVersion: "1", normalizationVersion: "1" },
  "fundamentals/eastmoney": { adapterVersion: "1", normalizationVersion: "1" },
  "fundamentals/sina": { adapterVersion: "1", normalizationVersion: "1" },
  "macro/fred": { adapterVersion: "1", normalizationVersion: "1" },
  "research/dsh-web": { adapterVersion: "1", normalizationVersion: "1" },
} as const;
export const COLLECTION_VERSION = "3";
export const FINANCIAL_METRICS_VERSION = "2";
export const COLLECTION_SOURCE_VERSIONS = Object.fromEntries(
  [
    "market/eastmoney",
    "market/tencent",
    "market/sina",
    "market/xueqiu",
    "fundamentals/eastmoney",
    "fundamentals/xueqiu",
    "macro/eastmoney",
    "macro/mofcom",
    "market/yahoo",
    "fundamentals/sec",
    "macro/fred",
  ].map((source) => [
    `collection/${source}`,
    {
      adapterVersion: COLLECTION_VERSION,
      normalizationVersion: COLLECTION_VERSION,
    },
  ]),
);
export interface SourceCodeVersions {
  adapterVersion: string;
  normalizationVersion: string;
}

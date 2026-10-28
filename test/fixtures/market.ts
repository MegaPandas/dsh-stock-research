import type {
  DataEnvelope,
  MarketData,
  Security,
} from "../../src/contracts/data.js";

export const US_SECURITY: Security = {
  id: "US:NVDA",
  market: "US",
  symbol: "NVDA",
  exchange: "NASDAQ",
  currency: "USD",
  timeZone: "America/New_York",
};

export const CN_SECURITY: Security = {
  id: "CN:600519.SH",
  market: "CN",
  symbol: "600519.SH",
  exchange: "SH",
  currency: "CNY",
  timeZone: "Asia/Shanghai",
};

// Synthetic prices for deterministic calculations, not an external market record.
export const MARKET_FIXTURE: DataEnvelope<MarketData> = {
  dataset: "market",
  data: {
    currency: "USD",
    adjustment: "unadjusted",
    bars: [
      {
        date: "2024-01-02",
        asOf: "2024-01-02T21:00:00.000Z",
        availableAt: "2024-01-02T21:00:00.000Z",
        sessionComplete: true,
        open: 9,
        high: 11,
        low: 8,
        close: 10,
        volume: 100,
      },
      {
        date: "2024-01-03",
        asOf: "2024-01-03T21:00:00.000Z",
        availableAt: "2024-01-03T21:00:00.000Z",
        sessionComplete: true,
        open: 10,
        high: 13,
        low: 9,
        close: 12,
        volume: 200,
      },
      {
        date: "2024-01-04",
        asOf: "2024-01-04T21:00:00.000Z",
        availableAt: "2024-01-04T21:00:00.000Z",
        sessionComplete: true,
        open: 12,
        high: 14,
        low: 10,
        close: 11,
        volume: 150,
      },
      {
        date: "2024-01-05",
        asOf: "2024-01-05T21:00:00.000Z",
        availableAt: "2024-01-05T21:00:00.000Z",
        sessionComplete: true,
        open: 11,
        high: 15,
        low: 11,
        close: 14,
        volume: 300,
      },
      {
        date: "2024-01-08",
        asOf: "2024-01-08T21:00:00.000Z",
        availableAt: "2024-01-08T21:00:00.000Z",
        sessionComplete: true,
        open: 14,
        high: 16,
        low: 12,
        close: 13,
        volume: 250,
      },
    ],
  },
  source: {
    provider: "fixture",
    url: "https://example.invalid/market.json",
    adapterVersion: "1",
    normalizationVersion: "1",
  },
  asOf: "2024-01-08T21:00:00.000Z",
  availableAt: "2024-01-08T21:00:00.000Z",
  retrievedAt: "2024-01-08T22:00:00.000Z",
  cutoff: "2024-01-08T22:00:00.000Z",
  ageMs: 3_600_000,
  stale: false,
  historicalKnowledge: "verified",
  gaps: [],
};

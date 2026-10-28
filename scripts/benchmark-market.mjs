import { Buffer } from "node:buffer";
import console from "node:console";
import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import {
  EastmoneyMarketAdapter,
  HttpClient,
  TencentMarketAdapter,
  YahooMarketAdapter,
} from "@megapandas/dsh-stock-research/core";

const samples = [
  [
    YahooMarketAdapter,
    "yahoo-nvda",
    {
      id: "US:NVDA",
      market: "US",
      symbol: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      timeZone: "America/New_York",
    },
  ],
  [
    EastmoneyMarketAdapter,
    "eastmoney-600519",
    {
      id: "CN:600519.SH",
      market: "CN",
      symbol: "600519.SH",
      exchange: "SH",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
  ],
  [
    TencentMarketAdapter,
    "tencent-600519",
    {
      id: "CN:600519.SH",
      market: "CN",
      symbol: "600519.SH",
      exchange: "SH",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
  ],
];
const iterations = 500;
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0].model,
    iterations,
    batches: 5,
    network: false,
  }),
);
for (const [Adapter, fixture, security] of samples) {
  const text = await readFile(
    new URL(`../test/fixtures/sources/${fixture}.json`, import.meta.url),
    "utf8",
  );
  const http = new HttpClient({
    timeoutMs: 10_000,
    maxConcurrency: 1,
    minIntervalMs: 0,
  });
  let requests = 0;
  http.getText = async () => {
    requests++;
    return text;
  };
  const adapter = new Adapter(http);
  const query = {
    scope: { security, date: "2024-01-09", cutoff: "2024-01-09T23:00:00.000Z" },
    startDate: "2024-01-02",
    maxAgeMs: 86_400_000,
  };
  try {
    for (let warmup = 0; warmup < 20; warmup++) await adapter.query(query);
    requests = 0;
    const batches = [];
    for (let batch = 0; batch < 5; batch++) {
      const start = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++)
        await adapter.query(query);
      batches.push((performance.now() - start) / iterations);
    }
    batches.sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        provider: adapter.capability.provider,
        payloadBytes: Buffer.byteLength(text),
        bars: 6,
        medianMsPerQuery: batches[2],
        sourceCallsPerQuery: requests / (iterations * 5),
      }),
    );
  } finally {
    await http.close();
  }
}

import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { calculateIndicators } from "dsh-stock-research/core";

const requests = [
  { kind: "sma", period: 20 },
  { kind: "ema", period: 20 },
  { kind: "rsi", period: 14 },
  { kind: "macd", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { kind: "boll", period: 20, deviations: 2 },
  { kind: "atr", period: 14 },
  { kind: "vwma", period: 20 },
  { kind: "mfi", period: 14 },
];
const DAY_MS = 86_400_000;
const START_MS = Date.parse("2000-01-01T21:00:00.000Z");
const SAMPLE_COUNT = 5;

function measure(size) {
  // Synthetic daily observations; this benchmark does not model an exchange calendar.
  const data = {
    currency: "USD",
    adjustment: "unadjusted",
    bars: Array.from({ length: size }, (_, index) => {
      const close = 100 + (index % 101) / 10 + Math.sin(index / 20);
      const time = new Date(START_MS + index * DAY_MS).toISOString();
      return {
        date: time.slice(0, 10),
        asOf: time,
        availableAt: time,
        sessionComplete: true,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000 + (index % 100),
      };
    }),
  };
  calculateIndicators(data, requests);
  calculateIndicators(data, requests);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const durations = [];
  let results;
  for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
    const started = performance.now();
    results = calculateIndicators(data, requests);
    durations.push(performance.now() - started);
  }
  globalThis.gc();
  const retainedHeapBytes = process.memoryUsage().heapUsed - before;
  durations.sort((left, right) => left - right);
  return {
    bars: size,
    indicators: requests.length,
    samples: SAMPLE_COUNT,
    medianMs: Number(durations[Math.floor(SAMPLE_COUNT / 2)].toFixed(3)),
    retainedHeapBytes,
    outputPoints: results.reduce(
      (count, result) => count + result.values.length,
      0,
    ),
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0].model,
      measurements: [measure(10_000), measure(100_000)],
    },
    null,
    2,
  )}\n`,
);

import { Buffer } from "node:buffer";
import console from "node:console";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const entry = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL("../dist/core.mjs", import.meta.url);
const importStart = performance.now();
const { parseAgentReport } = await import(entry.href);
const importMs = performance.now() - importStart;
const samples = {
  ask: {
    summary: "固定快照支持当前结论。",
    content: { explanation: ["盈利变化来自产品组合。"], limitations: [] },
  },
  digest: {
    summary: "汇总已验收角色的固定交接。",
    content: {
      keyPoints: Array.from({ length: 24 }, () =>
        "产品结构改善影响盈利。".repeat(8),
      ),
      disagreements: [],
      riskSummaries: Array.from({ length: 24 }, (_, index) => ({
        issueId: `risk.${index}`,
        text: "终端价格下调时重新检验利润率与估值假设。",
      })),
      openQuestions: [],
    },
  },
  review: {
    summary: "逐项比较原判断与后续观察。",
    content: {
      comparisons: Array.from({ length: 64 }, () => ({
        original: "产品结构将改善利润率。",
        observed: "新产品占比提高，价格折扣扩大。",
        implication: "分别核实组合收益与折扣影响后调整预测。",
      })),
      lessons: ["分开跟踪销量、产品结构和成交价格。"],
      followUp: [],
    },
  },
};
const warmup = 50;
const batches = 5;
const iterations = 500;
const results = {};
for (const [kind, value] of Object.entries(samples)) {
  const coldStart = performance.now();
  parseAgentReport(kind, value);
  const firstParseMs = performance.now() - coldStart;
  for (let i = 0; i < warmup; i++) parseAgentReport(kind, value);
  const times = [];
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) parseAgentReport(kind, value);
    times.push((performance.now() - start) / iterations);
  }
  times.sort((a, b) => a - b);
  results[kind] = {
    inputBytes: Buffer.byteLength(JSON.stringify(value)),
    firstParseMs,
    minimumBatchAverageMs: times[0],
    medianBatchAverageMs: times[Math.floor(batches / 2)],
    maximumBatchAverageMs: times.at(-1),
  };
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      importMs,
      warmup,
      batches,
      iterationsPerBatch: iterations,
      results,
    },
    null,
    2,
  ),
);

import { expect, it } from "vitest";
import type { ResearchJobRecord } from "../../src/contracts/research-progress.js";
import { researchLog } from "../../src/client/research-log.js";

function collection(text: string): ResearchJobRecord {
  return {
    type: "research/progress",
    progress: {
      state: {
        status: "preparing",
        phase: {
          kind: "collection",
          counts: {
            completed: 2,
            total: 3,
            succeeded: 1,
            failed: 1,
            cacheHits: 4,
            cacheMisses: 2,
          },
        },
        identity: { symbol: "002594.SZ", date: "2024-01-03", mode: "quick" },
        operationIds: [],
      },
      text,
    },
  };
}

it("reads semantic fields independently of translated or misleading prose", () => {
  const raw = [
    "采集数据 99/100 · 成功 99，缺失 1",
    "等待主 Agent 验收：analysis",
    "market.daily · source · Error: unavailable",
  ].join("\n");
  expect(researchLog(raw)).toEqual({
    progress: undefined,
    collection: undefined,
    entries: raw.split("\n").map((text) => ({ kind: "message", text })),
  });
  for (const text of [
    "Preparing input",
    "等待主 Agent 验收：analysis",
    "采集数据 99/100",
  ]) {
    const output = researchLog(JSON.stringify(collection(text)) + "\n");
    expect(output.collection).toEqual({
      completed: 2,
      total: 3,
      succeeded: 1,
      failed: 1,
      cacheHits: 4,
      cacheMisses: 2,
    });
    expect(output.progress?.state.phase.kind).toBe("collection");
    expect(output.progress?.state.identity?.symbol).toBe("002594.SZ");
  }
});

it("uses complete retained snapshots after a truncated head and preserves unknown or partial output", () => {
  const line = JSON.stringify(collection("采集：新文案")) + "\n";
  const partial = line.slice(0, -8);
  const output = researchLog(line.slice(80) + line + partial);
  expect(output.progress?.state.phase).toMatchObject({
    kind: "collection",
    counts: { completed: 2, total: 3 },
  });
  expect(output.entries).toEqual([
    { kind: "message", text: line.slice(80).trimEnd() },
    { kind: "message", text: partial },
  ]);
  const opaque = '{"type":"future/output","value":1}';
  expect(researchLog(opaque).entries).toEqual([
    { kind: "message", text: opaque },
  ]);
});

it("groups structured source failures and retains newline, Unicode and record path values", () => {
  const records: ResearchJobRecord[] = [
    {
      type: "research/diagnostic",
      dataset: "market.daily",
      source: "来源",
      code: "TEMPORARY",
      message: "失败\n第二行",
    },
    {
      type: "research/diagnostic",
      dataset: "market.weekly",
      source: "来源",
      code: "TEMPORARY",
      message: "失败\n第二行",
    },
    { type: "research/collection-record", path: "/tmp/研究 记录.json" },
    { type: "research/message", text: "等待验收只是日志内容" },
  ];
  const output = researchLog(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  expect(output.entries).toEqual([
    {
      kind: "diagnostic",
      datasets: ["market.daily", "market.weekly"],
      source: "来源",
      message: "TEMPORARY: 失败\n第二行",
    },
    { kind: "record", path: "/tmp/研究 记录.json" },
    { kind: "message", text: "等待验收只是日志内容" },
  ]);
  expect(output.progress).toBeUndefined();
});

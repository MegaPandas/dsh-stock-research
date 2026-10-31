import { expect, it } from "vitest";
import {
  collectionJobRecords,
  researchJobView,
} from "../../src/app/research-execution/view.js";
import type { CollectionProgress } from "../../src/contracts/collection.js";
import type { RunView } from "../../src/contracts/runs.js";
import { CN_SECURITY } from "../fixtures/market.js";

it("retains collection counts, current source, record location and failure diagnostics", () => {
  const collection: CollectionProgress = {
    total: 4,
    completed: 2,
    succeeded: 1,
    failed: 1,
    cacheHits: 1,
    cacheMisses: 2,
    current: { id: "market.weekly", provider: "fixture" },
    recordPath: "collections/example.json",
    failures: [
      {
        id: "market.daily",
        provider: "fixture",
        code: "TEMPORARY",
        detail: "Source unavailable",
      },
    ],
  };
  const view = researchJobView({
    preparationStatus: "preparing",
    view: undefined,
    collection,
    identity: undefined,
    operationIds: [],
  });
  expect(view.text).toBe(
    "采集数据 2/4 · 成功 1，缺失 1 · 缓存命中 1，未命中 2 · fixture · market.weekly",
  );
  expect(view.state.phase).toMatchObject({
    kind: "collection",
    counts: {
      total: 4,
      completed: 2,
      succeeded: 1,
      failed: 1,
      cacheHits: 1,
      cacheMisses: 2,
      current: { id: "market.weekly", provider: "fixture" },
    },
  });
  expect(collectionJobRecords(collection)).toEqual([
    { type: "research/collection-record", path: "collections/example.json" },
    {
      type: "research/diagnostic",
      dataset: "market.daily",
      source: "fixture",
      code: "TEMPORARY",
      message: "Source unavailable",
    },
  ]);
});

it("projects review rejection, identity and operation IDs from recorded fields", () => {
  const ref = { runId: "run", artifactId: "report", revision: 1 };
  const view: RunView = {
    runId: "run",
    lineage: null,
    mode: "quick",
    status: "active",
    scope: {
      security: CN_SECURITY,
      date: "2024-01-03",
      cutoff: "2024-01-03T08:00:00.000Z",
    },
    readyTasks: [],
    currentDigest: null,
    blockReasons: [],
    tasks: [
      {
        taskId: "analysis.market",
        status: "succeeded",
        attempt: 1,
        outputRefs: [ref],
        failure: null,
      },
      {
        taskId: "digest.analysis",
        status: "pending",
        attempt: 0,
        outputRefs: [],
        failure: null,
      },
    ],
    stages: [
      {
        id: "analysis",
        taskIds: ["analysis.market"],
        beforeTasks: ["digest.analysis"],
        readyForReview: true,
        accepted: false,
        refs: [ref],
        latestReview: {
          stageId: "analysis",
          verdict: "rejected",
          feedback: "Please revise the price basis",
          refs: [ref],
          identity: "main",
          recordedAt: "2024-01-03T08:00:00.000Z",
          requestId: "review",
        },
      },
    ],
  };
  const progress = researchJobView({
    preparationStatus: "preparing",
    view,
    collection: undefined,
    identity: undefined,
    operationIds: ["step"],
  });
  expect(progress.state).toEqual({
    status: "blocked",
    phase: {
      kind: "review",
      stageId: "analysis",
      feedback: "Please revise the price basis",
    },
    runId: "run",
    identity: { symbol: "600519.SH", date: "2024-01-03", mode: "quick" },
    operationIds: ["step"],
  });
});

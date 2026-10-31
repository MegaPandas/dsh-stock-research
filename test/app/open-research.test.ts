import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type { QueryPolicy } from "../../src/contracts/query.js";
import type { RunState } from "../../src/contracts/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { RunStore } from "../../src/runs/store.js";
import { CollectionService } from "../../src/services/collection/index.js";
import { createRunService } from "../../src/services/create-run-service.js";
import {
  openResearch,
  type OpenResearchRequest,
} from "../../src/app/open-research.js";
import { COLLECTION_INPUT } from "../../src/app/collection-snapshot.js";
import { CN_SECURITY } from "../fixtures/market.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function setup(finishedAt = "2024-01-03T08:05:00.000Z") {
  const directory = fs.mkdtempSync(join(tmpdir(), "research-opening-"));
  const root = new DataRoot(directory);
  const store = new RunStore<RunState>(root);
  const runs = createRunService(store, () => "2024-01-04T00:00:00.000Z");
  const cache = new SqliteCache({ path: ":memory:", maxEntries: 10 });
  const policy: QueryPolicy = {
    freshness: { market: 60 * 60 * 1000, fundamentals: 0, macro: 0 },
    secCiks: {},
  };
  const collection = new CollectionService(() => [], cache, {
    enabledSources: [],
    freshness: policy.freshness,
    ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
  });
  cleanups.push(async () => {
    try {
      await collection.close();
    } finally {
      cache.close();
      root.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const scope = {
    security: CN_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T08:00:00.000Z",
  };
  const snapshot: CollectionSnapshot = {
    schemaVersion: 1,
    scope: structuredClone(scope),
    failures: [],
    packets: [
      {
        id: "market.daily",
        envelope: {
          dataset: "market",
          data: {
            table: "market.daily",
            title: "Synthetic daily prices",
            currency: "CNY",
            adjustment: "unadjusted",
            interval: "1d",
            columns: {
              close: { label: "Close", unit: "CNY/share", price: true },
            },
            rows: [
              {
                date: scope.date,
                asOf: "2024-01-03T07:00:00.000Z",
                availableAt: "2024-01-03T07:00:00.000Z",
                complete: true,
                values: { close: 100 },
              },
            ],
          },
          source: {
            provider: "fixture",
            url: "https://example.com/daily",
            adapterVersion: "adapter-fixture",
            normalizationVersion: "normalization-fixture",
          },
          asOf: "2024-01-03T07:00:00.000Z",
          availableAt: "2024-01-03T07:00:00.000Z",
          retrievedAt: scope.cutoff,
          cutoff: scope.cutoff,
          ageMs: 60 * 60 * 1000,
          stale: false,
          historicalKnowledge: "verified",
          gaps: [],
        },
      },
    ],
  };
  const collect = vi.spyOn(collection, "collect").mockResolvedValue(snapshot);
  const request: OpenResearchRequest = {
    scope,
    mode: "quick",
    policy,
    sources: [],
    publicSearchLimit: 3,
    modelInput: {
      name: "stock-research:models",
      content: { research: { provider: "fixture", model: "recorded" } },
    },
    requestId: "open",
  };
  const ports = {
    collection,
    now: () => new Date(finishedAt),
    openRun(input: Parameters<typeof runs.open>[1], requestId: string) {
      const { runId } = runs.open("opening-test", input, requestId);
      return runs.view({ runId });
    },
  };
  return { store, runs, snapshot, collect, request, ports };
}

it.each([
  {
    mode: "quick" as const,
    version: "quick/10",
    finishedAt: "2024-01-03T08:05:00.000Z",
    cutoff: "2024-01-03T08:05:00.000Z",
    ageMs: 3_900_000,
  },
  {
    mode: "deep" as const,
    version: "deep/8",
    finishedAt: "2024-01-03T16:10:00.000Z",
    cutoff: "2024-01-03T15:59:59.999Z",
    ageMs: 32_399_999,
  },
])(
  "opens $mode with completion cutoff, fixed inputs and stage gates",
  async ({ mode, version, finishedAt, cutoff, ageMs }) => {
    const f = setup(finishedAt);
    const view = await openResearch(
      f.ports,
      { ...f.request, mode },
      new AbortController().signal,
      () => {},
    );
    expect(view).toMatchObject({
      mode,
      status: "active",
      scope: { ...f.request.scope, cutoff },
    });
    expect(f.runs.readDefinition(view.runId).stages?.[0]?.id).toBe("analysis");
    const catalog = f.runs.inputCatalog(view.runId);
    expect(catalog.versions.mode).toBe(version);
    expect(catalog.versions.adapters["collection/market/fixture"]).toBe(
      "adapter-fixture",
    );
    const input = catalog.inputs.find(({ name }) => name === COLLECTION_INPUT)!;
    const saved = f.runs.readInput<CollectionSnapshot>(view.runId, input.ref);
    expect(saved.scope.cutoff).toBe(cutoff);
    expect(saved.packets[0]!.envelope).toMatchObject({
      cutoff,
      ageMs,
      stale: false,
    });
    const model = catalog.inputs.find(
      ({ name }) => name === f.request.modelInput.name,
    )!;
    expect(f.runs.readInput(view.runId, model.ref)).toEqual(
      f.request.modelInput.content,
    );
  },
);

it("does not open a run when daily data is absent", async () => {
  const f = setup();
  f.snapshot.packets = [];
  await expect(
    openResearch(f.ports, f.request, new AbortController().signal, () => {}),
  ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
  expect(f.store.list()).toEqual([]);
});

it("does not open after cancellation arrives during collection", async () => {
  const f = setup();
  const controller = new AbortController();
  const reason = new DOMException("Collection cancelled", "AbortError");
  f.collect.mockImplementationOnce(async () => {
    controller.abort(reason);
    return f.snapshot;
  });
  await expect(
    openResearch(f.ports, f.request, controller.signal, () => {}),
  ).rejects.toBe(reason);
  expect(f.store.list()).toEqual([]);
});

it("propagates collection failure without creating a run", async () => {
  const f = setup();
  const failure = new Error("Collection source failed");
  f.collect.mockRejectedValueOnce(failure);
  await expect(
    openResearch(f.ports, f.request, new AbortController().signal, () => {}),
  ).rejects.toBe(failure);
  expect(f.store.list()).toEqual([]);
});

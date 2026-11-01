import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type {
  CollectedTableData,
  CollectionDataset,
  CollectionProgress,
  CollectionRecord,
  CollectionTask,
} from "../../src/contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../../src/contracts/data.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { CollectionService } from "../../src/services/collection/index.js";
import { CollectionSnapshotStore } from "../../src/storage/collection-snapshots.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { CN_SECURITY } from "../fixtures/market.js";
import { gate } from "../fixtures/runtime-host.js";

const scope: ResearchScope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T10:00:00.000Z",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function table(
  id: string,
  dataset: CollectionDataset,
  provider: string,
): DataEnvelope<CollectedTableData> {
  const values = {
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1000,
    TOTAL_OPERATE_INCOME: 100,
    PARENT_NETPROFIT: 20,
    china10y: 2,
    us10y: 4,
  };
  return {
    dataset,
    data: {
      table: id,
      title: id,
      currency: "CNY",
      columns: Object.fromEntries(
        Object.keys(values).map((field) => [
          field,
          { label: field, unit: "CNY" },
        ]),
      ),
      rows: [
        {
          date: scope.date,
          periodStart: "2026-01-01",
          asOf: "2026-10-28T07:30:00.000Z",
          availableAt: null,
          complete: true,
          values,
        },
      ],
    },
    source: {
      provider,
      url: `https://${provider}.example/${id}`,
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: "2026-10-28T07:30:00.000Z",
    availableAt: null,
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    ageMs: 9_000_000,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}

function task(id: string, dataset: CollectionDataset, provider = "fixture") {
  return {
    id,
    dataset,
    provider,
    enabledBy: [provider],
    run: vi.fn<CollectionTask["run"]>(async () => table(id, dataset, provider)),
  };
}

function setup(
  tasks: CollectionTask[],
  requireDailyMarket = true,
  enabledSources = [...new Set(tasks.flatMap(({ enabledBy }) => enabledBy))],
) {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-nodes-"));
  const root = new DataRoot(directory);
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 100,
  });
  const snapshots = new CollectionSnapshotStore(root);
  const service = new CollectionService(
    () => tasks,
    cache,
    {
      enabledSources,
      requireDailyMarket,
      freshness: {
        market: 31_536_000_000,
        fundamentals: 31_536_000_000,
        macro: 31_536_000_000,
      },
      ttl: { market: 60_000, fundamentals: 60_000, macro: 60_000, research: 0 },
    },
    snapshots,
  );
  cleanups.push(async () => {
    await service.close();
    cache.close();
    root.close();
    fs.rmSync(directory, { recursive: true });
  });
  const records = (): CollectionRecord[] => {
    const path = join(directory, "collections");
    return fs.existsSync(path)
      ? fs
          .readdirSync(path)
          .map((name) => JSON.parse(fs.readFileSync(join(path, name), "utf8")))
      : [];
  };
  return { service, records, snapshots };
}

function pauseTask(selected: ReturnType<typeof task>) {
  const pause = gate<AbortSignal>();
  cleanups.unshift(async () => pause.released.resolve());
  selected.run.mockImplementation(async (signal) => {
    pause.started.resolve(signal!);
    await pause.released.promise;
    signal?.throwIfAborted();
    return table(selected.id, selected.dataset, selected.provider);
  });
  return pause;
}

describe("independent collection nodes", () => {
  it("publishes exact node tables and durable records without waiting for a slow macro node", async () => {
    const tasks = [
      task("market.daily", "market", "daily"),
      task("market.weekly", "market", "prices"),
      task("market.monthly", "market", "prices"),
      ...["shanghai", "shenzhen", "csi300", "chinext"].map((index) =>
        task(`benchmark.${index}.daily`, "market", "indices"),
      ),
      task("financial.income", "fundamentals", "financial"),
      task("valuation.history", "fundamentals", "financial"),
      task("macro.cpi", "macro", "macro"),
      task("benchmark.gold.daily", "market", "global"),
      task("benchmark.bondYields", "market", "global"),
    ];
    const macro = pauseTask(tasks.find(({ id }) => id === "macro.cpi")!);
    const { service, records } = setup(tasks);
    const pendingMacro = service.collectNode(scope, "macro");
    await macro.started.promise;
    const expected = {
      required: ["market.daily"],
      market: [
        "market.weekly",
        "market.monthly",
        "benchmark.shanghai.daily",
        "benchmark.shenzhen.daily",
        "benchmark.csi300.daily",
        "benchmark.chinext.daily",
      ],
      fundamentals: [
        "financial.income",
        "valuation.history",
        "financial.metrics",
      ],
      macro: ["macro.cpi", "benchmark.gold.daily", "benchmark.bondYields"],
    };
    const completed = await Promise.all(
      (["required", "market", "fundamentals"] as const).map((node) =>
        service.collectNode(scope, node),
      ),
    );
    expect(
      records()
        .map(({ snapshot }) => snapshot.node)
        .sort(),
    ).toEqual(["fundamentals", "market", "required"]);
    for (const snapshot of completed) {
      expect(snapshot.packets.map(({ id }) => id)).toEqual(
        expected[snapshot.node!],
      );
      expect(snapshot.scope).toEqual(scope);
      expect(snapshot.recordPath).toEqual(expect.any(String));
      expect(
        records().find(({ snapshot: saved }) => saved.node === snapshot.node),
      ).toMatchObject({
        status: "complete",
        snapshot: { node: snapshot.node, packets: snapshot.packets },
      });
    }
    macro.released.resolve();
    const snapshot = await pendingMacro;
    expect(snapshot.node).toBe("macro");
    expect(snapshot.packets.map(({ id }) => id)).toEqual(expected.macro);
    expect(records()).toHaveLength(4);
    expect(
      new Set([...completed, snapshot].map(({ recordPath }) => recordPath))
        .size,
    ).toBe(4);
    const captured = records();
    completed[0]!.packets[0]!.envelope.data.rows[0]!.values.close = 999;
    expect(records()).toEqual(captured);
    const batch = await service.collect(scope);
    expect(batch).not.toHaveProperty("node");
    expect(batch.packets[0]!.envelope.data.rows[0]!.values.close).toBe(102);
    expect(
      records().filter(({ snapshot: saved }) => saved.node === undefined),
    ).toHaveLength(1);
  });

  it("shares a node flight, detaches one cancelled observer and clones surviving results independently of other nodes", async () => {
    const daily = task("market.daily", "market");
    const weekly = task("market.weekly", "market", "other");
    const pause = pauseTask(daily);
    const { service, records } = setup([daily, weekly]);
    const controller = new AbortController();
    const progress: CollectionProgress[] = [];
    const first = service.collectNode(
      scope,
      "required",
      controller.signal,
      (value) => progress.push(value),
    );
    const reason = new Error("detach one node observer");
    const cancelled = expect(first).rejects.toBe(reason);
    const active = await pause.started.promise;
    const second = service.collectNode(scope, "required");
    const third = service.collectNode(scope, "required");
    const market = await service.collectNode(scope, "market");
    expect(market.node).toBe("market");
    expect(market.packets.map(({ id }) => id)).toEqual(["market.weekly"]);
    controller.abort(reason);
    await cancelled;
    const progressCount = progress.length;
    expect(active.aborted).toBe(false);
    pause.released.resolve();
    const [left, right] = await Promise.all([second, third]);
    expect(daily.run).toHaveBeenCalledTimes(1);
    expect(weekly.run).toHaveBeenCalledTimes(1);
    expect(left).toEqual(right);
    expect(progress).toHaveLength(progressCount);
    const saved = records();
    left.scope.date = "2026-10-29";
    left.packets[0]!.envelope.data.rows[0]!.values.close = 999;
    expect(right.scope).toEqual(scope);
    expect(right.packets[0]!.envelope.data.rows[0]!.values.close).toBe(102);
    expect(records()).toEqual(saved);
    expect(
      records()
        .map(({ snapshot }) => snapshot.node)
        .sort(),
    ).toEqual(["market", "required"]);
  });

  it.each([false, true])(
    "enforces the explicit required node without applying the global daily gate to other nodes (requireDailyMarket=%s)",
    async (requireDailyMarket) => {
      const daily = task("market.daily", "market", "disabled");
      const weekly = task("market.weekly", "market", "enabled");
      const income = task("financial.income", "fundamentals", "enabled");
      const { service, records } = setup(
        [daily, weekly, income],
        requireDailyMarket,
        ["enabled"],
      );
      const required = await service.collectNode(scope, "required");
      expect(required.node).toBe("required");
      expect(required.packets).toEqual([]);
      expect(required.failures).toContainEqual(
        expect.objectContaining({
          id: "market.daily",
          code: "SOURCE_UNAVAILABLE",
        }),
      );
      const [market, fundamentals] = await Promise.all([
        service.collectNode(scope, "market"),
        service.collectNode(scope, "fundamentals"),
      ]);
      expect(market.packets.map(({ id }) => id)).toEqual(["market.weekly"]);
      expect(fundamentals.packets.map(({ id }) => id)).toEqual([
        "financial.income",
        "financial.metrics",
      ]);
      expect(daily.run).not.toHaveBeenCalled();
      for (const node of ["market", "fundamentals"] as const)
        expect(
          records().find(({ snapshot }) => snapshot.node === node)?.status,
        ).toBe("complete");
      expect(
        records().find(({ snapshot }) => snapshot.node === "required")?.status,
      ).toBe("missing_required");
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "retains a %s node and its original reason without changing an independently saved node",
    async (status) => {
      const daily = task("market.daily", "market", "daily");
      const macro = task("macro.cpi", "macro", "macro");
      const pause = pauseTask(macro);
      const reason = new Error(`${status} macro node`);
      if (status === "failed")
        macro.run.mockImplementation(async (signal) => {
          pause.started.resolve(signal!);
          await pause.released.promise;
          throw reason;
        });
      const { service, records } = setup([daily, macro]);
      const saved = await service.collectNode(scope, "required");
      const originalRecord = records()[0]!;
      const controller = new AbortController();
      const work = service.collectNode(scope, "macro", controller.signal);
      const rejected = expect(work).rejects.toBe(reason);
      await pause.started.promise;
      if (status === "cancelled") controller.abort(reason);
      pause.released.resolve();
      await rejected;
      await service.close();
      expect(records()).toHaveLength(2);
      expect(
        records().find(({ snapshot }) => snapshot.node === "required"),
      ).toEqual(originalRecord);
      expect(
        records().find(({ snapshot }) => snapshot.node === "macro"),
      ).toMatchObject({
        status,
        snapshot: { node: "macro", packets: [] },
        error: { name: "Error", message: reason.message },
      });
      expect(saved.packets[0]!.envelope.data.rows[0]!.values.close).toBe(102);
    },
  );

  it("propagates a record write failure without reporting success or damaging other node records", async () => {
    const daily = task("market.daily", "market", "daily");
    const weekly = task("market.weekly", "market", "weekly");
    const macro = task("macro.cpi", "macro", "macro");
    const { service, records, snapshots } = setup([daily, weekly, macro]);
    await service.collectNode(scope, "required");
    const original = records()[0]!;
    const reason = new ResearchError(
      "STORAGE_FAILED",
      "node snapshot write failed",
    );
    vi.spyOn(snapshots, "save").mockImplementationOnce(() => {
      throw reason;
    });
    const progress: CollectionProgress[] = [];
    await expect(
      service.collectNode(scope, "macro", undefined, (value) =>
        progress.push(value),
      ),
    ).rejects.toBe(reason);
    expect(macro.run).toHaveBeenCalledTimes(1);
    expect(progress.every(({ recordPath }) => recordPath === undefined)).toBe(
      true,
    );
    const market = await service.collectNode(scope, "market");
    expect(market.recordPath).toEqual(expect.any(String));
    expect(
      records()
        .map(({ snapshot }) => snapshot.node)
        .sort(),
    ).toEqual(["market", "required"]);
    expect(
      records().find(({ snapshot }) => snapshot.node === "required"),
    ).toEqual(original);
  });

  it("serializes the same provider across nodes while another provider progresses and retains ordered fallback failures", async () => {
    const daily = task("market.daily", "market", "primary");
    const income = task("financial.income", "fundamentals", "primary");
    const fallback = task("financial.income", "fundamentals", "standby");
    const macro = task("macro.cpi", "macro", "independent");
    const held = pauseTask(daily);
    income.run.mockRejectedValue(
      new ResearchError("SOURCE_UNAVAILABLE", "primary unavailable"),
    );
    const { service, records } = setup([daily, income, fallback, macro]);
    const required = service.collectNode(scope, "required");
    await held.started.promise;
    const fundamentals = service.collectNode(scope, "fundamentals");
    const other = await service.collectNode(scope, "macro");
    await setImmediate();
    expect(other.packets.map(({ id }) => id)).toEqual(["macro.cpi"]);
    expect(income.run).not.toHaveBeenCalled();
    expect(fallback.run).not.toHaveBeenCalled();
    held.released.resolve();
    const [, captured] = await Promise.all([required, fundamentals]);
    expect(income.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    expect(captured.packets[0]!.envelope.source.provider).toBe("standby");
    expect(captured.failures).toContainEqual(
      expect.objectContaining({
        id: "financial.income",
        provider: "primary",
        code: "SOURCE_UNAVAILABLE",
      }),
    );
    expect(
      captured.diagnostics!.attempts.map(({ provider, outcome }) => ({
        provider,
        outcome,
      })),
    ).toEqual([
      { provider: "primary", outcome: "failed" },
      { provider: "standby", outcome: "success" },
    ]);
    expect(records()).toHaveLength(3);
  });
});

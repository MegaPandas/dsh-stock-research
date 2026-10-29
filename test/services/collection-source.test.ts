import { describe, expect, it, vi } from "vitest";
import type {
  CollectedTableData,
  CollectionTask,
} from "../../src/contracts/collection.js";
import type { DataEnvelope } from "../../src/contracts/data.js";
import { CollectionSourceRunner } from "../../src/services/collection-source.js";
import { deferred } from "../fixtures/runtime-host.js";

describe("collection source scheduling", () => {
  it("does not deprioritize a remote endpoint after local queue timeouts", async () => {
    vi.useFakeTimers();
    const release = deferred<void>();
    const started = deferred<void>();
    const time = "2026-10-28T07:00:00.000Z";
    const envelope: DataEnvelope<CollectedTableData> = {
      dataset: "market",
      data: {
        table: "market.daily",
        title: "Daily",
        columns: { close: { label: "Close", unit: "CNY/share" } },
        rows: [
          {
            date: "2026-10-28",
            asOf: time,
            availableAt: null,
            complete: true,
            values: { close: 10 },
          },
        ],
      },
      source: {
        provider: "primary",
        url: "https://primary.example/prices",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: time,
      availableAt: null,
      retrievedAt: time,
      cutoff: time,
      ageMs: 0,
      stale: false,
      historicalKnowledge: "unverified",
      gaps: [],
    };
    const prices = vi.fn(async () => envelope);
    const task: CollectionTask = {
      id: "market.daily",
      dataset: "market",
      provider: "primary",
      enabledBy: ["primary"],
      endpoint: "https://primary.example/prices",
      run: prices,
    };
    const runner = new CollectionSourceRunner();
    const execution = (
      timeoutMs: number,
      alternatives: CollectionTask[] = [],
    ) => ({
      signal: new AbortController().signal,
      timeoutMs,
      attempt: 1,
      alternatives,
      onStart: vi.fn(),
      onAttempt: vi.fn(),
    });
    const busy = runner.run(
      {
        ...task,
        endpoint: "https://primary.example/busy",
        async run() {
          started.resolve();
          await release.promise;
          return envelope;
        },
      },
      execution(1000),
    );
    const queued: ReturnType<CollectionSourceRunner["run"]>[] = [];
    try {
      await started.promise;
      queued.push(
        runner.run(task, execution(10)),
        runner.run(task, execution(10)),
      );
      await vi.advanceTimersByTimeAsync(10);
      const outcomes = await Promise.all(queued);
      expect(outcomes).toEqual([
        expect.objectContaining({
          kind: "failed",
          failure: expect.objectContaining({ code: "TimeoutError" }),
        }),
        expect.objectContaining({
          kind: "failed",
          failure: expect.objectContaining({ code: "TimeoutError" }),
        }),
      ]);
      expect(prices).not.toHaveBeenCalled();
      release.resolve();
      await busy;
      const healthyAlternative: CollectionTask = {
        ...task,
        provider: "standby",
        endpoint: "https://standby.example/prices",
      };
      const result = await runner.run(
        task,
        execution(1000, [healthyAlternative]),
      );
      expect(result).toEqual({ kind: "success", envelope });
      expect(prices).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([busy, ...queued]);
      vi.useRealTimers();
    }
  });
});

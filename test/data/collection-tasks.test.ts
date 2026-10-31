import { describe, expect, it, vi } from "vitest";
import { createCollectionTaskFactory } from "../../src/data/collection-tasks.js";
import { HttpClient } from "../../src/data/http.js";
import type { ReadSource } from "../../src/contracts/query.js";
import { US_SECURITY } from "../fixtures/market.js";

describe("collection source construction", () => {
  it("captures issuer configuration independently of later caller changes", async () => {
    const http = new HttpClient({
      timeoutMs: 1000,
      maxConcurrency: 1,
      minIntervalMs: 0,
    });
    const stop = new Error("request observed");
    const readSource = vi.fn<ReadSource>().mockRejectedValue(stop);
    const config = { secCiks: { [US_SECURITY.id]: "0001045810" } };
    const scope = {
      security: US_SECURITY,
      date: "2026-10-28",
      cutoff: "2026-10-28T22:00:00.000Z",
    };
    try {
      const createTasks = createCollectionTaskFactory(http, readSource, config);
      config.secCiks[US_SECURITY.id] = "0000000001";
      const tasks = createTasks(scope, {
        enabledSources: ["sec"],
        freshness: { market: 0, fundamentals: 0, macro: 0 },
      });
      await expect(
        tasks.find(({ id }) => id === "financial.revenue")!.run(),
      ).rejects.toBe(stop);
      expect(readSource).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          provider: "sec",
          parameters: expect.objectContaining({ cik: "0001045810" }),
        }),
        undefined,
      );
    } finally {
      await http.close();
    }
  });
});

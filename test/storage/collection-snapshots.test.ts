import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "../../src/contracts/collection.js";
import { CollectionSnapshotStore } from "../../src/storage/collection-snapshots.js";
import { DataRoot } from "../../src/storage/data-root.js";

const cleanups: (() => void)[] = [];
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-collection-store-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { directory, root, store: new CollectionSnapshotStore(root) };
}

function record(status: CollectionRecord["status"]): CollectionRecord {
  const time = "2026-10-27T10:00:00.000Z";
  const error = {
    name: "Error",
    message: "provider failed",
    cause: { name: "Error", message: "connection reset", code: "ECONNRESET" },
  };
  return {
    schemaVersion: 1,
    status,
    error,
    snapshot: {
      schemaVersion: 1,
      scope: {
        security: {
          id: "US:NVDA",
          market: "US",
          symbol: "NVDA",
          exchange: "NASDAQ",
          currency: "USD",
          timeZone: "America/New_York",
        },
        date: "2026-10-27",
        cutoff: time,
      },
      packets: [
        {
          id: "market.daily",
          envelope: {
            dataset: "market",
            data: {
              table: "market.daily",
              title: "Daily prices",
              columns: { close: { label: "Close", unit: "USD", price: true } },
              rows: [
                {
                  date: "2026-10-26",
                  asOf: time,
                  availableAt: null,
                  complete: true,
                  values: { close: 140 },
                },
              ],
            },
            source: {
              provider: "fixture",
              url: "https://example.com/prices",
              adapterVersion: "1",
              normalizationVersion: "1",
            },
            asOf: time,
            availableAt: null,
            retrievedAt: time,
            cutoff: time,
            ageMs: 0,
            stale: false,
            historicalKnowledge: "verified",
            gaps: [],
          },
        },
      ],
      failures: [
        {
          id: "financials",
          provider: "fixture",
          code: "PROVIDER_FAILED",
          detail: "provider failed",
          attempt: 2,
          durationMs: 42,
          error,
        },
      ],
      diagnostics: {
        startedAt: time,
        finishedAt: "2026-10-27T10:00:01.000Z",
        cacheHits: 1,
        cacheMisses: 2,
        attempts: [
          {
            id: "financials",
            provider: "fixture",
            endpoint: "https://example.com/financials",
            attempt: 2,
            startedAt: time,
            durationMs: 42,
            outcome: "failed",
            error,
          },
        ],
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("collection snapshot store", () => {
  it.each(["complete", "missing_required", "failed", "cancelled"] as const)(
    "persists %s records with partial packets and full diagnostics before a run exists",
    (status) => {
      const { directory, store } = setup();
      const value = record(status);
      const path = store.save(value);
      expect(isAbsolute(path)).toBe(true);
      expect(dirname(path)).toBe(join(directory, "collections"));
      expect(basename(path)).toMatch(/^[0-9a-f-]{36}\.json$/);
      expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual(value);
      expect(fs.readdirSync(directory).sort()).toEqual([
        ".writer.lock",
        "collections",
      ]);
      expect(fs.readdirSync(dirname(path))).toEqual([basename(path)]);
    },
  );

  it("allocates distinct paths and retains previous records", () => {
    const { store } = setup();
    const first = store.save(record("failed"));
    const previous = fs.readFileSync(first, "utf8");
    const next = store.save(record("complete"));
    expect(next).not.toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(previous);
    expect(JSON.parse(fs.readFileSync(next, "utf8"))).toEqual(
      record("complete"),
    );
  });

  it("rejects writes after the data root closes", () => {
    const { directory, root, store } = setup();
    root.close();
    expect(() => store.save(record("cancelled"))).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("preserves publication failure causes without publishing incomplete JSON", () => {
    const { directory, store } = setup();
    const failure = new Error("rename failed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    expect(() => store.save(record("failed"))).toThrowError(
      expect.objectContaining({
        code: "STORAGE_FAILED",
        cause: expect.objectContaining({
          code: "STORAGE_FAILED",
          cause: failure,
        }),
      }),
    );
    expect(
      fs
        .readdirSync(join(directory, "collections"))
        .filter((name) => name.endsWith(".json")),
    ).toEqual([]);
  });
});

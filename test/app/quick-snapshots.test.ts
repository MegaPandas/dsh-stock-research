import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureQuickSnapshots,
  QUICK_SNAPSHOTS_INPUT,
  queryToolCall,
  readQuickSnapshots,
  type QuickQuerySnapshot,
} from "../../src/app/quick-snapshots.js";
import type { JsonValue } from "../../src/contracts/cache.js";
import type { QueryRequest } from "../../src/contracts/query.js";
import type { RunState } from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { MARKET_FIXTURE, US_SECURITY } from "../fixtures/market.js";

function snapshot(): QuickQuerySnapshot {
  const envelope = structuredClone(MARKET_FIXTURE);
  envelope.availableAt = null;
  return {
    taskId: "market",
    scope: {
      security: structuredClone(US_SECURITY),
      date: "2024-01-08",
      cutoff: "2024-01-08T22:00:00.000Z",
    },
    request: {
      dataset: "market",
      provider: "yahoo",
      parameters: { startDate: "2024-01-02", maxAgeMs: 3_600_000 },
    },
    envelope,
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function stored(content?: JsonValue, duplicateInput = false) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-quick-snapshots-"));
  let root = new DataRoot(directory);
  const openService = () =>
    new RunService(
      new RunStore<RunState>(root),
      () => "2024-01-09T00:00:00.000Z",
    );
  const runs = openService();
  cleanups.push(() => {
    root.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { runId } = runs.open(
    "owner",
    {
      definition: {
        scope: snapshot().scope,
        mode: "quick",
        tasks: [
          {
            id: "market",
            executor: { kind: "role", role: "analyst", specialty: "market" },
            dependsOn: [],
            inputTasks: [],
            outputKinds: ["analysis"],
            dataRequirements: [],
            instructionVersion: 1,
          },
        ],
      },
      versions: {
        plugin: "1",
        mode: "1",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs:
        content === undefined
          ? []
          : Array.from({ length: duplicateInput ? 2 : 1 }, () => ({
              name: QUICK_SNAPSHOTS_INPUT,
              content,
            })),
    },
    "open",
  );
  return {
    runs,
    runId,
    reopen: () => {
      root.close();
      root = new DataRoot(directory);
      return openService();
    },
  };
}

describe("fixed quick query inputs", () => {
  it("captures an independent JSON value before the caller changes its input", () => {
    const input = [snapshot()];
    const before = structuredClone(input);
    const content = captureQuickSnapshots(input);
    input[0]!.scope.security.symbol = "AAPL";
    input[0]!.envelope.retrievedAt = "2024-01-09T00:00:00.000Z";
    input.push(snapshot());
    expect(content).toEqual({ schemaVersion: 1, snapshots: before });
  });

  it("reads the fixed RunInput after reopening storage without sharing mutable results", () => {
    const input = [snapshot()];
    const before = structuredClone(input);
    const c = stored(captureQuickSnapshots(input));
    input[0]!.scope.cutoff = "2024-01-09T00:00:00.000Z";
    const reopened = c.reopen();
    const first = readQuickSnapshots(reopened, c.runId);
    expect(first).toEqual(before);
    first[0]!.envelope.retrievedAt = "2024-01-09T00:00:00.000Z";
    expect(readQuickSnapshots(reopened, c.runId)).toEqual(before);
  });

  it("returns no snapshots when the optional RunInput was not saved", () => {
    const c = stored();
    expect(readQuickSnapshots(c.runs, c.runId)).toEqual([]);
  });

  it("reports an unsupported saved schema version explicitly", () => {
    const c = stored({ schemaVersion: 2, snapshots: [] });
    expect(() => readQuickSnapshots(c.runs, c.runId)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("rejects duplicate saved inputs with the query snapshot name", () => {
    const content = captureQuickSnapshots([snapshot()]);
    const c = stored(content, true);
    expect(() => readQuickSnapshots(c.runs, c.runId)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("reports damaged saved snapshot content instead of silently dropping it", () => {
    const c = stored({ schemaVersion: 1, snapshots: [{ taskId: "market" }] });
    expect(() => readQuickSnapshots(c.runs, c.runId)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("builds each data tool recipe with only its actual model-facing fields", () => {
    const cases: {
      request: QueryRequest;
      expected: { name: string; arguments: Record<string, unknown> };
    }[] = [
      {
        request: {
          dataset: "market",
          provider: "yahoo",
          parameters: {
            startDate: "2024-01-02",
            maxAgeMs: 100,
            indicators: [{ kind: "sma", period: 2 }],
          },
        },
        expected: {
          name: "stock_get_market",
          arguments: {
            provider: "yahoo",
            startDate: "2024-01-02",
            indicators: [{ kind: "sma", period: 2 }],
          },
        },
      },
      {
        request: {
          dataset: "fundamentals",
          provider: "sec",
          parameters: {
            cik: "0001045810",
            field: "revenue",
            periodEndFrom: "2023-01-01",
            maxAgeMs: 100,
          },
        },
        expected: {
          name: "stock_get_fundamentals",
          arguments: {
            provider: "sec",
            field: "revenue",
            periodEndFrom: "2023-01-01",
          },
        },
      },
      {
        request: {
          dataset: "fundamentals",
          provider: "eastmoney",
          parameters: {
            fields: ["netIncomeToParent"],
            periodEndFrom: "2023-01-01",
            periodEndTo: "2023-12-31",
            maxAgeMs: 100,
          },
        },
        expected: {
          name: "stock_get_fundamentals",
          arguments: {
            provider: "eastmoney",
            fields: ["netIncomeToParent"],
            periodEndFrom: "2023-01-01",
            periodEndTo: "2023-12-31",
          },
        },
      },
      {
        request: {
          dataset: "fundamentals",
          provider: "sina",
          parameters: { fields: ["revenue"], maxAgeMs: 100 },
        },
        expected: {
          name: "stock_get_fundamentals",
          arguments: { provider: "sina", fields: ["revenue"] },
        },
      },
      {
        request: {
          dataset: "macro",
          provider: "fred",
          parameters: {
            seriesId: "DGS10",
            startDate: "2024-01-02",
            endDate: "2024-01-08",
            maxAgeMs: 100,
          },
        },
        expected: {
          name: "stock_get_macro",
          arguments: {
            provider: "fred",
            seriesId: "DGS10",
            startDate: "2024-01-02",
            endDate: "2024-01-08",
          },
        },
      },
      {
        request: {
          dataset: "returns",
          provider: "tencent",
          parameters: {
            historyStartDate: "2023-12-01",
            startDate: "2024-01-02",
            endDate: "2024-01-08",
            maxAgeMs: 100,
            comparable: false,
          },
        },
        expected: {
          name: "stock_get_returns",
          arguments: {
            provider: "tencent",
            historyStartDate: "2023-12-01",
            startDate: "2024-01-02",
            endDate: "2024-01-08",
          },
        },
      },
      {
        request: {
          dataset: "research",
          provider: "dsh-web",
          parameters: { query: "Company results", maxResults: 3 },
        },
        expected: {
          name: "stock_research",
          arguments: {
            provider: "dsh-web",
            query: "Company results",
            maxResults: 3,
          },
        },
      },
    ];
    for (const { request, expected } of cases) {
      const before = structuredClone(request);
      expect(queryToolCall(request)).toEqual(expected);
      expect(request).toEqual(before);
    }
  });
});

import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQuickSnapshots } from "../../src/app/quick-snapshots.js";
import {
  QUICK_SNAPSHOTS_INPUT,
  type QuickQuerySnapshot,
} from "../../src/app/plan/protocol.js";
import { captureQuickSnapshots } from "../../src/app/plan/snapshots.js";
import type { JsonValue } from "../../src/contracts/json.js";
import type { RunState } from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { createRunService } from "../../src/services/run/index.js";
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
    createRunService(
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
});

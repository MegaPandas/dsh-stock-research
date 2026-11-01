import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { ArtifactPayloads } from "../../src/contracts/artifact-payloads.js";
import type {
  CollectedTableData,
  CollectionDataset,
  CollectionRecord,
  CollectionTask,
} from "../../src/contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../../src/contracts/data.js";
import { ExecutionStopped, ResearchError } from "../../src/contracts/errors.js";
import type { OpenRunInput, RunState } from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { CollectionService } from "../../src/services/collection/index.js";
import { CollectionRunService } from "../../src/services/collection-run/index.js";
import { createRunService } from "../../src/services/run/index.js";
import { CollectionSnapshotStore } from "../../src/storage/collection-snapshots.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { CN_SECURITY } from "../fixtures/market.js";
import { gate } from "../fixtures/runtime-host.js";

const scope: ResearchScope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T10:00:00.000Z",
};
const capturedAt = "2026-10-28T10:00:30.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function envelope(
  id: string,
  dataset: CollectionDataset,
): DataEnvelope<CollectedTableData> {
  return {
    dataset,
    data: {
      table: id,
      title: id,
      currency: "CNY",
      columns: { close: { label: "Close", unit: "CNY" } },
      rows: [
        {
          date: scope.date,
          asOf: scope.cutoff,
          availableAt: null,
          complete: true,
          values: {
            open: 100,
            high: 105,
            low: 95,
            close: 102,
            volume: 1000,
            value: 2,
          },
        },
      ],
    },
    source: {
      provider: id,
      url: `https://fixture.example/${id}`,
      adapterVersion: "1",
      normalizationVersion: "1",
    },
    asOf: scope.cutoff,
    availableAt: null,
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    ageMs: 0,
    stale: false,
    historicalKnowledge: "unverified",
    gaps: [],
  };
}
function source(id: string, dataset: CollectionDataset) {
  return {
    id,
    dataset,
    provider: id,
    enabledBy: [id],
    run: vi.fn<CollectionTask["run"]>(async () => envelope(id, dataset)),
  };
}
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-run-"));
  const root = new DataRoot(directory);
  const store = new RunStore<RunState>(root);
  const runs = createRunService(store, () => scope.cutoff);
  const cache = new SqliteCache({
    path: join(directory, "cache.sqlite"),
    maxEntries: 100,
  });
  const snapshots = new CollectionSnapshotStore(root);
  const tasks = [
    source("market.daily", "market"),
    source("market.weekly", "market"),
    source("macro.cpi", "macro"),
  ];
  const collection = new CollectionService(
    () => tasks,
    cache,
    {
      enabledSources: tasks.map(({ provider }) => provider),
      freshness: {
        market: 31_536_000_000,
        fundamentals: 31_536_000_000,
        macro: 31_536_000_000,
      },
      ttl: { market: 0, fundamentals: 0, macro: 0, research: 0 },
    },
    snapshots,
  );
  const now = vi.fn<() => string>(() => capturedAt);
  const runner = new CollectionRunService(runs, collection, now);
  const input: OpenRunInput = {
    definition: {
      scope,
      mode: "quick",
      tasks: (["required", "market", "macro"] as const).map((node) => ({
        id: `collection.${node}`,
        executor: { kind: "service", service: "collection", node },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["collection"],
        dataRequirements: [],
        instructionVersion: 1,
      })),
    },
    versions: {
      plugin: "fixture",
      mode: "fixture",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
  const { runId } = runs.open("owner", input, "open");
  const operation = { runId, identity: "owner" };
  cleanups.push(async () => {
    await runner.close();
    await collection.close();
    cache.close();
    root.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function pause(index = 0) {
    const held = gate<AbortSignal>();
    cleanups.push(async () => held.released.resolve());
    tasks[index]!.run.mockImplementationOnce(async (signal) => {
      const abort = () => held.aborted.resolve();
      signal!.addEventListener("abort", abort, { once: true });
      held.started.resolve(signal!);
      try {
        await held.released.promise;
        signal!.throwIfAborted();
        return envelope(tasks[index]!.id, tasks[index]!.dataset);
      } finally {
        signal!.removeEventListener("abort", abort);
      }
    });
    return held;
  }
  const attempt = (taskId: string, attempt = 1) => ({
    ...operation,
    taskId,
    attempt,
  });
  const payload = (ref: Parameters<typeof runs.readArtifact>[0]) =>
    runs.readArtifact(ref).content.payload as ArtifactPayloads["collection"];
  const records = (): CollectionRecord[] =>
    fs
      .readdirSync(join(directory, "collections"))
      .map((name) =>
        JSON.parse(
          fs.readFileSync(join(directory, "collections", name), "utf8"),
        ),
      );
  return {
    directory,
    root,
    runs,
    store,
    runner,
    now,
    snapshots,
    tasks,
    input,
    operation,
    pause,
    attempt,
    payload,
    records,
  };
}
function leaves(cause: unknown): unknown[] {
  return cause instanceof AggregateError
    ? cause.errors.flatMap(leaves)
    : [cause];
}

describe("collection tasks in canonical runs", () => {
  it.each(["node", "output"] as const)(
    "rejects an unsupported collection %s at the run definition boundary",
    (field) => {
      const h = setup();
      const input = structuredClone(h.input);
      if (field === "node")
        Object.assign(input.definition.tasks[0]!.executor, { node: "unknown" });
      else input.definition.tasks[0]!.outputKinds = ["analysis"];
      expect(() =>
        h.runs.open("owner", input, "invalid-collection"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(h.store.list()).toHaveLength(1);
      expect(h.tasks.every(({ run }) => run.mock.calls.length === 0)).toBe(
        true,
      );
    },
  );

  it("atomically fixes one shared capture, replays its request and reads it after restart without report projections", async () => {
    const h = setup();
    const held = h.pause();
    const published: { status: string; refs: number }[] = [];
    const release = h.runs.subscribe(h.operation.runId, () =>
      queueMicrotask(() => {
        const task = h.runs
          .view(h.operation)
          .tasks.find(({ taskId }) => taskId === "collection.required")!;
        published.push({ status: task.status, refs: task.outputRefs.length });
      }),
    );
    cleanups.push(async () => release());
    const first = h.runner.collect(h.operation, "collection.required", "same");
    await held.started.promise;
    const duplicate = h.runner.collect(
      h.operation,
      "collection.required",
      "same",
    );
    expect(h.runs.readAttempt(h.attempt("collection.required"))).toMatchObject({
      status: "running",
      outputRefs: [],
    });
    expect(h.now).not.toHaveBeenCalled();
    held.released.resolve();
    const [left, right] = await Promise.all([first, duplicate]);
    expect(left).toEqual(right);
    expect(
      await h.runner.collect(h.operation, "collection.required", "same"),
    ).toEqual(left);
    expect(h.tasks[0]!.run).toHaveBeenCalledTimes(1);
    expect(left.refs).toHaveLength(1);
    expect(published.some(({ status }) => status === "succeeded")).toBe(true);
    expect(
      published.every(
        ({ status, refs }) => status !== "succeeded" || refs === 1,
      ),
    ).toBe(true);
    expect(h.runs.readAttempt(h.attempt("collection.required"))).toMatchObject({
      status: "succeeded",
      outputRefs: left.refs,
    });
    const payload = h.payload(left.refs[0]!);
    expect(payload).toMatchObject({
      capturedFrom: null,
      capturedAt,
      snapshot: { node: "required", scope, packets: [{ id: "market.daily" }] },
    });
    expect(h.records()).toMatchObject([
      { status: "complete", snapshot: { scope } },
    ]);
    expect(h.records()[0]!.snapshot).not.toHaveProperty("capturedAt");
    expect(h.now).toHaveBeenCalledTimes(1);
    expect(
      fs
        .readdirSync(join(h.directory, "runs"), { recursive: true })
        .some((path) => String(path).endsWith(".md")),
    ).toBe(false);
    const restarted = createRunService(
      new RunStore<RunState>(h.root),
      () => scope.cutoff,
    );
    expect(restarted.readArtifact(left.refs[0]!)).toEqual(
      h.runs.readArtifact(left.refs[0]!),
    );
    expect(
      restarted.readAttempt(h.attempt("collection.required")).outputRefs,
    ).toEqual(left.refs);
    h.runs.claimServiceForCall(
      h.operation,
      "collection.macro",
      "collection",
      JSON.stringify(["collection", "collection.macro", "lost"]),
    );
    await expect(
      h.runner.collect(h.operation, "collection.macro", "lost"),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    expect(h.tasks[2]!.run).not.toHaveBeenCalled();
  });

  it("publishes cancellation before draining only that node while an independent capture completes", async () => {
    const h = setup();
    const held = h.pause();
    const work = h.runner
      .collect(h.operation, "collection.required", "first")
      .catch((cause: unknown) => cause);
    await held.started.promise;
    const cancelled = h.runs.cancelTask(
      h.operation,
      {
        taskId: "collection.required",
        expectedAttempt: 1,
        reason: "Stop data",
      },
      "cancel",
    );
    let drained = false;
    const stop = h.runner
      .stop(h.operation.runId, cancelled.stopAttempts)
      .then(() => {
        drained = true;
      });
    await held.aborted.promise;
    expect(h.runs.readAttempt(h.attempt("collection.required")).status).toBe(
      "cancelled",
    );
    expect(drained).toBe(false);
    expect(
      h.runner.isExecuting(h.operation.runId, {
        taskId: "collection.required",
        attempt: 1,
      }),
    ).toBe(true);
    const other = await h.runner.collect(
      h.operation,
      "collection.macro",
      "independent",
    );
    expect(h.runs.readAttempt(h.attempt("collection.macro"))).toMatchObject({
      status: "succeeded",
      outputRefs: other.refs,
    });
    held.released.resolve();
    await stop;
    expect(await work).toBeInstanceOf(ExecutionStopped);
    expect(
      h.runner.isExecuting(h.operation.runId, {
        taskId: "collection.required",
        attempt: 1,
      }),
    ).toBe(false);
    expect(
      h
        .records()
        .map(({ status }) => status)
        .sort(),
    ).toEqual(["cancelled", "complete"]);
  });

  it("waits for an invalidated owner, isolates an old stop and redoes a fixed snapshot without fetching again", async () => {
    const h = setup();
    const held = h.pause();
    const old = h.runner
      .collect(h.operation, "collection.required", "old")
      .catch((cause: unknown) => cause);
    await held.started.promise;
    const redo = h.runs.redo(h.operation, "collection.required", "redo");
    const replacementGate = h.pause();
    const replacement = h.runner.collect(
      h.operation,
      "collection.required",
      "new",
    );
    await held.aborted.promise;
    expect(h.runs.readAttempt(h.attempt("collection.required")).status).toBe(
      "invalidated",
    );
    expect(h.tasks[0]!.run).toHaveBeenCalledTimes(1);
    held.released.resolve();
    expect(await old).toBeInstanceOf(ExecutionStopped);
    const replacementSignal = await replacementGate.started.promise;
    await h.runner.stop(h.operation.runId, redo.stopAttempts);
    expect(replacementSignal.aborted).toBe(false);
    expect(h.runs.readAttempt(h.attempt("collection.required", 2)).status).toBe(
      "running",
    );
    replacementGate.released.resolve();
    const fixed = await replacement;
    expect(fixed.attempt).toBe(2);
    expect(
      h.runs.readAttempt(h.attempt("collection.required", 2)),
    ).toMatchObject({ status: "succeeded", outputRefs: fixed.refs });
    const originalPayload = h.payload(fixed.refs[0]!);
    const snapshot = originalPayload.snapshot;
    h.now.mockReturnValue("2026-10-28T11:00:00.000Z");
    h.runs.redo(h.operation, "collection.required", "redo-fixed");
    const copied = await h.runner.collect(
      h.operation,
      "collection.required",
      "copy",
    );
    expect(copied.attempt).toBe(3);
    expect(h.payload(copied.refs[0]!)).toEqual({
      snapshot,
      capturedAt: originalPayload.capturedAt,
      capturedFrom: fixed.refs[0],
    });
    expect(h.now).toHaveBeenCalledTimes(1);
    expect(h.tasks[0]!.run).toHaveBeenCalledTimes(2);
  });

  it("replays only captured nodes and fails a missing offline node without fetching", async () => {
    const h = setup();
    const fixed = await h.runner.collect(
      h.operation,
      "collection.required",
      "capture",
    );
    const sourceView = h.runs.view(h.operation);
    h.now.mockReturnValue("2026-10-29T10:00:00.000Z");
    const { runId } = h.runs.open(
      "owner",
      { replay: { runId: h.operation.runId }, versions: h.input.versions },
      "replay",
    );
    const replay = { runId, identity: "owner" };
    const copied = await h.runner.collect(
      replay,
      "collection.required",
      "offline",
    );
    expect(h.payload(copied.refs[0]!)).toEqual({
      snapshot: h.payload(fixed.refs[0]!).snapshot,
      capturedAt: h.payload(fixed.refs[0]!).capturedAt,
      capturedFrom: fixed.refs[0],
    });
    expect(h.now).toHaveBeenCalledTimes(1);
    await expect(
      h.runner.collect(replay, "collection.macro", "missing"),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    expect(
      h.runs.readAttempt({ ...replay, taskId: "collection.macro", attempt: 1 }),
    ).toMatchObject({ status: "failed", outputRefs: [] });
    expect(h.tasks[0]!.run).toHaveBeenCalledTimes(1);
    expect(h.tasks[2]!.run).not.toHaveBeenCalled();
    expect(h.runs.view(h.operation)).toEqual(sourceView);
  });

  it.each(["source", "snapshot", "artifact"] as const)(
    "propagates a %s failure without publishing successful outputs",
    async (boundary) => {
      const h = setup();
      const failure = new Error(`${boundary} write or execution failure`);
      if (boundary === "source") h.tasks[0]!.run.mockRejectedValueOnce(failure);
      else if (boundary === "snapshot")
        vi.spyOn(h.snapshots, "save").mockImplementationOnce(() => {
          throw failure;
        });
      else {
        const open = fs.openSync;
        vi.spyOn(fs, "openSync").mockImplementation((path, ...args) => {
          if (String(path).includes("/artifacts/")) throw failure;
          return open(path, ...args);
        });
      }
      const cause = await h.runner
        .collect(h.operation, "collection.required", "fail")
        .catch((error: unknown) => error);
      expect(boundary === "artifact" ? (cause as Error).cause : cause).toBe(
        failure,
      );
      expect(
        h.runs.readAttempt(h.attempt("collection.required")),
      ).toMatchObject({ status: "failed", outputRefs: [] });
      expect(
        h.runs
          .view(h.operation)
          .tasks.find(({ taskId }) => taskId === "collection.required")!
          .outputRefs,
      ).toEqual([]);
    },
  );

  it("retains cancellation and record persistence errors while stop waits for resource release", async () => {
    const h = setup();
    const held = h.pause();
    const work = h.runner
      .collect(h.operation, "collection.required", "cancel-save")
      .catch((cause: unknown) => cause);
    const active = await held.started.promise;
    const cancelled = h.runs.cancelTask(
      h.operation,
      {
        taskId: "collection.required",
        expectedAttempt: 1,
        reason: "Cancel capture",
      },
      "cancel",
    );
    const failure = new ResearchError(
      "STORAGE_FAILED",
      "Cancelled capture could not be saved",
    );
    vi.spyOn(h.snapshots, "save").mockImplementationOnce(() => {
      throw failure;
    });
    const stopping = h.runner
      .stop(h.operation.runId, cancelled.stopAttempts)
      .catch((cause: unknown) => cause);
    await held.aborted.promise;
    held.released.resolve();
    const [cause, stopError] = await Promise.all([work, stopping]);
    expect(leaves(cause)).toContain(active.reason);
    expect(leaves(cause)).toContain(failure);
    expect(stopError).toBe(cause);
    expect(h.runs.readAttempt(h.attempt("collection.required"))).toMatchObject({
      status: "cancelled",
      outputRefs: [],
    });
    expect(
      h.runner.isExecuting(h.operation.runId, {
        taskId: "collection.required",
        attempt: 1,
      }),
    ).toBe(false);
  });
});

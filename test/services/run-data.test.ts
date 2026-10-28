import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenRunInput,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import type {
  EvidenceInput,
  EvidenceQuery,
  MemoryInputQuery,
  MemoryInputSnapshot,
} from "../../src/contracts/task-data.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const paths: string[] = [];
const roots: DataRoot[] = [];
const RECORDED = "2024-07-02T12:00:00.000Z";
const scope = {
  security: US_SECURITY,
  date: "2024-06-30",
  cutoff: "2024-06-30T20:00:00.000Z",
};
const evidenceQuery: EvidenceQuery = {
  dataset: "market",
  provider: "sample",
  parameters: { startDate: "2024-06-28", maxAgeMs: 86400000 },
};
const memoryQuery: MemoryInputQuery = {
  scope: { securityId: "US:NVDA" },
  parameters: { topic: "valuation", limit: 3 },
};
const memoryEntries = [
  {
    ref: { entryId: "11111111-1111-4111-8111-111111111111", revision: 2 },
    content: { text: "Original memory", tags: ["valuation"] },
  },
];
function data(value = 123): EvidenceInput<{ price: number; volume: number }> {
  return {
    envelope: {
      dataset: "market",
      data: { price: value, volume: 0 },
      source: {
        provider: "sample",
        url: "https://example.com/data",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf: "2024-06-28T20:00:00.000Z",
      availableAt: null,
      retrievedAt: "2024-07-01T09:00:00.000Z",
      cutoff: scope.cutoff,
      ageMs: 172800000,
      stale: true,
      historicalKnowledge: "unverified",
      gaps: [
        {
          code: "unverified_time",
          field: "/data",
          detail: "Current source view",
        },
      ],
    },
    candidates: [
      {
        candidateId: "price",
        label: "Price",
        value,
        unit: "USD/share",
        asOf: "2024-06-28T20:00:00.000Z",
        selector: "/data/price",
      },
      {
        candidateId: "volume",
        label: "Volume",
        value: 0,
        unit: "shares",
        asOf: "2024-06-28T20:00:00.000Z",
        selector: "/data/volume",
      },
    ],
  };
}
function opened(path: string) {
  const root = new DataRoot(path);
  roots.push(root);
  const store = new RunStore<RunState>(root);
  return { root, store, service: new RunService(store, () => RECORDED) };
}
function claim(
  service: RunService,
  runId: string,
  taskId: string,
  callId: string,
): TaskOperation {
  const result = service.claim({ runId, identity: "owner" }, taskId, callId);
  return {
    runId,
    identity: "worker",
    taskId,
    attempt: result.attempt,
    sessionId: "session",
  };
}
function setup() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-run-data-"));
  paths.push(path);
  const context = opened(path);
  const input: OpenRunInput = {
    definition: {
      scope,
      mode: "quick",
      tasks: ["a", "b"].map((id) => ({
        id,
        executor: { kind: "role", role: "analyst", specialty: "research" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      })),
    },
    versions: {
      plugin: "1",
      mode: "1",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
  const { runId } = context.service.open("owner", input, "open");
  return {
    ...context,
    path,
    runId,
    op: claim(context.service, runId, "a", "claim-a"),
  };
}
function files(path: string, runId: string) {
  return fs.readdirSync(
    join(path, "runs", "2024-06-30", `US_NVDA-quick-${runId}`),
    { recursive: true },
  );
}
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) root.close();
  for (const path of paths.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("task data registration", () => {
  it("preflights both actions with the run scope without writing state or files", () => {
    const { service, store, op, path, runId } = setup();
    const saved = store.read(runId);
    const before = files(path, runId);
    expect(service.evidenceForCall(op, evidenceQuery, "data")).toEqual({
      scope,
      lineage: null,
      sourceRef: null,
    });
    expect(service.memoryInputForCall(op, memoryQuery, "memory")).toEqual({
      scope,
      lineage: null,
      inputRef: null,
    });
    expect(store.read(runId)).toEqual(saved);
    expect(files(path, runId)).toEqual(before);
  });

  it("publishes evidence identity, source-linked candidates, registry and receipt together", () => {
    const { service, store, op, runId } = setup();
    const supplied = data();
    const before = store.read(runId);
    const ref = service.recordEvidence(op, evidenceQuery, supplied, "data");
    expect(ref).toEqual({
      runId,
      evidenceId: expect.any(String),
      selector: "/data",
    });
    const record = service.readEvidence(ref);
    expect(record).toEqual({
      runId,
      evidenceId: ref.evidenceId,
      taskId: "a",
      attempt: 1,
      request: { ...evidenceQuery, securityId: "US:NVDA" },
      recordedAt: RECORDED,
      envelope: {
        ...supplied.envelope,
        candidateClaims: [
          {
            candidateId: "price",
            label: "Price",
            value: 123,
            unit: "USD/share",
            asOf: "2024-06-28T20:00:00.000Z",
            source: {
              runId,
              evidenceId: ref.evidenceId,
              selector: "/data/price",
            },
          },
          {
            candidateId: "volume",
            label: "Volume",
            value: 0,
            unit: "shares",
            asOf: "2024-06-28T20:00:00.000Z",
            source: {
              runId,
              evidenceId: ref.evidenceId,
              selector: "/data/volume",
            },
          },
        ],
      },
    });
    const saved = store.read(runId);
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.evidence).toEqual([
      { evidenceId: ref.evidenceId, taskId: "a", attempt: 1, callId: "data" },
    ]);
    expect(saved.contents).toContainEqual({
      kind: "evidence",
      id: ref.evidenceId,
    });
    expect(saved.receipts.at(-1)).toMatchObject({
      action: "record_evidence",
      requestId: "data",
      result: ref,
    });
    expect(saved.tasks[0]!.status).toBe("running");
  });

  it("replays equivalent queries despite changed payloads and rejects query reuse without replacing snapshots", () => {
    const { service, store, op, path, runId } = setup();
    const ref = service.recordEvidence(op, evidenceQuery, data(), "data");
    const saved = store.read(runId);
    const before = files(path, runId);
    const equivalent: EvidenceQuery = {
      parameters: { maxAgeMs: 86400000, startDate: "2024-06-28" },
      provider: "sample",
      dataset: "market",
    };
    expect(service.recordEvidence(op, equivalent, data(999), "data")).toEqual(
      ref,
    );
    expect(service.evidenceForCall(op, equivalent, "data")).toEqual({
      scope,
      lineage: null,
      sourceRef: ref,
    });
    expect(
      service.readEvidence<{ price: number }>(ref).envelope.data.price,
    ).toBe(123);
    expect(service.readEvidence(ref).envelope.candidateClaims![0]!.value).toBe(
      123,
    );
    expect(() =>
      service.evidenceForCall(
        op,
        { ...evidenceQuery, provider: "another" },
        "data",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(() =>
      service.recordEvidence(
        op,
        { ...evidenceQuery, parameters: { startDate: "2024-01-01" } },
        data(),
        "data",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(store.read(runId)).toEqual(saved);
    expect(files(path, runId)).toEqual(before);
  });

  it("isolates one call id by task, attempt and registration action", () => {
    const { service, store, op, runId } = setup();
    const first = service.recordEvidence(op, evidenceQuery, data(), "same");
    const memory = service.recordMemoryInput(op, memoryQuery, [], "same");
    const b = claim(service, runId, "b", "claim-b");
    const other = service.recordEvidence(b, evidenceQuery, data(200), "same");
    service.failAttempt(
      op,
      { code: "FAILED", message: "Retry needed" },
      "failed",
    );
    const next = claim(service, runId, "a", "claim-a2");
    const retried = service.recordEvidence(
      next,
      evidenceQuery,
      data(300),
      "same",
    );
    expect(
      new Set([first.evidenceId, other.evidenceId, retried.evidenceId]).size,
    ).toBe(3);
    expect(
      service.memoryInputForCall(op, memoryQuery, "same").inputRef,
    ).toEqual(memory.inputRef);
    expect(
      store
        .read(runId)
        .evidence.map(({ taskId, attempt }) => [taskId, attempt]),
    ).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
    ]);
  });

  it("stores a complete memory input snapshot independently of live memory state", () => {
    const { service, store, op, runId } = setup();
    const registered = service.recordMemoryInput(
      op,
      memoryQuery,
      memoryEntries,
      "memory",
    );
    expect(registered).toEqual({
      runId,
      inputRef: expect.objectContaining({
        kind: "input",
        id: expect.any(String),
      }),
    });
    expect(
      service.readInput<MemoryInputSnapshot<unknown>>(
        runId,
        registered.inputRef,
      ),
    ).toEqual({
      runId,
      taskId: "a",
      attempt: 1,
      scope,
      request: memoryQuery,
      entries: memoryEntries,
      recordedAt: RECORDED,
    });
    expect(store.read(runId).inputs.at(-1)).toEqual({
      name: "memory",
      ref: registered.inputRef,
      memory: { taskId: "a", attempt: 1, callId: "memory" },
    });
    expect(store.read(runId).receipts.at(-1)).toMatchObject({
      action: "record_memory_input",
      requestId: "memory",
      result: registered,
    });
    expect(store.read(runId).tasks[0]!.status).toBe("running");
  });

  it("persists successful empty memory results and does not replace them on replay", () => {
    const { service, store, op, path, runId } = setup();
    const result = service.recordMemoryInput(op, memoryQuery, [], "memory");
    const saved = store.read(runId);
    const before = files(path, runId);
    const equivalent: MemoryInputQuery = {
      parameters: { limit: 3, topic: "valuation" },
      scope: { securityId: "US:NVDA" },
    };
    expect(
      service.recordMemoryInput(op, equivalent, memoryEntries, "memory"),
    ).toEqual(result);
    expect(
      service.readInput<MemoryInputSnapshot<unknown>>(runId, result.inputRef)
        .entries,
    ).toEqual([]);
    expect(() =>
      service.memoryInputForCall(
        op,
        { ...memoryQuery, parameters: { topic: "different" } },
        "memory",
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    expect(store.read(runId)).toEqual(saved);
    expect(files(path, runId)).toEqual(before);
  });

  it("restores evidence and memory receipts and fixed snapshots after reopening", () => {
    const { service, store, op, root, path, runId } = setup();
    const evidence = service.recordEvidence(op, evidenceQuery, data(), "data");
    const memory = service.recordMemoryInput(
      op,
      memoryQuery,
      memoryEntries,
      "memory",
    );
    const saved = store.read(runId);
    root.close();
    const restarted = opened(path);
    expect(
      restarted.service.evidenceForCall(op, evidenceQuery, "data"),
    ).toEqual({ scope, lineage: null, sourceRef: evidence });
    expect(
      restarted.service.memoryInputForCall(op, memoryQuery, "memory"),
    ).toEqual({ scope, lineage: null, inputRef: memory.inputRef });
    expect(restarted.service.readEvidence(evidence).recordedAt).toBe(RECORDED);
    expect(
      restarted.service.readInput<MemoryInputSnapshot<unknown>>(
        runId,
        memory.inputRef,
      ).entries,
    ).toEqual(memoryEntries);
    expect(restarted.store.read(runId)).toEqual(saved);
  });

  it.each(["redo", "cancel"] as const)(
    "replays old registered calls after %s but rejects new calls and late registration",
    (transition) => {
      const { service, store, op, runId } = setup();
      const control = { runId, identity: "owner" };
      const evidence = service.recordEvidence(
        op,
        evidenceQuery,
        data(),
        "data",
      );
      const memory = service.recordMemoryInput(op, memoryQuery, [], "memory");
      const registered = store.read(runId);
      if (transition === "redo") service.redo(control, "a", "redo");
      else service.cancel(control, "cancel");
      const saved = store.read(runId);
      expect(saved.evidence).toEqual(registered.evidence);
      expect(saved.inputs).toEqual(registered.inputs);
      expect(
        service.evidenceForCall(op, evidenceQuery, "data").sourceRef,
      ).toEqual(evidence);
      expect(
        service.recordEvidence(op, evidenceQuery, data(999), "data"),
      ).toEqual(evidence);
      expect(
        service.memoryInputForCall(op, memoryQuery, "memory").inputRef,
      ).toEqual(memory.inputRef);
      expect(
        service.recordMemoryInput(op, memoryQuery, memoryEntries, "memory"),
      ).toEqual(memory);
      for (const action of [
        () => service.evidenceForCall(op, evidenceQuery, "new"),
        () => service.recordEvidence(op, evidenceQuery, data(), "new"),
        () => service.memoryInputForCall(op, memoryQuery, "new"),
        () => service.recordMemoryInput(op, memoryQuery, [], "new"),
      ]) {
        expect(action).toThrowError(
          expect.objectContaining({ code: "STALE_ATTEMPT" }),
        );
      }
      expect(store.read(runId)).toEqual(saved);
    },
  );

  it("allows valid blocked attempts to register both snapshot types without succeeding", () => {
    const { service, store, op, runId } = setup();
    service.block(
      { runId, identity: "owner" },
      [
        {
          taskId: null,
          attempt: null,
          code: "WAIT",
          message: "Review pending",
        },
      ],
      "block",
    );
    service.recordEvidence(op, evidenceQuery, data(), "data");
    service.recordMemoryInput(op, memoryQuery, [], "memory");
    expect(store.read(runId)).toMatchObject({
      status: "blocked",
      tasks: [{ status: "running" }, { status: "pending" }],
    });
  });

  it.each(["write", "rename"] as const)(
    "does not register a successful call when %s fails before publication and permits retry",
    (failurePoint) => {
      const { service, store, op, runId } = setup();
      const saved = store.read(runId);
      const failure = new Error(`${failurePoint} failed`);
      if (failurePoint === "write") {
        const write = fs.writeFileSync;
        vi.spyOn(fs, "writeFileSync").mockImplementation(
          (...args: Parameters<typeof fs.writeFileSync>) => {
            if (typeof args[0] === "number") throw failure;
            return write(...args);
          },
        );
      } else
        vi.spyOn(fs, "renameSync").mockImplementation(() => {
          throw failure;
        });
      expect(
        caught(() => service.recordEvidence(op, evidenceQuery, data(), "data")),
      ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
      vi.restoreAllMocks();
      expect(store.read(runId)).toEqual(saved);
      expect(
        service.evidenceForCall(op, evidenceQuery, "data").sourceRef,
      ).toBeNull();
      const ref = service.recordEvidence(op, evidenceQuery, data(), "data");
      expect(store.read(runId).evidence).toHaveLength(1);
      expect(service.readEvidence(ref).envelope.data).toEqual({
        price: 123,
        volume: 0,
      });
    },
  );

  it("replays a published evidence receipt after directory sync failure without another file or revision", () => {
    const { service, store, op, path, runId } = setup();
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("directory sync failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      if (String(args[1]).endsWith("/manifest.json")) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() => service.recordEvidence(op, evidenceQuery, data(), "data")),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    const saved = store.read(runId);
    const before = files(path, runId);
    const ref = service.evidenceForCall(op, evidenceQuery, "data").sourceRef!;
    expect(
      service.recordEvidence(op, evidenceQuery, data(999), "data"),
    ).toEqual(ref);
    expect(store.read(runId)).toEqual(saved);
    expect(files(path, runId)).toEqual(before);
    expect(
      service.readEvidence<{ price: number }>(ref).envelope.data.price,
    ).toBe(123);
  });

  it("rejects registration and preflight after closing the data root", () => {
    const { service, op, root } = setup();
    root.close();
    for (const action of [
      () => service.evidenceForCall(op, evidenceQuery, "data"),
      () => service.recordEvidence(op, evidenceQuery, data(), "data"),
      () => service.memoryInputForCall(op, memoryQuery, "memory"),
      () => service.recordMemoryInput(op, memoryQuery, [], "memory"),
    ]) {
      expect(action).toThrowError(
        expect.objectContaining({ code: "STORAGE_FAILED" }),
      );
    }
  });
});

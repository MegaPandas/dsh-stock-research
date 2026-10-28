import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import type {
  MemoryState,
  RememberInput,
  QueryMemoryReturns,
} from "../../src/contracts/memory-service.js";
import type {
  PriceReturnsQuery,
  QueryResponse,
} from "../../src/contracts/query.js";
import type { OpenRunInput, RunState } from "../../src/contracts/runs.js";
import { MemoryStore } from "../../src/memory/store.js";
import { RunStore } from "../../src/runs/store.js";
import { MemoryService } from "../../src/services/memory.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import {
  MARKET_FIXTURE,
  US_SECURITY,
  CN_SECURITY,
} from "../fixtures/market.js";

const request: PriceReturnsQuery = {
  dataset: "returns",
  provider: "yahoo",
  parameters: {
    historyStartDate: "2024-01-01",
    startDate: "2024-01-01",
    endDate: "2024-01-06",
    maxAgeMs: 60_000,
    comparable: true,
  },
};
function response(): QueryResponse<PriceReturnsQuery> {
  return {
    ...structuredClone(MARKET_FIXTURE),
    dataset: "returns",
    data: {
      market: structuredClone(MARKET_FIXTURE.data),
      algorithmVersion: "returns-v1",
      requestedStartDate: "2024-01-01",
      requestedEndDate: "2024-01-06",
      start: {
        date: "2024-01-02",
        price: 10,
        currency: "USD",
        adjustment: "split_adjusted",
        asOf: "2024-01-02T21:00:00.000Z",
        availableAt: null,
      },
      end: {
        date: "2024-01-05",
        price: 12,
        currency: "USD",
        adjustment: "split_adjusted",
        asOf: "2024-01-05T21:00:00.000Z",
        availableAt: null,
      },
      comparable: true,
      value: 0.2,
      unit: "ratio",
    },
    gaps: [
      {
        code: "unverified_time",
        field: "/data",
        detail: "Synthetic source publication time unknown.",
      },
    ],
    candidateClaims: [],
  };
}
function input(note = "Review note"): RememberInput {
  return {
    previous: null,
    outcome: "Confirmed",
    note,
    evidence: [],
    returns: {
      kind: "unavailable",
      gaps: [
        {
          code: "missing",
          field: "/returns",
          detail: "No comparable prices available.",
        },
      ],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup(query: QueryMemoryReturns = async () => response()) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-memory-service-"));
  const root = new DataRoot(directory);
  const runs = new RunService(
    new RunStore<RunState>(root),
    () => "2024-01-04T00:00:00.000Z",
  );
  let store!: MemoryStore<MemoryState>;
  let timestamp = "2024-01-05T00:00:00.000Z";
  const services: MemoryService[] = [];
  function service(source = query) {
    store = new MemoryStore<MemoryState>(root, () => ({
      stateVersion: 1,
      receipts: [],
    }));
    const result = new MemoryService(store, runs, source, () => timestamp);
    services.push(result);
    return result;
  }
  const memory = service();
  const scope: ResearchScope = {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-10T00:00:00.000Z",
  };
  let sequence = 0;
  function open(security = US_SECURITY) {
    const definition: OpenRunInput = {
      definition: {
        scope: { ...scope, security },
        mode: "quick",
        tasks: [
          {
            id: "a",
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
      inputs: [],
    };
    const { runId } = runs.open("owner", definition, `open-${sequence++}`);
    return { runId, identity: "owner", scope: definition.definition.scope };
  }
  const operation = open();
  cleanups.push(async () => {
    await Promise.all(services.map((item) => item.close()));
    root.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    memory,
    runs,
    store,
    operation,
    scope,
    open,
    service,
    time: (value: string) => {
      timestamp = value;
    },
    recall: (target = scope, parameters = {}) =>
      memory.recall(target, {
        runId: null,
        text: null,
        limit: 100,
        ...parameters,
      }),
  };
}

describe("MemoryService durable review history", () => {
  it("adds and revises immutable history without changing the linked run", async () => {
    const c = setup();
    const before = c.runs.view(c.operation);
    const first = await c.memory.remember(
      c.operation,
      input("Original"),
      "first",
    );
    const second = await c.memory.remember(
      c.operation,
      { ...input("Revised"), previous: first },
      "second",
    );
    expect(second).toEqual({ entryId: first.entryId, revision: 2 });
    expect(c.memory.read(first).note).toBe("Original");
    expect(c.memory.read(second)).toMatchObject({
      previous: first,
      note: "Revised",
      runId: c.operation.runId,
      identity: "owner",
    });
    expect(c.runs.view(c.operation)).toEqual(before);
  });
  it("selects the last recorded revision at the inclusive cutoff", async () => {
    const c = setup();
    const first = await c.memory.remember(
      c.operation,
      input("Original"),
      "first",
    );
    c.time("2024-01-06T00:00:00.000Z");
    const second = await c.memory.remember(
      c.operation,
      { ...input("Revised"), previous: first },
      "second",
    );
    expect(
      c
        .recall({ ...c.scope, cutoff: "2024-01-05T00:00:00.000Z" })
        .map((item) => item.ref),
    ).toEqual([first]);
    expect(
      c
        .recall({ ...c.scope, cutoff: "2024-01-06T00:00:00.000Z" })
        .map((item) => item.ref),
    ).toEqual([second]);
    expect(
      c.recall({ ...c.scope, cutoff: "2024-01-04T00:00:00.000Z" }),
    ).toEqual([]);
  });
  it("filters text after choosing the revision, using literal case-insensitive text", async () => {
    const c = setup();
    const first = await c.memory.remember(
      c.operation,
      input("OLD [literal]"),
      "first",
    );
    await c.memory.remember(
      c.operation,
      { ...input("New [literal]"), previous: first },
      "second",
    );
    expect(c.recall(c.scope, { text: "old" })).toEqual([]);
    expect(c.recall(c.scope, { text: "[LITERAL]" })).toHaveLength(1);
    expect(c.recall(c.scope, { text: "confirmed" })).toHaveLength(1);
    expect(c.recall(c.scope, { text: ".*" })).toEqual([]);
  });
  it("isolates security and run, sorts newest first, then applies limit", async () => {
    const c = setup();
    await c.memory.remember(c.operation, input("Older"), "old");
    const other = c.open();
    c.time("2024-01-06T00:00:00.000Z");
    const latest = await c.memory.remember(other, input("Latest"), "new");
    const cn = c.open(CN_SECURITY);
    await c.memory.remember(cn, input("Chinese security"), "cn");
    expect(c.recall(c.scope, { limit: 1 }).map((item) => item.ref)).toEqual([
      latest,
    ]);
    expect(
      c
        .recall(c.scope, { runId: c.operation.runId })
        .map((item) => item.content.note),
    ).toEqual(["Older"]);
    expect(c.recall(cn.scope).map((item) => item.content.note)).toEqual([
      "Chinese security",
    ]);
  });
  it("orders equal timestamps by entry id", async () => {
    const c = setup();
    const refs = await Promise.all([
      c.memory.remember(c.operation, input("a"), "a"),
      c.memory.remember(c.operation, input("b"), "b"),
    ]);
    expect(c.recall().map((item) => item.ref.entryId)).toEqual(
      refs.map((ref) => ref.entryId).sort(),
    );
  });
  it("replays persisted request receipts after service reconstruction without another source query", async () => {
    const source = vi.fn(async () => response());
    const c = setup(source);
    const content = {
      ...input(),
      returns: { kind: "query" as const, request },
    };
    const ref = await c.memory.remember(c.operation, content, "same");
    await c.memory.close();
    const restored = c.service(source);
    expect(await restored.remember(c.operation, content, "same")).toEqual(ref);
    expect(source).toHaveBeenCalledTimes(1);
    await expect(
      restored.remember(c.operation, { ...content, note: "Changed" }, "same"),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it("scopes request ids by identity and linked run", async () => {
    const c = setup();
    const first = await c.memory.remember(c.operation, input("owner"), "same");
    const identity = await c.memory.remember(
      { ...c.operation, identity: "reviewer" },
      input("reviewer"),
      "same",
    );
    const run = await c.memory.remember(c.open(), input("another run"), "same");
    expect(new Set([first.entryId, identity.entryId, run.entryId]).size).toBe(
      3,
    );
  });
  it("records actual return prices, basis and provenance without market payload or candidate claims", async () => {
    const supplied = response();
    const source = vi.fn(async () => supplied);
    const c = setup(source);
    const ref = await c.memory.remember(
      c.operation,
      { ...input(), returns: { kind: "query", request } },
      "returns",
    );
    const recorded = c.memory.read(ref).returns;
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith(
      c.operation.scope,
      request,
      expect.any(AbortSignal),
    );
    if (recorded.kind !== "recorded")
      throw new Error("Expected recorded returns");
    const expected = { ...supplied.data };
    Reflect.deleteProperty(expected, "market");
    expect(recorded.snapshot).toEqual({
      scope: c.operation.scope,
      request,
      envelope: { ...supplied, data: expected, candidateClaims: undefined },
    });
    expect(recorded.snapshot.envelope).not.toHaveProperty("candidateClaims");
    expect(recorded.snapshot.envelope.data).not.toHaveProperty("market");
    expect(supplied.data).toHaveProperty("market");
  });
  it("stores explicit unavailable-return explanations without querying", async () => {
    const source = vi.fn(async () => response());
    const c = setup(source);
    const content = input();
    const ref = await c.memory.remember(c.operation, content, "unavailable");
    expect(c.memory.read(ref).returns).toEqual(content.returns);
    expect(source).not.toHaveBeenCalled();
  });
  it("retains missing return values and endpoint gaps without inventing a number", async () => {
    const supplied = response();
    supplied.data.end = null;
    supplied.data.value = null;
    supplied.gaps.push({
      code: "missing",
      field: "/data/end",
      detail: "No closing price at the end.",
    });
    const c = setup(async () => supplied);
    const ref = await c.memory.remember(
      c.operation,
      { ...input(), returns: { kind: "query", request } },
      "missing-end",
    );
    const result = c.memory.read(ref).returns;
    expect(result).toMatchObject({
      kind: "recorded",
      snapshot: {
        envelope: {
          data: { end: null, value: null, unit: "ratio" },
          gaps: supplied.gaps,
        },
      },
    });
  });
  it("recovers a published receipt after the response is lost without another query or revision", async () => {
    const source = vi.fn(async () => response());
    const c = setup(source);
    const publish = c.store.commit.bind(c.store);
    const failure = new Error("response lost after publication");
    vi.spyOn(c.store, "commit").mockImplementationOnce((build) => {
      publish(build);
      throw failure;
    });
    const content = {
      ...input(),
      returns: { kind: "query" as const, request },
    };
    await expect(
      c.memory.remember(c.operation, content, "published"),
    ).rejects.toBe(failure);
    const saved = c.store.readIndex();
    const result = await c.memory.remember(c.operation, content, "published");
    expect(c.memory.read(result).note).toBe(content.note);
    expect(c.store.readIndex()).toEqual(saved);
    expect(source).toHaveBeenCalledTimes(1);
  });
  it("shares concurrent identical requests and rejects changed content", async () => {
    const pending = deferred<QueryResponse<PriceReturnsQuery>>();
    const source = vi.fn(() => pending.promise);
    const c = setup(source);
    const content = {
      ...input(),
      returns: { kind: "query" as const, request },
    };
    const first = c.memory.remember(c.operation, content, "same");
    const second = c.memory.remember(c.operation, content, "same");
    await expect(
      c.memory.remember(c.operation, { ...content, note: "Changed" }, "same"),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    pending.resolve(response());
    expect(await first).toEqual(await second);
    expect(source).toHaveBeenCalledTimes(1);
    expect(c.recall()).toHaveLength(1);
  });
  it("propagates source failures without publishing a receipt or entry", async () => {
    const failure = new Error("source unavailable");
    const c = setup(async () => {
      throw failure;
    });
    await expect(
      c.memory.remember(
        c.operation,
        { ...input(), returns: { kind: "query", request } },
        "failed",
      ),
    ).rejects.toBe(failure);
    expect(c.store.readIndex().receipts).toEqual([]);
    expect(c.recall()).toEqual([]);
  });
  it("honors cancellation before querying or publishing", async () => {
    const source = vi.fn(async () => response());
    const c = setup(source);
    const controller = new AbortController();
    const reason = new Error("cancelled before start");
    controller.abort(reason);
    await expect(
      c.memory.remember(c.operation, input(), "aborted", controller.signal),
    ).rejects.toBe(reason);
    expect(source).not.toHaveBeenCalled();
    expect(c.store.readIndex().receipts).toEqual([]);
  });
  it("does not publish after cancellation while the source is pending", async () => {
    const pending = deferred<QueryResponse<PriceReturnsQuery>>();
    const started = deferred<AbortSignal>();
    const c = setup(async (_scope, _request, signal) => {
      started.resolve(signal!);
      return pending.promise;
    });
    const controller = new AbortController();
    const writing = c.memory.remember(
      c.operation,
      { ...input(), returns: { kind: "query", request } },
      "cancel",
      controller.signal,
    );
    const signal = await started.promise;
    const reason = new Error("cancelled during query");
    controller.abort(reason);
    await expect(writing).rejects.toBe(reason);
    expect(signal.aborted).toBe(true);
    pending.resolve(response());
    await c.memory.close();
    expect(c.store.readIndex().receipts).toEqual([]);
  });
  it("close waits for the actual source completion and prevents publication", async () => {
    const pending = deferred<QueryResponse<PriceReturnsQuery>>();
    const started = deferred<void>();
    const c = setup(async () => {
      started.resolve();
      return pending.promise;
    });
    const writing = c.memory.remember(
      c.operation,
      { ...input(), returns: { kind: "query", request } },
      "close",
    );
    const rejected = expect(writing).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    let closed = false;
    const closing = c.memory.close().then(() => {
      closed = true;
    });
    await rejected;
    expect(closed).toBe(false);
    pending.resolve(response());
    await closing;
    expect(c.store.readIndex().receipts).toEqual([]);
  });
  it("rechecks the head after awaiting returns so a newer revision cannot be overwritten", async () => {
    const pending = deferred<QueryResponse<PriceReturnsQuery>>();
    const started = deferred<void>();
    const c = setup(async () => {
      started.resolve();
      return pending.promise;
    });
    const first = await c.memory.remember(
      c.operation,
      input("original"),
      "first",
    );
    const slow = c.memory.remember(
      c.operation,
      {
        ...input("slow"),
        previous: first,
        returns: { kind: "query", request },
      },
      "slow",
    );
    await started.promise;
    const latest = await c.memory.remember(
      c.operation,
      { ...input("latest"), previous: first },
      "latest",
    );
    pending.resolve(response());
    await expect(slow).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(c.recall().map((item) => item.ref)).toEqual([latest]);
    expect(c.store.readIndex().receipts).toHaveLength(2);
  });
  it("rejects review security that differs from the linked run", async () => {
    const c = setup();
    await expect(
      c.memory.remember(
        { ...c.operation, scope: { ...c.scope, security: CN_SECURITY } },
        input(),
        "foreign-security",
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(c.recall()).toEqual([]);
  });
  it("rejects revisions and references from another run", async () => {
    const c = setup();
    const first = await c.memory.remember(c.operation, input(), "first");
    const other = c.open();
    await expect(
      c.memory.remember(
        other,
        { ...input(), previous: first },
        "foreign-revision",
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      c.memory.remember(
        other,
        {
          ...input(),
          evidence: [
            {
              runId: c.operation.runId,
              evidenceId: "foreign",
              selector: "/data",
            },
          ],
        },
        "foreign-evidence",
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      c.memory.remember(
        other,
        {
          ...input(),
          evidence: [
            { runId: c.operation.runId, artifactId: "foreign", revision: 1 },
          ],
        },
        "foreign-artifact",
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("reads immutable evidence and fixed artifact references after the task is redone", async () => {
    const c = setup();
    const task = {
      ...c.runs.claim(c.operation, "a", "claim"),
      identity: "worker",
      sessionId: null,
    };
    const source = c.runs.recordEvidence(
      task,
      {
        dataset: "market",
        provider: "yahoo",
        parameters: { startDate: "2024-01-02", maxAgeMs: 60_000 },
      },
      { envelope: structuredClone(MARKET_FIXTURE), candidates: [] },
      "data",
    );
    const artifact = c.runs.commitArtifact(
      task,
      [
        {
          kind: "analysis",
          title: "Original",
          body: "Original analysis",
          inputRefs: [],
          claims: [],
          payload: {},
        },
      ],
      "submit",
    ).refs[0]!;
    c.runs.redo(c.operation, "a", "redo");
    const evidence = [{ ...source, selector: "/data/bars/0/close" }, artifact];
    const ref = await c.memory.remember(
      c.operation,
      { ...input(), evidence },
      "review",
    );
    expect(c.memory.read(ref).evidence).toEqual(evidence);
    expect(c.runs.readArtifact(artifact).content).toMatchObject({
      body: "Original analysis",
    });
    expect(c.runs.readEvidence(source).envelope.data).toEqual(
      MARKET_FIXTURE.data,
    );
  });
});

import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionStopped } from "../../src/contracts/errors.js";
import type { OpenRunInput } from "../../src/contracts/runs.js";
import type { ArtifactPayloads } from "../../src/contracts/artifact-payloads.js";
import type { CollectionRecord } from "../../src/contracts/collection.js";
import { CollectionSnapshotStore } from "../../src/storage/collection-snapshots.js";
import { gate, runtimeHost } from "../fixtures/runtime-host.js";
import { CN_SECURITY } from "../fixtures/market.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

function response() {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        sh600519: { day: [["2024-01-03", "100", "102", "105", "95", "1000"]] },
      },
    }),
  );
}

async function host() {
  const h = await runtimeHost();
  cleanups.push(h.close);
  const { runtime } = await h.mount(
    h.config({
      enabledSources: ["tencent"],
      http: { timeoutMs: 60_000, maxConcurrency: 1, minIntervalMs: 0 },
    }),
  );
  runtime.bindCoordinator(h.outside.agent);
  const definition: OpenRunInput = {
    definition: {
      scope: {
        security: CN_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T08:00:00.000Z",
      },
      mode: "quick",
      tasks: (["required", "macro"] as const).map((node) => ({
        id: `data.${node}`,
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
  const view = runtime.openRun(h.outside.agent, definition, "open-collection");
  const operation = { runId: view.runId, identity: h.outside.agent.id };
  const schedule = (node: "required" | "macro", attempt = 1) =>
    runtime.executeScheduled(
      h.outside.agent,
      view.runId,
      {
        kind: "task",
        taskId: `data.${node}`,
        attempt,
        executor: { kind: "service", service: "collection", node },
        requestId: `${node}-${attempt}`,
      },
      new AbortController().signal,
    );
  return { ...h, runtime, operation, schedule };
}

function causes(cause: unknown): unknown[] {
  return [
    cause,
    ...(cause instanceof AggregateError ? cause.errors.flatMap(causes) : []),
    ...(cause instanceof Error && cause.cause !== undefined
      ? causes(cause.cause)
      : []),
  ];
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

it("routes a ready collection through the real runtime without a model and skips an obsolete plan", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:01:00.000Z"));
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  const h = await host();
  await h.schedule("required");
  const first = h.runtime.runs.view(h.operation);
  const required = first.tasks.find(
    ({ taskId }) => taskId === "data.required",
  )!;
  expect(required).toMatchObject({ status: "succeeded", attempt: 1 });
  expect(
    h.runtime.runs.readAttempt({
      ...h.operation,
      taskId: "data.required",
      attempt: 1,
    }).sessionId,
  ).toBeNull();
  expect(required.outputRefs).toHaveLength(1);
  const artifact = h.runtime.runs.readArtifact(required.outputRefs[0]!);
  expect(artifact.content).toMatchObject({
    kind: "collection",
    payload: {
      capturedFrom: null,
      capturedAt: "2024-01-03T08:01:00.000Z",
      snapshot: {
        node: "required",
        scope: first.scope,
        packets: [
          {
            id: "market.daily",
            envelope: {
              source: { provider: "tencent" },
              cutoff: first.scope.cutoff,
            },
          },
        ],
      },
    },
  });
  const payload = artifact.content.payload as ArtifactPayloads["collection"];
  expect(payload.snapshot.recordPath).toEqual(expect.any(String));
  expect(fs.existsSync(payload.snapshot.recordPath!)).toBe(true);
  await h.schedule("required");
  expect(h.runtime.runs.view(h.operation)).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  await h.schedule("macro");
  expect(
    h.runtime.runs
      .view(h.operation)
      .tasks.every(({ status }) => status === "succeeded"),
  ).toBe(true);
  expect(h.adapter.requests).toEqual([]);
  expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
});

it.each(["task", "run"] as const)(
  "publishes %s cancellation before draining a collection while retaining an independent completed data node",
  async (kind) => {
    const pause = gate<AbortSignal>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, options: RequestInit) => {
        const signal = options.signal!;
        signal.addEventListener("abort", () => pause.aborted.resolve(), {
          once: true,
        });
        pause.started.resolve(signal);
        await pause.released.promise;
        signal.throwIfAborted();
        return response();
      }),
    );
    const h = await host();
    cleanups.push(() => pause.released.resolve());
    const work = observe(h.schedule("required"));
    await pause.started.promise;
    await h.schedule("macro");
    const independent = h.runtime.runs
      .view(h.operation)
      .tasks.find(({ taskId }) => taskId === "data.macro")!.outputRefs;
    let stopped = false;
    const request =
      kind === "task"
        ? h.runtime.dispatch.cancelTask(
            h.operation,
            {
              taskId: "data.required",
              expectedAttempt: 1,
              reason: "Stop this data branch",
            },
            "cancel-required",
          )
        : h.runtime.dispatch.cancel(h.operation, "cancel-run");
    const control = request.then((result) => {
      stopped = true;
      return result;
    });
    await pause.aborted.promise;
    expect(
      h.runtime.runs
        .view(h.operation)
        .tasks.find(({ taskId }) => taskId === "data.required"),
    ).toMatchObject({ status: "cancelled", outputRefs: [] });
    expect(() =>
      h.runtime.dispatch.recoverInterrupted(
        h.operation,
        [{ taskId: "data.required", attempt: 1 }],
        "recover-held",
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    await setImmediate();
    expect(stopped).toBe(false);
    pause.released.resolve();
    expect(await work).toEqual({ status: "fulfilled", value: undefined });
    expect(await control).toMatchObject(
      kind === "task"
        ? { taskId: "data.required", attempt: 1 }
        : { runId: h.operation.runId, status: "cancelled" },
    );
    expect(h.runtime.runs.view(h.operation).status).toBe(
      kind === "task" ? "active" : "cancelled",
    );
    expect(
      h.runtime.runs
        .view(h.operation)
        .tasks.find(({ taskId }) => taskId === "data.macro")!.outputRefs,
    ).toEqual(independent);
    expect(h.runtime.runs.readArtifact(independent[0]!).content.kind).toBe(
      "collection",
    );
    expect(h.adapter.requests).toEqual([]);
  },
);

it("preserves cancellation record failures through scheduling and the independent control entry", async () => {
  const pause = gate<AbortSignal>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const signal = options.signal!;
      signal.addEventListener("abort", () => pause.aborted.resolve(), {
        once: true,
      });
      pause.started.resolve(signal);
      await pause.released.promise;
      signal.throwIfAborted();
      return response();
    }),
  );
  const save = CollectionSnapshotStore.prototype.save;
  const failure = new Error("Cannot retain the cancelled data node");
  vi.spyOn(CollectionSnapshotStore.prototype, "save").mockImplementation(
    function (this: CollectionSnapshotStore, record: CollectionRecord) {
      if (record.status === "cancelled") throw failure;
      return save.call(this, record);
    },
  );
  const h = await host();
  cleanups.push(() => pause.released.resolve());
  const work = observe(h.schedule("required"));
  const signal = await pause.started.promise;
  const control = observe(
    h.runtime.dispatch.cancelTask(
      h.operation,
      {
        taskId: "data.required",
        expectedAttempt: 1,
        reason: "Stop and retain diagnostics",
      },
      "cancel-with-write-failure",
    ),
  );
  await pause.aborted.promise;
  expect(signal.reason).toBeInstanceOf(ExecutionStopped);
  pause.released.resolve();
  for (const result of await Promise.all([work, control])) {
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected")
      throw new Error("Expected the actual release error");
    expect(causes(result.reason)).toContain(failure);
    expect(causes(result.reason)).toContain(signal.reason);
  }
  expect(
    h.runtime.runs
      .view(h.operation)
      .tasks.find(({ taskId }) => taskId === "data.required"),
  ).toMatchObject({ status: "cancelled", outputRefs: [] });
  expect(h.adapter.requests).toEqual([]);
});

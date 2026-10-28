import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { errorChain, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskOperation } from "../../src/contracts/runs.js";
import { HostDigestModel } from "../../src/host/digest-model.js";
import {
  analysis,
  captureModelLogs,
  DigestAdapter,
  digestSubmit,
  dispatchHost,
  modelGate,
  type ModelGate,
  type ModelScript,
} from "../fixtures/dispatch-host.js";
import { MARKET_FIXTURE } from "../fixtures/market.js";

const cleanups: (() => Promise<void>)[] = [];
const route = { provider: "digest-fixture", model: "digest" };
const usage = {
  inputTokens: 9,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  totalTokens: 18,
};
function draft(request: GenerateOptions) {
  const first = request.messages.find((message) => message.role === "user")!
    .content[0]!;
  if (first.type !== "text")
    throw new Error("Expected the fixed digest context");
  const input = JSON.parse(first.text) as {
    context: {
      materials: { body: string }[];
      requiredRisks: { issueId: string }[];
    };
  };
  return {
    title: "Host digest",
    body: input.context.materials.map((item) => item.body).join("\n"),
    facts: ["Fixed upstream finding"],
    disagreements: [],
    riskSummaries: input.context.requiredRisks.map((risk) => ({
      issueId: risk.issueId,
      text: "Inherited risk",
    })),
  };
}
async function host(
  scripts: ModelScript[] = [],
  respond: ConstructorParameters<typeof DigestAdapter>[0] = (request) =>
    digestSubmit(request, draft(request), usage),
) {
  const h = await dispatchHost(
    scripts,
    (ctx) => new HostDigestModel(ctx, route).generate,
  );
  cleanups.push(h.close);
  const digestAdapter = new DigestAdapter(respond);
  h.ctx.llm.registerAdapter([route.provider], digestAdapter);
  return { ...h, digestAdapter, logs: captureModelLogs(h.ctx) };
}
type Fixture = Awaited<ReturnType<typeof host>>;
function fixedAnalysis(h: Fixture) {
  const claim = h.runs.claim(h.operation, "analysis", "fixed-analysis");
  const operation: TaskOperation = {
    ...claim,
    identity: "fixed-analyst",
    sessionId: null,
  };
  const envelope = structuredClone(MARKET_FIXTURE);
  envelope.data.bars = envelope.data.bars.slice(0, 2);
  envelope.asOf = "2024-01-03T21:00:00.000Z";
  envelope.availableAt = envelope.asOf;
  envelope.retrievedAt = "2024-01-03T21:30:00.000Z";
  envelope.cutoff = h.scope.cutoff;
  const source = h.runs.recordEvidence(
    operation,
    { dataset: "market", provider: "fixture", parameters: {} },
    { envelope, candidates: [] },
    "fixed-price",
  );
  const content = analysis();
  content.body = "Observed {{number:close}}.";
  content.claims = [
    {
      id: "close",
      kind: "observed",
      value: 12,
      unit: "USD/share",
      source: { ...source, selector: "/data/bars/1/close" },
    },
  ];
  if (content.kind !== "analysis") throw new Error("Expected analysis fixture");
  content.payload.findings[0]!.numbers = [{ kind: "local", claimId: "close" }];
  return h.artifacts.submitArtifact(operation, [content], "fixed-analysis");
}
async function* gatedDigest(request: GenerateOptions, gate: ModelGate) {
  const aborted = () => gate.aborted.resolve();
  request.signal?.addEventListener("abort", aborted, { once: true });
  if (request.signal?.aborted) aborted();
  yield { type: "usage" as const, usage };
  gate.started.resolve(request);
  try {
    await gate.released.promise;
    yield* digestSubmit(request, draft(request));
  } finally {
    request.signal?.removeEventListener("abort", aborted);
  }
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("host model ownership through the research service facade", () => {
  it("submits a numeric fixed-input digest through the SDK tool and replays without model calls", async () => {
    const h = await host();
    const upstream = fixedAnalysis(h);
    const args = { runId: h.runId, taskId: "digest", requestId: "digest" };
    const result = await h.call("stock_make_digest", args);
    expect(result).toMatchObject({
      isError: false,
      value: { taskId: "digest", attempt: 1 },
    });
    const saved = await h.bridge.makeDigest(h.operation, "digest", "digest");
    expect(result.value).toEqual(saved);
    expect(h.digestAdapter.requests).toHaveLength(1);
    const version = h.runs.readArtifact(saved.refs[0]!);
    expect(version.content).toMatchObject({
      kind: "digest",
      inputRefs: upstream.refs,
      claims: [],
      payload: {
        facts: [
          {
            evidence: [],
            numbers: [],
          },
        ],
      },
    });
    expect(version.content.body).toContain("12");
    expect(version.content.body).not.toContain("{{number:");
    expect(h.logs.filter((record) => record.kind === "digest")).toEqual([
      expect.objectContaining({
        runId: h.runId,
        taskId: "digest",
        attempt: 1,
        sessionId: h.digestAdapter.requests[0]!.sessionId,
        usage,
        outcome: "committed",
      }),
    ]);
  });

  it("rejects invalid business fields at the native submission boundary without publishing a digest", async () => {
    const h = await host([], (request) =>
      digestSubmit(request, { unexpected: "field" }),
    );
    fixedAnalysis(h);
    await expect(
      h.bridge.makeDigest(h.operation, "digest", "invalid-draft"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "digest", attempt: 1 }),
    ).toMatchObject({
      status: "failed",
      outputRefs: [],
      failure: { code: "INVALID_INPUT" },
    });
  });

  it("does not restart a running digest receipt without an execution owned by this host", async () => {
    const h = await host();
    fixedAnalysis(h);
    h.runs.claimService(
      h.operation,
      "digest",
      "digest",
      JSON.stringify(["digest", "digest", "lost"]),
    );
    await expect(
      h.bridge.makeDigest(h.operation, "digest", "lost"),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    expect(h.digestAdapter.requests).toHaveLength(0);
  });

  it("drains an invalidated digest before its replacement starts while an independent role can finish", async () => {
    const gate = modelGate();
    let calls = 0;
    const h = await host([{ kind: "save" }], (request) =>
      ++calls === 1
        ? gatedDigest(request, gate)
        : digestSubmit(request, draft(request)),
    );
    cleanups.push(async () => {
      gate.released.resolve();
    });
    fixedAnalysis(h);
    const old = observe(h.bridge.makeDigest(h.operation, "digest", "old"));
    await gate.started.promise;
    let stopped = false;
    const redo = h.bridge
      .redo(h.operation, "digest", "redo-digest")
      .then((value) => {
        stopped = true;
        return value;
      });
    await gate.aborted.promise;
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "digest", attempt: 1 })
        .status,
    ).toBe("invalidated");
    const replacement = h.bridge.makeDigest(
      h.operation,
      "digest",
      "replacement",
    );
    await setImmediate();
    expect(h.digestAdapter.requests).toHaveLength(1);
    expect(
      h.runs.view(h.operation).tasks.find((task) => task.taskId === "digest"),
    ).toMatchObject({ status: "pending", attempt: 1 });
    expect(stopped).toBe(false);
    expect(await h.dispatch("parallel", "parallel")).toMatchObject({
      status: "succeeded",
    });
    gate.released.resolve();
    expect(await old).toMatchObject({
      kind: "rejected",
      reason: expect.any(Error),
    });
    await redo;
    const saved = await replacement;
    expect(saved.attempt).toBe(2);
    expect(h.runs.readAttempt(saved)).toMatchObject({
      status: "succeeded",
      outputRefs: saved.refs,
    });
    expect(h.digestAdapter.requests).toHaveLength(2);
  });

  it.each(["cancel", "close"] as const)(
    "%s cancels and drains an owned digest without committing a late submission",
    async (method) => {
      const gate = modelGate();
      const h = await host([], (request) => gatedDigest(request, gate));
      cleanups.push(async () => {
        gate.released.resolve();
      });
      fixedAnalysis(h);
      const work = observe(
        h.bridge.makeDigest(h.operation, "digest", "waiting"),
      );
      await gate.started.promise;
      let stopped = false;
      const stop = (
        method === "cancel"
          ? h.bridge.cancel(h.operation, "cancel")
          : h.bridge.close()
      ).then(() => {
        stopped = true;
      });
      await gate.aborted.promise;
      expect(stopped).toBe(false);
      if (method === "cancel")
        expect(h.runs.view(h.operation).status).toBe("cancelled");
      else
        await expect(
          h.bridge.makeDigest(h.operation, "digest", "after-close"),
        ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      gate.released.resolve();
      expect(await work).toMatchObject({
        kind: "rejected",
        reason: expect.any(Error),
      });
      await stop;
      expect(
        h.runs.readAttempt({ runId: h.runId, taskId: "digest", attempt: 1 }),
      ).toMatchObject({
        status: method === "cancel" ? "cancelled" : "failed",
        outputRefs: [],
      });
      expect(h.logs.find((record) => record.kind === "digest")).toMatchObject({
        outcome: "committed",
        finish: null,
        usage,
      });
    },
  );

  it("surfaces failed failure-recording to the original caller and close", async () => {
    const gate = modelGate();
    const h = await host([], (request) => gatedDigest(request, gate));
    cleanups.push(async () => {
      gate.released.resolve();
    });
    fixedAnalysis(h);
    const work = observe(
      h.bridge.makeDigest(h.operation, "digest", "storage-fault"),
    );
    await gate.started.promise;
    const rename = fs.renameSync;
    const failure = new Error("Fixture manifest publication failed");
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const target = String(to);
      if (
        target.startsWith(`${h.root.path}/runs/`) &&
        target.endsWith("/manifest.json")
      )
        throw failure;
      rename(from, to);
    });
    try {
      const closing = observe(h.bridge.close());
      await gate.aborted.promise;
      gate.released.resolve();
      const original = await work;
      const stopped = await closing;
      expect(original).toMatchObject({
        kind: "rejected",
        reason: { code: "STORAGE_FAILED", cause: expect.any(AggregateError) },
      });
      expect(stopped).toMatchObject({
        kind: "rejected",
        reason: { code: "STORAGE_FAILED" },
      });
      if (original.kind !== "rejected" || stopped.kind !== "rejected")
        throw new Error("The failed recording must reach both owners");
      expect(errorChain(original.reason)).toContain(failure.message);
      expect(errorChain(stopped.reason)).toContain(failure.message);
    } finally {
      fault.mockRestore();
      gate.released.resolve();
      await work;
    }
  });

  it("records real role model requests with provided and missing usage and exact task sessions", async () => {
    const h = await host([{ kind: "save", usage }, { kind: "text" }]);
    const saved = await h.dispatch("role", "analysis");
    const missing = await h.dispatch("missing", "parallel");
    const providedRecords = h.logs.filter(
      (record) => record.kind === "role" && record.taskId === "analysis",
    );
    expect(providedRecords).toHaveLength(2);
    for (const record of providedRecords)
      expect(record).toMatchObject({
        runId: h.runId,
        attempt: 1,
        sessionId: saved.sessionId,
        provider: "fixture",
        model: "dispatch-fixture",
        usage,
      });
    expect(new Set(providedRecords.map((record) => record.callId)).size).toBe(
      2,
    );
    expect(
      h.logs.filter(
        (record) => record.kind === "role" && record.taskId === "parallel",
      ),
    ).toEqual([
      expect.objectContaining({
        runId: h.runId,
        sessionId: missing.sessionId,
        usage: null,
        finish: "stop",
      }),
    ]);
  });

  it("admits dispatch and close atomically within the same tick", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "wait", gate }]);
    cleanups.push(async () => {
      gate.released.resolve();
    });
    const work = observe(h.dispatch("same-tick"));
    let closed = false;
    const closing = h.bridge.close().then(() => {
      closed = true;
    });
    await setImmediate();
    if (h.adapter.requests.length > 0) {
      const request = await gate.started.promise;
      expect(request.signal?.aborted).toBe(true);
      expect(closed).toBe(false);
    }
    gate.released.resolve();
    await Promise.all([work, closing]);
    expect(
      h.runs.view(h.operation).tasks.find((task) => task.taskId === "analysis")
        ?.status,
    ).not.toBe("running");
    expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
  });

  it("invalidates a same-tick role start during upstream redo without bypassing a digest drain", async () => {
    const gate = modelGate();
    const h = await host([], (request) => gatedDigest(request, gate));
    cleanups.push(async () => {
      gate.released.resolve();
    });
    fixedAnalysis(h);
    const digest = observe(
      h.bridge.makeDigest(h.operation, "digest", "waiting"),
    );
    await gate.started.promise;
    const dependent = observe(h.dispatch("dependent", "dependent"));
    const redo = h.bridge.redo(h.operation, "analysis", "redo-upstream");
    await gate.aborted.promise;
    await setImmediate();
    expect(
      h.runs
        .view(h.operation)
        .tasks.find((task) => task.taskId === "dependent"),
    ).toMatchObject({ status: "pending", attempt: 1 });
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "dependent", attempt: 1 })
        .status,
    ).toBe("invalidated");
    expect(h.adapter.requests).toHaveLength(0);
    gate.released.resolve();
    await Promise.all([digest, dependent, redo]);
    expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
  });
});

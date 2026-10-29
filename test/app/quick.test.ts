import fs from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  HarnessError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import type { CollectionRecord } from "../../src/contracts/collection.js";
import {
  attachCollection,
  readCollection,
} from "../../src/app/collection-input.js";
import {
  quickHost,
  initialInput,
  lastToolResult,
  lastToolText,
  toolCall,
} from "../fixtures/quick-host.js";
import { gate, textResponse } from "../fixtures/runtime-host.js";
import {
  workflowModel,
  isMainResearchRequest,
  mainResearchRequest,
} from "../fixtures/research-workflow.js";

const cleanups: (() => Promise<void>)[] = [];
function marketResponse() {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        sz002594: {
          day: [["2024-01-03", "190", "192", "193", "189", "100"]],
        },
      },
    }),
  );
}
const fetch = vi.fn<typeof globalThis.fetch>(async () => marketResponse());
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
  // Artificial contemporaneous capture: only Date is replaced; SDK timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:00:00.000Z"));
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
async function host(respond: Parameters<typeof quickHost>[0]) {
  const h = await quickHost(respond);
  cleanups.push(h.close);
  return h;
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}
describe("stock-quick real command boundary", () => {
  it("acknowledges collection immediately and keeps the task alive after the command request ends", async () => {
    const pause = gate<AbortSignal>();
    fetch.mockImplementationOnce(async (_url, init) => {
      pause.started.resolve(init!.signal!);
      await pause.released.promise;
      init!.signal!.throwIfAborted();
      return marketResponse();
    });
    const model = workflowModel();
    const h = await host(model.respond);
    cleanups.push(async () => pause.released.resolve());
    const request = new AbortController();
    const acknowledgement = await h.execute(undefined, request.signal);
    const collectionSignal = await pause.started.promise;
    const job = h.ctx.jobs.list(h.outside.agent.id)[0]!;
    expect(acknowledgement?.result).toMatchObject({
      kind: "success",
    });
    expect(job).toMatchObject({ status: "running", owner: h.outside.agent.id });
    expect(job.progress).toContain("采集");
    expect(h.created).toEqual([]);
    expect(h.adapter.requests[0]!.sessionId).toBe(h.outside.agent.id);
    expect(
      h.ctx.sessionProjections.stateOf(h.outside.agent.session, "turnBoundary")
        ?.lastTurn,
    ).toBe(1);
    request.abort(new DOMException("Browser request finished", "AbortError"));
    expect(collectionSignal.aborted).toBe(false);
    expect((await h.execute("/host-ping"))?.result).toEqual({
      kind: "success",
      text: "pong",
    });
    pause.released.resolve();
    const completed = await h.waitForResearch(acknowledgement);
    expect(completed?.result.kind).toBe("success");
    expect(completed?.result.text).toContain(model.state.runId);
    expect(h.ctx.jobs.get(job.id, h.outside.agent.id).status).toBe("completed");
  });

  it("preserves the main Agent's SDK error without starting hidden research work", async () => {
    const cause = new Error("Original provider diagnostic");
    const failure = new HarnessError(
      "Fixture coordinator rejected",
      "INVALID_INPUT",
      { cause },
    );
    const h = await host(async function* (): AsyncIterable<StreamChunk> {
      yield await Promise.reject(failure);
    });
    let sdkError: unknown;
    h.ctx.on("agent/error", ({ error }) => {
      sdkError = error;
    });
    const outcome = await h.executeAndWait();
    expect(outcome?.result).toMatchObject({
      kind: "error",
      text: expect.stringContaining("Fixture coordinator rejected"),
    });
    expect(sdkError).toMatchObject({
      code: "INVALID_INPUT",
      message: "Fixture coordinator rejected",
    });
    expect(h.ctx.jobs.list(h.outside.agent.id)).toEqual([]);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a role's completion prose when no canonical artifact was submitted", async () => {
    let coordinatorCalls = 0;
    let runId: string | undefined;
    const h = await host(async function* (request) {
      if (!isMainResearchRequest(request)) {
        yield* textResponse("分析已经完成，但未提交产物。");
        return;
      }
      if (++coordinatorCalls === 1)
        yield* toolCall("stock_start_research", {
          security: "SZ.002594",
          date: "2024-01-03",
          mode: "quick",
          requestId: "open",
        });
      else if (coordinatorCalls === 2) {
        runId = lastToolResult<{ runId: string }>(request).runId;
        yield* toolCall("stock_dispatch_task", {
          runId,
          taskId: "analysis.market",
          requestId: "market",
        });
      } else yield* textResponse("分析师执行结束，但研究尚未完成。");
    });
    const result = (await h.executeAndWait())?.result;
    expect(result?.kind).toBe("error");
    expect(result?.text).toContain(`运行 ${runId} 未完成。`);
    expect(result?.text).toContain("NO_ARTIFACT");
    const view = h.runtime.runs.view({ runId: runId! });
    expect(view.status).not.toBe("completed");
    expect(
      view.tasks.find((task) => task.taskId === "analysis.market"),
    ).toMatchObject({ status: "failed", outputRefs: [] });
    expect(
      view.tasks.find((task) => task.taskId === "digest.analysis")!.status,
    ).toBe("pending");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps canonical research incomplete when the main Agent only claims completion in prose", async () => {
    let calls = 0;
    let runId: string | undefined;
    const h = await host(async function* (request) {
      if (++calls === 1) {
        yield* toolCall("stock_start_research", {
          security: "SZ.002594",
          date: "2024-01-03",
          mode: "quick",
          requestId: "open",
        });
      } else {
        runId = lastToolResult<{ runId: string }>(request).runId;
        yield* textResponse("研究已完成。");
      }
    });
    expect((await h.executeAndWait())?.result).toMatchObject({
      kind: "error",
      text: expect.stringContaining("未完成"),
    });
    expect(h.runtime.runs.view({ runId: runId! })).toMatchObject({
      status: "active",
    });
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("completes all twelve DAG nodes from one saved capture and retains original source gaps", async () => {
    fetch.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2024-01-03T08:00:05.000Z"));
      return marketResponse();
    });
    const model = workflowModel();
    const h = await host(model.respond);
    const result = await h.executeAndWait();
    expect(result?.result.kind, result?.result.text).toBe("success");
    const view = h.runtime.runs.view({ runId: model.state.runId! });
    expect(model.state.taskIds).toHaveLength(12);
    expect(view.status).toBe("completed");
    const downstream = h.adapter.requests.filter(
      (request) =>
        request.tools?.some((tool) => tool.name === "stock_read_report") &&
        request.tools.some((tool) => tool.name === "stock_submit") &&
        !initialInput<{ task: { id: string } }>(request).task.id.startsWith(
          "analysis.",
        ) &&
        initialInput<{ task: { role: string } }>(request).task.role !==
          "digest",
    );
    expect(downstream.length).toBeGreaterThan(0);
    for (const request of downstream) {
      const input = initialInput<Record<string, unknown>>(request);
      expect(Object.keys(input).sort()).toEqual(["context", "scope", "task"]);
      const context = input.context as Record<string, unknown>;
      expect(context.referencePrice).toEqual({ value: 192, unit: "CNY/share" });
      expect(request.tools!.map((tool) => tool.name).sort()).toEqual([
        "stock_calculate_valuation",
        "stock_read_report",
        "stock_read_report_draft",
        "stock_read_valuation_calculation",
        "stock_read_valuation_method",
        "stock_submit",
        "stock_write_handoff",
        "stock_write_report",
      ]);
      for (const entry of context.reportCatalog as Record<string, unknown>[])
        expect(entry).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            role: expect.any(String),
            kind: expect.any(String),
            title: expect.any(String),
          }),
        );
      for (const entry of context.materials as Record<string, unknown>[]) {
        expect(entry).not.toHaveProperty("inputRefs");
        expect(entry).not.toHaveProperty("claims");
      }
    }
    expect(
      view.tasks.filter((task) => task.status === "succeeded"),
    ).toHaveLength(12);
    const report = view.tasks
      .find((task) => task.taskId === "finalize")!
      .outputRefs.map((ref) => h.runtime.runs.readArtifact(ref).content)
      .find((content) => content.kind === "report")!;
    expect(report.body).toContain("## 估值依据");
    expect(report.body).toContain("研究日价值区间：192 CNY/股 至 240 CNY/股");
    expect(report.body).toContain("六个月目标价依据");
    expect(report).toMatchObject({
      payload: {
        gaps: expect.arrayContaining([
          expect.objectContaining({
            kind: "source",
            gap: expect.objectContaining({ code: "unverified_time" }),
          }),
        ]),
      },
    });
    const market = h.runtime.runs.readArtifact(model.state.marketRef!).content;
    const close = market.claims[0]!;
    if (close.kind !== "observed")
      throw new Error("Expected actual market observation");
    const evidence = h.runtime.runs.readEvidence(close.source).envelope;
    expect(evidence.historicalKnowledge).toBe("unverified");
    expect(evidence.gaps).toContainEqual(
      expect.objectContaining({ code: "unverified_time", field: "/data/rows" }),
    );
    expect(evidence.retrievedAt <= evidence.cutoff).toBe(true);
    const collection = readCollection(h.runtime.runs, view.runId)!;
    expect(collection.packets).toHaveLength(1);
    expect(
      collection.packets[0]!.envelope.retrievedAt <= view.scope.cutoff,
    ).toBe(true);
    expect(collection.packets[0]!.envelope.cutoff).toBe(
      "2024-01-03T08:00:05.000Z",
    );
    expect(view.scope.cutoff).toBe("2024-01-03T08:00:05.000Z");
    expect(collection.packets[0]).toMatchObject({
      id: "market.daily",
      envelope: {
        dataset: "market",
        source: { provider: "tencent" },
        data: {
          table: "market.daily",
          interval: "1d",
          rows: [{ values: { close: 192 } }],
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(h.created).toHaveLength(8);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    for (const agent of h.created)
      expect(h.ctx.sessions.get(agent.id)).toBeUndefined();
  });

  it("returns manager validation feedback to the same Agent and completes after its corrected JSON submission", async () => {
    const model = workflowModel({ repairManager: true });
    const h = await host(model.respond);
    const result = await h.executeAndWait();
    expect(result?.result.kind, result?.result.text).toBe("success");
    expect(model.state.managerFeedback).toContain("reportDraft.targetPrice");
    const view = h.runtime.runs.view({ runId: model.state.runId! });
    expect(view.status).toBe("completed");
    expect(
      view.tasks.find((task) => task.taskId === "manager.decision"),
    ).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(view.tasks.every((task) => task.status === "succeeded")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["4", "5", "6"])(
    "continues legacy coordinator protocol %s in the current main chat",
    async (version) => {
      let received: unknown;
      let names: string[] = [];
      const h = await host(async function* (request) {
        received = mainResearchRequest(request);
        names = request.tools!.map(({ name }) => name);
        yield* textResponse("本次调度已停止。");
      });
      const scope = {
        security: {
          id: "CN:002594.SZ",
          market: "CN" as const,
          symbol: "002594.SZ",
          exchange: "SZ",
          currency: "CNY",
          timeZone: "Asia/Shanghai",
        },
        date: "2024-01-03",
        cutoff: "2024-01-03T08:00:00.000Z",
      };
      const input = createQuickInput(scope, h.runtime.policy, []);
      input.versions.prompts.coordinator = version;
      input.inputs.find(({ name }) => name === "prompt:coordinator")!.content =
        "按固定runId和tasks推进运行，结束时返回执行状态。";
      const { runId } = h.runtime.runs.open(
        h.outside.agent.id,
        input,
        `legacy-${version}`,
      );
      const result = await h.executeAndWait(
        `/stock-resume ${runId} {"resolvedReasonIds":[],"instructions":[]}`,
      );
      expect(result?.result.kind).toBe("error");
      expect(received).toMatchObject({
        kind: "resume",
        runId,
        view: expect.objectContaining({ scope }),
        tasks: expect.any(Array),
      });
      expect(received).not.toHaveProperty("context");
      expect(received).not.toHaveProperty("task");
      expect(names).not.toContain("stock_submit");
      expect(h.runtime.runs.view({ runId }).status).toBe("active");
    },
  );

  it("validates preparation arguments and replays one request while rejecting conflicting reuse", async () => {
    let call = 0;
    let runId: string | undefined;
    const results: unknown[] = [];
    const h = await host(async function* (request) {
      const selection = {
        security: "SZ.002594",
        date: "2024-01-03",
        mode: "quick",
      };
      if (++call > 1) results.push(lastToolText(request));
      if (call === 1)
        yield* toolCall("stock_start_research", {
          ...selection,
          security: "002594",
          requestId: "open",
        });
      else if (call === 2)
        yield* toolCall("stock_start_research", {
          ...selection,
          requestId: "open",
          provider: "tencent",
        });
      else if (call === 3 || call === 4)
        yield* toolCall("stock_start_research", {
          ...selection,
          requestId: "open",
        });
      else if (call === 5) {
        runId = lastToolResult<{ runId: string }>(request).runId;
        yield* toolCall("stock_start_research", {
          ...selection,
          security: "SH.600000",
          requestId: "open",
        });
      } else yield* textResponse("结束本次调度，研究仍未完成。");
    });
    const result = await h.executeAndWait();
    expect(result?.result.kind).toBe("error");
    expect(results[2]).toEqual(results[3]);
    expect(JSON.stringify(results[0])).toContain("INVALID_INPUT");
    expect(JSON.stringify(results[1])).toContain("INVALID_INPUT");
    expect(JSON.stringify(results[4])).toContain("REQUEST_CONFLICT");
    expect(h.runtime.runs.view({ runId: runId! })).toMatchObject({
      status: "active",
    });
    expect(
      h.runFiles().filter((path) => String(path).endsWith("manifest.json")),
    ).toHaveLength(1);
    expect(
      h.adapter.requests[0]!.tools!.map((tool) => tool.name).sort(),
    ).toEqual([
      "host_marker",
      "stock_cancel_research",
      "stock_recover_research",
      "stock_replay_research",
      "stock_resume_research",
      "stock_start_research",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "/stock-quick 002594 2024-01-03",
    "/stock-quick SZ.002594 2024-02-30",
    "/stock-quick SZ.002594 2024-01-03 extra",
  ])(
    "rejects invalid input without creating a run or model call: %s",
    async (line) => {
      const h = await host(() => textResponse("Unexpected model call"));
      const before = h.runFiles();
      await expect(h.executeAndWait(line)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(h.runFiles()).toEqual(before);
      expect(h.created).toEqual([]);
      expect(h.adapter.requests).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects missing required collection data before opening a run or spawning roles", async () => {
    fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const h = await host(workflowModel().respond);
    const before = h.runFiles();
    const result = (await h.executeAndWait())?.result;
    expect(result).toMatchObject({
      kind: "error",
      text: expect.stringContaining("DATA_INSUFFICIENT"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const records = fs.readdirSync(join(h.directory, "collections"));
    expect(records).toHaveLength(1);
    const recordPath = join(h.directory, "collections", records[0]!);
    expect(result!.text).toContain(recordPath);
    const record = JSON.parse(
      fs.readFileSync(recordPath, "utf8"),
    ) as CollectionRecord;
    expect(record.status).toBe("missing_required");
    expect(
      record.snapshot.diagnostics!.attempts.map(({ id, attempt, outcome }) => ({
        id,
        attempt,
        outcome,
      })),
    ).toEqual([
      { id: "market.daily", attempt: 1, outcome: "failed" },
      { id: "market.daily", attempt: 2, outcome: "failed" },
    ]);
    expect(h.runFiles()).toEqual(before);
    expect(h.created).toEqual([]);
    expect(h.adapter.requests[0]!.sessionId).toBe(h.outside.agent.id);
  });

  it("cancels and drains collection without opening a run or spawning roles", async () => {
    const pause = gate<void>();
    fetch.mockImplementationOnce(async (_url, init) => {
      const signal = init!.signal!;
      const aborted = () => pause.aborted.resolve();
      signal.addEventListener("abort", aborted, { once: true });
      pause.started.resolve();
      try {
        await pause.released.promise;
        signal.throwIfAborted();
        return marketResponse();
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    });
    const h = await host(workflowModel().respond);
    cleanups.push(async () => pause.released.resolve());
    const before = h.runFiles();
    const acknowledgement = await h.execute();
    const command = h.waitForResearch(acknowledgement);
    await pause.started.promise;
    const job = h.ctx.jobs.list(h.outside.agent.id)[0]!;
    h.ctx.jobs.kill(job.id, h.outside.agent.id, "Cancel collection");
    await pause.aborted.promise;
    pause.released.resolve();
    expect((await command)?.result).toMatchObject({
      kind: "error",
    });
    expect(h.ctx.jobs.get(job.id, h.outside.agent.id).status).toBe("killed");
    expect(h.runFiles()).toEqual(before);
    expect(h.created).toEqual([]);
    expect(h.adapter.requests[0]!.sessionId).toBe(h.outside.agent.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses unbound and ordinary host callers at the runtime open entry", async () => {
    const h = await host(() => textResponse("Unexpected model call"));
    const before = h.runFiles();
    const scope = {
      security: {
        id: "CN:002594.SZ",
        market: "CN" as const,
        symbol: "002594.SZ",
        exchange: "SZ" as const,
        currency: "CNY" as const,
        timeZone: "Asia/Shanghai" as const,
      },
      date: "2024-01-03",
      cutoff: "2024-01-03T15:59:59.999Z",
    };
    const input = createQuickInput(scope, h.runtime.policy, []);
    for (const agent of [undefined, h.outside.agent])
      expect(() =>
        h.runtime.openRun(agent, input, "unauthorized"),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    const ask = await h.runtime.createAgent(
      h.agentOptions("ask-cannot-open"),
      { kind: "ask", scope },
      [],
    );
    expect(() => h.runtime.openRun(ask.agent, input, "ask-open")).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    await ask.dispose();
    expect(h.runFiles()).toEqual(before);
  });

  it("stops research SDK turns without cancelling the invocation, retaining a resumable blocked run", async () => {
    const pause = gate<GenerateOptions>();
    const model = workflowModel({ pauseFundamentals: pause });
    const h = await host(model.respond);
    cleanups.push(async () => pause.released.resolve());
    const controller = new AbortController();
    const command = observe(h.executeAndWait(undefined, controller.signal));
    await pause.started.promise;
    for (const agent of h.ctx.agents.list())
      if (agent !== h.outside.agent) agent.cancel({ kind: "user" });
    await pause.aborted.promise;
    pause.released.resolve();
    await command;
    const view = h.runtime.runs.view({ runId: model.state.runId! });
    expect(controller.signal.aborted).toBe(false);
    expect(view.status).not.toBe("completed");
    expect(
      view.tasks.find((task) => task.taskId === "analysis.market"),
    ).toMatchObject({
      status: "succeeded",
      outputRefs: [model.state.marketRef],
    });
    expect(
      view.tasks.find((task) => task.taskId === "analysis.fundamentals")!
        .status,
    ).toBe("failed");
    expect(model.state.released).toBe(true);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("starts a new quick from a cancelled run's captures through stock-resume with no new source fetch", async () => {
    const pause = gate<GenerateOptions>();
    const original = workflowModel({ pauseFundamentals: pause });
    let current = original;
    const h = await host((request) => current.respond(request));
    cleanups.push(async () => pause.released.resolve());
    const controller = new AbortController();
    const command = observe(h.executeAndWait(undefined, controller.signal));
    await pause.started.promise;
    const cancelling = h.execute(`/stock-cancel ${original.state.runId}`);
    await pause.aborted.promise;
    pause.released.resolve();
    await cancelling;
    await command;
    const source = h.runtime.runs.view({ runId: original.state.runId! });
    expect(source.status).toBe("cancelled");
    const collection = readCollection(h.runtime.runs, source.runId)!;
    const fresh = attachCollection(
      createQuickInput(
        source.scope,
        h.runtime.policy,
        h.runtime.queries.health(source.scope).sources,
      ),
      collection,
    );
    const opened = h.runtime.runs.open(
      h.outside.agent.id,
      fresh,
      "captured-case",
    );
    current = workflowModel();
    const result = await h.executeAndWait(
      `/stock-resume ${opened.runId} {"resolvedReasonIds":[],"instructions":[]}`,
    );
    expect(result?.result.kind, result?.result.text).toBe("success");
    const view = h.runtime.runs.view({ runId: opened.runId });
    expect(view.scope).toEqual(source.scope);
    expect(view.tasks).toHaveLength(12);
    expect(
      view.tasks.every(
        (task) => task.status === "succeeded" && task.attempt === 1,
      ),
    ).toBe(true);
    expect(h.runtime.runs.view({ runId: source.runId })).toEqual(source);
    expect(readCollection(h.runtime.runs, opened.runId)).toEqual(collection);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["cancel", "native-cancel", "unload"] as const)(
    "%s writes cancelled before draining the real role and preserves committed analysis",
    async (action) => {
      const pause = gate<GenerateOptions>();
      const model = workflowModel({ pauseFundamentals: pause });
      const h = await host(model.respond);
      cleanups.push(async () => pause.released.resolve());
      const controller = new AbortController();
      const command = observe(h.executeAndWait(undefined, controller.signal));
      await pause.started.promise;
      let unloaded = false;
      const unloading =
        action === "unload"
          ? h.quickFiber.dispose().then(() => {
              unloaded = true;
            })
          : undefined;
      const cancelling =
        action === "cancel"
          ? h.execute(`/stock-cancel ${model.state.runId}`)
          : undefined;
      const nativeJob =
        action === "native-cancel"
          ? h.ctx.jobs
              .list(h.outside.agent.id)
              .find(({ kind }) => kind === "stock-research")!
          : undefined;
      if (nativeJob !== undefined) {
        expect(nativeJob.status).toBe("running");
        h.ctx.jobs.kill(nativeJob.id, h.outside.agent.id);
      }
      await pause.aborted.promise;
      expect(h.runtime.runs.view({ runId: model.state.runId! }).status).toBe(
        "cancelled",
      );
      await setImmediate();
      expect(model.state.released).toBe(false);
      if (action === "unload") expect(unloaded).toBe(false);
      expect(model.state.taskIds).toEqual([
        "analysis.market",
        "analysis.fundamentals",
      ]);
      expect(
        h.runtime.runs.readArtifact(model.state.marketRef!).content.kind,
      ).toBe("analysis");
      pause.released.resolve();
      await command;
      await cancelling;
      await unloading;
      if (nativeJob !== undefined)
        expect(
          (await h.ctx.jobs.wait(nativeJob.id, 1000, h.outside.agent.id))
            .status,
        ).toBe("killed");
      expect(model.state.released).toBe(true);
      await h.quickFiber.dispose();
      expect(
        h.ctx.commands.find(h.outside.agent, "stock-quick"),
      ).toBeUndefined();
      expect(
        (
          await h.ctx.commands.execute(
            h.outside.agent,
            "/host-ping",
            [],
            new AbortController().signal,
          )
        )?.result,
      ).toEqual({ kind: "success", text: "pong" });
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
      expect(h.ctx.get("stockResearch")).toBeDefined();
    },
  );
});

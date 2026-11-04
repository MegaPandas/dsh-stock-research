import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../fixtures/tool-execution.js";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type { ResearchObservationView } from "../../src/app/research-view.js";
import type { RunView } from "../../src/contracts/runs.js";
import type {
  ArtifactPayloads,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import { NumberService } from "../../src/services/numbers/index.js";
import { readCollection } from "../../src/app/collection-input.js";
import { quickHost, initialInput } from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
  type RoleInput,
} from "../fixtures/research-workflow.js";
import { deferred, gate } from "../fixtures/runtime-host.js";

const cutoff = "2024-01-03T08:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(cutoff));
});
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
function response(url: URL) {
  if (url.hostname === "web.ifzq.gtimg.cn") {
    const [symbol, period] = url.searchParams.get("param")!.split(",");
    const dates: Record<string, string> = {
      day: "2024-01-03",
      week: "2023-12-29",
      month: "2023-12-01",
    };
    return {
      code: 0,
      data: {
        [symbol!]: {
          [period!]: [[dates[period!], "190", "192", "193", "189", "100"]],
        },
      },
    };
  }
  if (url.hostname === "data.mofcom.gov.cn")
    return [{ date: "202312", tiosfs: 100 }];
  if (
    ["datacenter-web.eastmoney.com", "datacenter.eastmoney.com"].includes(
      url.hostname,
    )
  ) {
    const values = Object.fromEntries(
      (url.searchParams.get("columns") ?? "")
        .split(",")
        .filter(Boolean)
        .map((name) => [name, 100]),
    );
    const financial = url.pathname.startsWith("/securities/");
    return {
      code: 0,
      success: true,
      result: {
        pages: 1,
        data: [
          {
            ...values,
            REPORT_DATE: financial ? "2023-09-30 00:00:00" : "2023-12-01",
            TRADE_DATE: "2023-12-29",
            ...(financial
              ? {
                  SECUCODE: "002594.SZ",
                  NOTICE_DATE: "2023-10-30 00:00:00",
                  CURRENCY: "CNY",
                  TOTALOPERATEREVE: 100,
                  PARENTNETPROFIT: 100,
                  BPS: 100,
                }
              : {}),
          },
        ],
      },
    };
  }
  throw new Error(`Unexpected collection test URL ${url.href}`);
}
async function setup(options: { financials?: boolean; late?: boolean } = {}) {
  const macro = gate<AbortSignal>();
  let held = false;
  let activeFetch = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    activeFetch++;
    try {
      if (options.late && url.hostname !== "web.ifzq.gtimg.cn")
        vi.setSystemTime(new Date("2024-01-03T08:05:00.000Z"));
      if (!held && url.hostname === "datacenter-web.eastmoney.com") {
        held = true;
        const signal = init!.signal!;
        const abort = () => macro.aborted.resolve();
        signal.addEventListener("abort", abort, { once: true });
        macro.started.resolve(signal);
        try {
          await macro.released.promise;
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      return Response.json(response(url));
    } finally {
      activeFetch--;
    }
  });
  vi.stubGlobal("fetch", fetch);
  const model = workflowModel();
  const roles: RoleInput[] = [];
  const marketStarted = deferred<RoleInput>();
  const seen = new Set<string>();
  const h = await quickHost(
    async function* (request) {
      if (
        !isMainResearchRequest(request) &&
        !seen.has(String(request.sessionId))
      ) {
        seen.add(String(request.sessionId));
        const input = initialInput<RoleInput>(request);
        roles.push(input);
        if (input.task.id === "analysis.market") marketStarted.resolve(input);
      }
      yield* model.respond(request);
    },
    undefined,
    {
      enabledSources: [
        "tencent",
        "china-macro",
        ...(options.financials ? ["eastmoney-income" as const] : []),
      ],
      http: { timeoutMs: 60_000, maxConcurrency: 1, minIntervalMs: 0 },
      policy: {
        freshness: {
          market: 31_536_000_000,
          fundamentals: 31_536_000_000,
          macro: 31_536_000_000,
        },
        secCiks: {},
      },
    },
  );
  cleanups.push(h.close);
  cleanups.push(async () => macro.released.resolve());
  let call = 0;
  const tool = (name: string, args: unknown) =>
    executeTool(h.ctx.tools, {
      agent: h.outside.agent,
      name,
      arguments: args,
      callId: ToolCallId(`parallel-${++call}`),
      signal: new AbortController().signal,
    });
  const rootJob = () =>
    h.ctx.jobs
      .list(h.outside.agent.id)
      .find(({ kind }) => kind === "stock-research")!;
  async function observation() {
    const result = await tool("stock_read_research", { jobId: rootJob().id });
    expect(result.isError).toBe(false);
    return result.value as unknown as ResearchObservationView;
  }
  async function waitView(runId: string, accept: (view: RunView) => boolean) {
    const view = () => h.runtime.runs.view({ runId });
    if (accept(view())) return view();
    await new Promise<void>((resolve) => {
      const release = h.runtime.runs.subscribe(runId, () =>
        queueMicrotask(() => {
          if (accept(view())) {
            release();
            resolve();
          }
        }),
      );
      cleanups.push(async () => release());
    });
    return view();
  }
  return {
    h,
    model,
    macro,
    roles,
    marketStarted,
    fetch,
    rootJob,
    tool,
    observation,
    waitView,
    activeFetch: () => activeFetch,
  };
}
const task = (view: RunView, id: string) =>
  view.tasks.find(({ taskId }) => taskId === id)!;

describe("application collection branches", () => {
  it.each(["quick", "deep"] as const)(
    "starts %s market analysis while macro collection is held and keeps collection artifacts out of business presentation",
    async (mode) => {
      const f = await setup();
      const ack = await f.h.execute(`/stock-${mode} SZ.002594 2024-01-03`);
      await f.macro.started.promise;
      await f.marketStarted.promise;
      const { runId } = await f.observation();
      const view = await f.waitView(
        runId!,
        (view) => task(view, "analysis.market").status === "succeeded",
      );
      expect(view.scope.cutoff).toBe(cutoff);
      expect(task(view, "data.macro").status).toBe("running");
      expect(task(view, "analysis.macro").status).toBe("pending");
      expect(f.roles.some(({ task: { id } }) => id === "analysis.macro")).toBe(
        false,
      );
      const marketRefs = task(view, "data.market").outputRefs;
      expect(marketRefs).toHaveLength(1);
      expect(
        f.h.runtime.runs.readAttempt({
          runId: runId!,
          taskId: "analysis.market",
          attempt: 1,
        }).inputRefs,
      ).toEqual(marketRefs);
      f.macro.released.resolve();
      expect((await f.h.waitForResearch(ack))?.result.kind).toBe("success");
      const final = f.h.runtime.runs.view({ runId: runId! });
      expect(final.tasks).toHaveLength(mode === "quick" ? 15 : 25);
      expect(final.tasks.every(({ status }) => status === "succeeded")).toBe(
        true,
      );
      for (const input of f.roles) {
        expect(
          input.context.reportCatalog.some(({ kind }) => kind === "collection"),
        ).toBe(false);
        if (input.task.id.startsWith("analysis.")) {
          expect(input.context.materials).toEqual([]);
          expect(input.context.reportCatalog).toEqual([]);
        }
        if (input.task.id === "manager.decision")
          expect(input.context.materials).toHaveLength(1);
        for (const material of input.context.materials)
          expect((material as { title: string }).title).not.toMatch(
            /^固定数据：/,
          );
      }
      const report = task(final, "finalize")
        .outputRefs.map((ref) => f.h.runtime.runs.readArtifact(ref).content)
        .find(({ kind }) => kind === "report")!;
      const payload = report.payload as ArtifactPayloads["report"];
      expect(
        payload.sections.every(
          (ref) =>
            f.h.runtime.runs.readArtifact(ref).content.kind !== "collection",
        ),
      ).toBe(true);
      for (const id of ["data.market", "data.fundamentals", "data.macro"])
        for (const ref of task(final, id).outputRefs)
          expect(report.inputRefs).toContainEqual(ref);
      expect(f.activeFetch()).toBe(0);
      expect(f.h.ctx.agents.list()).toEqual([f.h.outside.agent]);
    },
  );

  it("cancels one data branch before draining its source and replays the old control without cancelling a redone attempt", async () => {
    const f = await setup();
    await f.h.execute();
    await f.macro.started.promise;
    const { runId } = await f.observation();
    const request = {
      runId,
      taskId: "data.macro",
      expectedAttempt: 1,
      reason: "Stop only macro",
      requestId: "stop-macro",
    };
    let returned = false;
    const cancelling = f.tool("stock_cancel_task", request).then((result) => {
      returned = true;
      return result;
    });
    await f.macro.aborted.promise;
    const view = await f.waitView(
      runId!,
      (view) =>
        task(view, "analysis.market").status === "succeeded" &&
        task(view, "analysis.fundamentals").status === "succeeded",
    );
    expect(task(view, "data.macro").status).toBe("cancelled");
    expect(task(view, "analysis.macro").status).toBe("cancelled");
    expect(task(view, "digest.analysis").status).toBe("cancelled");
    expect(task(view, "manager.decision").status).toBe("cancelled");
    const marketRefs = task(view, "analysis.market").outputRefs;
    const fundamentalRefs = task(view, "analysis.fundamentals").outputRefs;
    expect(marketRefs.length).toBeGreaterThan(0);
    expect(fundamentalRefs.length).toBeGreaterThan(0);
    expect(returned).toBe(false);
    f.macro.released.resolve();
    const cancelled = await cancelling;
    expect(cancelled.isError).toBe(false);
    const redo = await f.tool("stock_redo_task", {
      runId,
      taskId: "data.macro",
      reason: "Resume macro",
      requestId: "redo-macro",
    });
    expect(redo.isError).toBe(false);
    await f.waitView(
      runId!,
      (view) =>
        task(view, "data.macro").attempt === 2 &&
        task(view, "data.macro").status === "succeeded",
    );
    expect(await f.tool("stock_cancel_task", request)).toEqual(cancelled);
    expect((await f.h.waitForResearchCompletion()).kind).toBe("success");
    expect(
      task(f.h.runtime.runs.view({ runId: runId! }), "data.macro"),
    ).toMatchObject({ attempt: 2, status: "succeeded" });
    const final = f.h.runtime.runs.view({ runId: runId! });
    expect(task(final, "analysis.market")).toMatchObject({
      attempt: 1,
      outputRefs: marketRefs,
    });
    expect(task(final, "analysis.fundamentals")).toMatchObject({
      attempt: 1,
      outputRefs: fundamentalRefs,
    });
    expect(f.activeFetch()).toBe(0);
  });

  it("publishes whole-run cancellation while the noncooperative data source still owns the running Job", async () => {
    const f = await setup();
    await f.h.execute();
    await f.macro.started.promise;
    const { runId } = await f.observation();
    const job = f.rootJob();
    let returned = false;
    const cancelling = f
      .tool("stock_cancel_research", { jobId: job.id, requestId: "stop-all" })
      .then((result) => {
        returned = true;
        return result;
      });
    await f.macro.aborted.promise;
    expect(f.h.runtime.runs.view({ runId: runId! }).status).toBe("cancelled");
    expect(["running", "stopping"]).toContain(
      f.h.ctx.jobs.get(job.id, f.h.outside.agent.id).status,
    );
    expect(returned).toBe(false);
    expect(f.activeFetch()).toBeGreaterThan(0);
    f.macro.released.resolve();
    expect((await cancelling).isError).toBe(false);
    expect(
      (await f.h.ctx.jobs.wait(job.id, 1000, f.h.outside.agent.id)).status,
    ).toBe("killed");
    await f.h.outside.agent.whenIdle();
    expect(f.activeFetch()).toBe(0);
    expect(f.h.ctx.agents.list()).toEqual([f.h.outside.agent]);
  });

  it("replays the completed fixed data artifacts offline through the real command", async () => {
    const f = await setup();
    const ack = await f.h.execute();
    await f.macro.started.promise;
    f.macro.released.resolve();
    expect((await f.h.waitForResearch(ack))?.result.kind).toBe("success");
    const before = f.h.runtime.runs.view({ runId: f.model.state.runId! });
    const evidenceTimes = (runId: string) =>
      f.h.runtime.runs
        .numberContext(runId)
        .evidence.map((entry) => ({
          taskId: entry.taskId,
          callId: entry.callId,
          snapshotAt: f.h.runtime.runs.readEvidence({
            runId,
            evidenceId: entry.evidenceId,
          }).snapshotAt,
        }))
        .sort((a, b) =>
          `${a.taskId}:${a.callId}`.localeCompare(`${b.taskId}:${b.callId}`),
        );
    const originalTimes = evidenceTimes(before.runId);
    expect(originalTimes.length).toBeGreaterThan(0);
    expect(originalTimes.every(({ snapshotAt }) => snapshotAt === cutoff)).toBe(
      true,
    );
    const calls = f.fetch.mock.calls.length;
    vi.setSystemTime(new Date("2024-01-04T08:00:00.000Z"));
    f.fetch.mockImplementation(async () => {
      throw new Error("Offline replay must not fetch");
    });
    expect(
      (await f.h.executeAndWait(`/stock-replay ${before.runId}`))?.result.kind,
    ).toBe("success");
    const after = f.h.runtime.runs.view({ runId: f.model.state.runId! });
    expect(after.runId).not.toBe(before.runId);
    expect(after.scope).toEqual(before.scope);
    expect(
      after.tasks.every(
        ({ status, attempt }) => status === "succeeded" && attempt === 1,
      ),
    ).toBe(true);
    for (const id of ["data.market", "data.fundamentals", "data.macro"]) {
      const old = task(before, id).outputRefs[0]!;
      const next = task(after, id).outputRefs[0]!;
      expect(next).not.toEqual(old);
      const original = f.h.runtime.runs.readArtifact(old).content
        .payload as ArtifactPayloads["collection"];
      expect(f.h.runtime.runs.readArtifact(next).content.payload).toEqual({
        capturedFrom: old,
        capturedAt: original.capturedAt,
        snapshot: original.snapshot,
      });
    }
    expect(evidenceTimes(after.runId)).toEqual(originalTimes);
    expect(f.h.runtime.runs.view({ runId: before.runId })).toEqual(before);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it("freezes late node snapshots without moving the observation cutoff or verifying historical versions", async () => {
    const f = await setup({ late: true, financials: true });
    const ack = await f.h.execute();
    await f.macro.started.promise;
    const { runId } = await f.observation();
    expect(f.h.runtime.runs.view({ runId: runId! }).scope.cutoff).toBe(cutoff);
    expect(readCollection(f.h.runtime.runs, runId!)!.scope.cutoff).toBe(cutoff);
    f.macro.released.resolve();
    expect((await f.h.waitForResearch(ack))?.result.kind).toBe("success");
    const final = f.h.runtime.runs.view({ runId: runId! });
    const financialRef = task(final, "data.fundamentals").outputRefs[0]!;
    const financial = f.h.runtime.runs.readArtifact(financialRef).content
      .payload as ArtifactPayloads["collection"];
    const income = financial.snapshot.packets.find(
      ({ id }) => id === "financial.income",
    );
    expect(income).toBeDefined();
    expect(income!.envelope.data.rows.length).toBeGreaterThan(0);
    const evidenceRecords = f.h.runtime.runs
      .numberContext(runId!)
      .evidence.map(({ evidenceId }) =>
        f.h.runtime.runs.readEvidence<CollectedTableData>({
          runId: runId!,
          evidenceId,
        }),
      );
    const evidence = evidenceRecords.find(
      ({ envelope }) => envelope.data.table === "macro.gdp",
    )!;
    const financialEvidence = evidenceRecords.find(
      ({ envelope }) => envelope.data.table === "financial.income",
    )!;
    const macroRef = task(final, "data.macro").outputRefs[0]!;
    const macro = f.h.runtime.runs.readArtifact(macroRef).content
      .payload as ArtifactPayloads["collection"];
    for (const [record, capturedAt] of [
      [evidence, macro.capturedAt],
      [financialEvidence, financial.capturedAt],
    ] as const) {
      expect(record.envelope.retrievedAt > cutoff).toBe(true);
      expect(record.snapshotAt).toBe(capturedAt);
      expect(record.snapshotAt! >= record.envelope.retrievedAt).toBe(true);
      expect(record.envelope.cutoff).toBe(cutoff);
      expect(record.envelope.historicalKnowledge).toBe("unverified");
      expect(record.envelope.gaps).toContainEqual(
        expect.objectContaining({ code: "unverified_time" }),
      );
    }
    const macroPacket = macro.snapshot.packets.find(
      ({ id }) => id === "macro.gdp",
    )!;
    expect(evidence.envelope.gaps).toEqual(
      expect.arrayContaining(macroPacket.envelope.gaps),
    );
    expect(financialEvidence.envelope.gaps).toEqual(
      expect.arrayContaining(income!.envelope.gaps),
    );
    const report = task(final, "finalize")
      .outputRefs.map((ref) => f.h.runtime.runs.readArtifact(ref).content)
      .find(({ kind }) => kind === "report")!;
    for (const id of ["data.market", "data.fundamentals", "data.macro"]) {
      const payload = f.h.runtime.runs.readArtifact(
        task(final, id).outputRefs[0]!,
      ).content.payload as ArtifactPayloads["collection"];
      expect(report.body).toContain(payload.capturedAt);
    }
    const content: ResearchArtifactInput = {
      kind: "analysis",
      title: "Late observation",
      body: "{{number:late}}",
      inputRefs: [],
      claims: [
        {
          id: "late",
          kind: "observed",
          value: 100,
          unit: "CNY_100m",
          source: {
            runId: runId!,
            evidenceId: evidence.evidenceId,
            selector: "/data/rows/0/values/DOMESTICL_PRODUCT_BASE",
          },
        },
      ],
      payload: { findings: [], risks: [], gaps: [] },
    };
    const financialContent = structuredClone(content);
    financialContent.claims = [
      {
        id: "late",
        kind: "observed",
        value: 100,
        unit: "CNY",
        source: {
          runId: runId!,
          evidenceId: financialEvidence.evidenceId,
          selector: "/data/rows/0/values/TOTAL_OPERATE_INCOME",
        },
      },
    ];
    const checked = new NumberService(f.h.runtime.runs).checkNumbersBatch(
      { runId: runId!, identity: f.h.outside.agent.id },
      [
        { kind: "pending", contentId: "late-macro", content },
        {
          kind: "pending",
          contentId: "late-financial",
          content: financialContent,
        },
      ],
    );
    for (const result of checked) {
      expect(result.passed).toBe(true);
      expect(result.claims[0]!.warnings).toContainEqual(
        expect.objectContaining({
          code: "source_gap",
          gap: expect.objectContaining({ code: "unverified_time" }),
        }),
      );
    }
    expect(f.h.runtime.runs.view({ runId: runId! }).scope.cutoff).toBe(cutoff);
  });
});

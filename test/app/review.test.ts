import fs from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Review from "../../src/review.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import { researchTask } from "../../src/app/research-plan.js";
import type {
  PriceReturnsQuery,
  QueryResponse,
} from "../../src/contracts/query.js";
import {
  initialInput,
  lastToolResult,
  lastToolText,
  quickHost,
  toolCall,
} from "../fixtures/quick-host.js";
import { workflowModel } from "../fixtures/research-workflow.js";
import { gate, textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
function marketResponse(close = 192) {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        sz002594: {
          day: [
            [
              "2024-01-03",
              "190",
              String(close),
              String(close + 1),
              "189",
              "100",
            ],
          ],
        },
      },
    }),
  );
}
const fetch = vi.fn<typeof globalThis.fetch>(async () => marketResponse());
beforeEach(() => {
  fetch.mockReset();
  fetch.mockImplementation(async () => marketResponse());
  vi.stubGlobal("fetch", fetch);
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
const report = {
  summary: "产品交付改善，原研究的交付假设得到支持。",
  content: {
    comparisons: [
      {
        original: "交付增长将支持规模效应。",
        observed: "后续交付量增长。",
        implication: "保持观察增长向利润的传导。",
      },
    ],
    lessons: ["结合交付与利润观察规模效应。"],
    followUp: ["跟踪下一季度单位利润。"],
  },
};
function reviewRequest(request: GenerateOptions) {
  return (
    request.tools?.some((tool) => tool.name === "stock_select_review") === true
  );
}
async function host(respond: Parameters<typeof quickHost>[0]) {
  const workflow = workflowModel();
  const h = await quickHost((request) =>
    reviewRequest(request) ? respond(request) : workflow.respond(request),
  );
  cleanups.push(h.close);
  const original = await h.executeAndWait();
  expect(original?.result.kind).toBe("success");
  const runId = workflow.state.runId!;
  vi.setSystemTime(new Date("2024-01-04T08:00:00.000Z"));
  const fiber = h.ctx.plugin(Review, {
    provider: "runtime-fixture",
    model: "review",
  });
  await fiber;
  const createdBefore = h.created.length;
  const requestsBefore = h.adapter.requests.length;
  // runFiles includes directories; compare only immutable files and the manifest.
  const snapshot = () =>
    Object.fromEntries(
      h
        .runFiles()
        .filter((path) => fs.statSync(join(h.directory, "runs", path)).isFile())
        .map((path) => [
          path,
          fs.readFileSync(join(h.directory, "runs", path), "utf8"),
        ]),
    );
  const before = snapshot();
  const scope: ResearchScope = {
    security: {
      id: "CN:002594.SZ",
      market: "CN",
      symbol: "002594.SZ",
      exchange: "SZ",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
    date: "2024-01-04",
    cutoff: "2024-01-04T08:00:00.000Z",
  };
  const memories = () =>
    h.runtime.memory.recall(scope, { runId, text: null, limit: 10 });
  return {
    ...h,
    workflow,
    fiber,
    runId,
    createdBefore,
    requestsBefore,
    snapshot,
    before,
    memories,
    scope,
    executeReview: (signal = new AbortController().signal) =>
      h.execute(`/stock-review ${runId} 2024-01-04 请复核原研究条件`, signal),
  };
}

describe("stock-review through real commands, storage and AgentLoop", () => {
  it("repairs an invalid submission in the same Agent and saves one independent memory", async () => {
    let calls = 0;
    let feedback = "";
    const h = await host(async function* (request): AsyncIterable<StreamChunk> {
      if (++calls === 1) {
        yield* toolCall("stock_submit", { ...report, summary: "" });
        return;
      }
      if (calls !== 2)
        throw new Error("Successful submission must conclude the review turn");
      feedback = lastToolText(request);
      yield* toolCall("stock_submit", report, "corrected-review");
    });
    const result = await h.executeReview();
    expect(result?.result).toMatchObject({
      kind: "success",
      text: expect.stringContaining(report.summary),
    });
    expect(result?.result).toMatchObject({
      text: expect.stringContaining(report.content.comparisons[0]!.observed),
    });
    expect(feedback).toContain("summary");
    expect(calls).toBe(2);
    const memories = h.memories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toMatchObject({
      runId: h.runId,
      securityId: h.scope.security.id,
      outcome: report.summary,
      returns: {
        kind: "unavailable",
        gaps: [
          { code: "missing", field: "returns", detail: "本次复盘未查询收益。" },
        ],
      },
    });
    expect(memories[0]!.content.note).toContain(report.content.lessons[0]);
    expect(memories[0]!.content.note).not.toContain(report.summary);
    expect(memories[0]!.content.evidence).toEqual(
      h.runtime.runs
        .numberContext(h.runId)
        .artifacts.filter(
          ({ kind }) => kind === "decision" || kind === "report",
        )
        .map(({ ref }) => ref),
    );
    expect(h.snapshot()).toEqual(h.before);
    const agents = h.created.slice(h.createdBefore);
    expect(agents).toHaveLength(1);
    const requests = h.adapter.requests.slice(h.requestsBefore);
    expect(
      requests.every((request) => request.sessionId === agents[0]!.id),
    ).toBe(true);
    expect(requests[0]!.tools!.map((tool) => tool.name).sort()).toEqual(
      [
        "stock_read_report",
        "stock_data_health",
        "stock_recall",
        "stock_get_returns",
        "stock_select_review",
        "stock_submit",
      ].sort(),
    );
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.ctx.sessions.get(agents[0]!.id)).toBeUndefined();
    expect(h.outside.agent.inbox.nextStep).toEqual([]);
    expect(h.outside.agent.inbox.nextTurn).toEqual([]);
  });

  it("provides the original reference price alongside the normalized decision report without new queries", async () => {
    let calls = 0;
    let input:
      | {
          context: {
            referencePrice: { value: number; unit: string } | null;
            originalScope: ResearchScope;
            reportCatalog: { id: string; kind: string }[];
          };
        }
      | undefined;
    let decision: unknown;
    const h = await host(async function* (request) {
      if (++calls === 1) {
        input = initialInput(request);
        const entry = input!.context.reportCatalog.find(
          ({ kind }) => kind === "decision",
        )!;
        yield* toolCall("stock_read_report", { id: entry.id });
      } else {
        decision = lastToolResult(request);
        yield* toolCall("stock_submit", report);
      }
    });
    const requestsBefore = fetch.mock.calls.length;
    expect((await h.executeReview())?.result.kind).toBe("success");
    expect(input!.context.referencePrice).toEqual({
      value: 192,
      unit: "CNY/share",
    });
    expect(input!.context.originalScope.date).toBe("2024-01-03");
    expect(decision).toMatchObject({
      summary: "产品组合改善支持买入判断。",
      content: { thesis: ["产品组合改善带动盈利。"] },
      decision: {
        rating: "buy",
        horizonEndDate: "2024-07-03",
        ratingPolicy: "absolute-price-6m/1",
      },
    });
    expect(decision).not.toHaveProperty("inputRefs");
    expect(decision).not.toHaveProperty("payload");
    expect(decision).not.toHaveProperty("content.basePrice");
    expect(decision).not.toHaveProperty("content.rating");
    expect(decision).not.toHaveProperty("content.horizonEndDate");
    expect(fetch.mock.calls.length).toBe(requestsBefore);
    expect(h.snapshot()).toEqual(h.before);
  });

  it.each([180, null])(
    "provides the committed decision draft reference price %s when no final decision exists",
    async (basePrice) => {
      let received: unknown;
      const h = await host(async function* (request) {
        received = initialInput(request);
        yield* toolCall("stock_submit", report);
      });
      const original = h.runtime.runs
        .numberContext(h.runId)
        .artifacts.find(({ kind }) => kind === "decision_draft")!;
      const draft = structuredClone(
        h.runtime.runs.readArtifact(original.ref).content,
      ) as Extract<ResearchArtifactInput, { kind: "decision_draft" }>;
      draft.inputRefs = [];
      draft.claims =
        basePrice === null
          ? []
          : [
              {
                id: "fixture.base",
                kind: "estimated",
                value: basePrice,
                unit: "CNY/share",
                method: "人工固定基准。",
                assumptions: ["人工测试价格。"],
                evidence: [],
              },
            ];
      draft.payload.basePrice =
        basePrice === null ? null : { kind: "local", claimId: "fixture.base" };
      const scope = h.runtime.runs.readDefinition(h.runId).scope;
      const { runId } = h.runtime.runs.open(
        "fixture",
        {
          definition: {
            scope,
            mode: "quick",
            tasks: [
              researchTask(
                "manager.decision",
                { kind: "role", role: "manager", specialty: "decision" },
                [],
                ["decision_draft"],
              ),
            ],
          },
          versions: h.runtime.runs.inputCatalog(h.runId).versions,
          inputs: [],
        },
        `draft-${basePrice}`,
      );
      const claim = h.runtime.runs.claim(
        { runId, identity: "fixture" },
        "manager.decision",
        "claim",
      );
      h.runtime.runs.commitArtifact(
        { ...claim, identity: "fixture", sessionId: null },
        [draft],
        "draft",
      );
      const before = h.snapshot();
      const requestsBefore = fetch.mock.calls.length;
      expect(
        (await h.execute(`/stock-review ${runId} 2024-01-04 复核已提交决策稿`))
          ?.result.kind,
      ).toBe("success");
      expect(received).toMatchObject({
        context: {
          runId,
          originalScope: scope,
          referencePrice:
            basePrice === null ? null : { value: 180, unit: "CNY/share" },
        },
      });
      expect(fetch.mock.calls.length).toBe(requestsBefore);
      expect(h.snapshot()).toEqual(before);
    },
  );

  it("reuses the explicit scoped returns response even with a zero cache TTL", async () => {
    const query = {
      provider: "tencent",
      historyStartDate: "2024-01-03",
      startDate: "2024-01-03",
      endDate: "2024-01-04",
    };
    let calls = 0;
    let response: QueryResponse<PriceReturnsQuery> | undefined;
    let input: unknown;
    const h = await host(async function* (request) {
      if (++calls === 1) {
        input = initialInput(request);
        yield* toolCall("stock_get_returns", query);
        return;
      }
      if (calls !== 2)
        throw new Error("Successful submission must conclude the review turn");
      response = lastToolResult<{ envelope: QueryResponse<PriceReturnsQuery> }>(
        request,
      ).envelope;
      yield* toolCall("stock_submit", report);
    });
    const requestsBefore = fetch.mock.calls.length;
    expect((await h.executeReview())?.result.kind).toBe("success");
    expect(fetch.mock.calls.length - requestsBefore).toBe(1);
    expect(input).toMatchObject({
      scope: h.scope,
      task: { role: "review", objective: "请复核原研究条件" },
      context: { runId: h.runId },
    });
    const entry = h.memories()[0]!.content;
    expect(entry.recordedAt).toBe("2024-01-04T08:00:00.000Z");
    expect(entry.returns.kind).toBe("recorded");
    if (entry.returns.kind !== "recorded")
      throw new Error("Expected captured returns");
    expect(entry.returns.snapshot.scope).toEqual(h.scope);
    expect(entry.returns.snapshot.request).toEqual({
      dataset: "returns",
      provider: "tencent",
      parameters: {
        historyStartDate: query.historyStartDate,
        startDate: query.startDate,
        endDate: query.endDate,
        maxAgeMs: 86_400_000,
        comparable: false,
      },
    });
    const recordedData = Object.fromEntries(
      Object.entries(response!.data).filter(([field]) => field !== "market"),
    );
    const recordedEnvelope = Object.fromEntries(
      Object.entries(response!).filter(
        ([field]) => field !== "candidateClaims",
      ),
    );
    expect(entry.returns.snapshot.envelope).toEqual({
      ...recordedEnvelope,
      data: recordedData,
    });
    expect(entry.returns.snapshot.envelope.data).toMatchObject({
      comparable: false,
      value: null,
    });
    expect(entry.returns.snapshot.envelope.gaps.length).toBeGreaterThan(0);
    expect(h.snapshot()).toEqual(h.before);
  });

  it.each(["same request", "changed dates"] as const)(
    "captures the latest explicit returns update for %s without querying on save",
    async (update) => {
      const firstQuery = {
        provider: "tencent",
        historyStartDate: "2024-01-03",
        startDate: "2024-01-03",
        endDate: "2024-01-04",
      };
      const updatedQuery = {
        ...firstQuery,
        endDate: update === "changed dates" ? "2024-01-03" : "2024-01-04",
      };
      let calls = 0;
      const responses: QueryResponse<PriceReturnsQuery>[] = [];
      const h = await host(async function* (request) {
        if (++calls === 1) {
          yield* toolCall("stock_get_returns", firstQuery);
          return;
        }
        responses.push(
          lastToolResult<{ envelope: QueryResponse<PriceReturnsQuery> }>(
            request,
          ).envelope,
        );
        if (calls === 2)
          yield* toolCall("stock_get_returns", updatedQuery, "updated-returns");
        else if (calls === 3) yield* toolCall("stock_submit", report);
        else
          throw new Error(
            "Successful submission must conclude the review turn",
          );
      });
      const requestsBefore = fetch.mock.calls.length;
      fetch
        .mockResolvedValueOnce(marketResponse(192))
        .mockResolvedValueOnce(marketResponse(202));
      expect((await h.executeReview())?.result.kind).toBe("success");
      expect(fetch.mock.calls.length - requestsBefore).toBe(2);
      expect(responses).toHaveLength(2);
      expect(responses[0]!.data.start?.price).toBe(192);
      expect(responses[1]!.data.start?.price).toBe(202);
      const entry = h.memories()[0]!.content;
      expect(entry.returns.kind).toBe("recorded");
      if (entry.returns.kind !== "recorded")
        throw new Error("Expected updated returns");
      const data = Object.fromEntries(
        Object.entries(responses[1]!.data).filter(
          ([field]) => field !== "market",
        ),
      );
      const envelope = Object.fromEntries(
        Object.entries(responses[1]!).filter(
          ([field]) => field !== "candidateClaims",
        ),
      );
      expect(entry.returns.snapshot.envelope).toEqual({ ...envelope, data });
      expect(entry.returns.snapshot.request.parameters.endDate).toBe(
        updatedQuery.endDate,
      );
      expect(h.memories()).toHaveLength(1);
      expect(h.snapshot()).toEqual(h.before);
    },
  );

  it("records a failed explicit update without reusing an older success or querying on save", async () => {
    const query = {
      provider: "tencent",
      historyStartDate: "2024-01-03",
      startDate: "2024-01-03",
      endDate: "2024-01-04",
    };
    let calls = 0;
    let queryFailure = "";
    const h = await host(async function* (request) {
      if (++calls === 1) yield* toolCall("stock_get_returns", query);
      else if (calls === 2) {
        expect(
          lastToolResult<{ envelope: QueryResponse<PriceReturnsQuery> }>(
            request,
          ).envelope.data.start?.price,
        ).toBe(192);
        yield* toolCall("stock_get_returns", query, "failed-update");
      } else if (calls === 3) {
        queryFailure = lastToolText(request);
        yield* toolCall("stock_submit", report);
      } else
        throw new Error("Successful submission must conclude the review turn");
    });
    const requestsBefore = fetch.mock.calls.length;
    fetch.mockImplementation(
      async () =>
        new Response("Fixture returns unavailable", {
          status: 503,
          statusText: "Fixture unavailable",
        }),
    );
    fetch.mockResolvedValueOnce(marketResponse());
    expect((await h.executeReview())?.result.kind).toBe("success");
    expect(queryFailure).toContain("HTTP 503");
    expect(calls).toBe(3);
    expect(fetch.mock.calls.length - requestsBefore).toBe(2);
    expect(h.memories()).toHaveLength(1);
    const saved = h.memories()[0]!.content.returns;
    expect(saved).toMatchObject({
      kind: "unavailable",
      gaps: [
        {
          code: "missing",
          field: "returns",
          detail: expect.stringContaining("HTTP 503"),
        },
      ],
    });
    expect(h.snapshot()).toEqual(h.before);
  });

  it("rejects prose claiming a save without a submitted memory", async () => {
    const h = await host(() => textResponse("复盘已保存，表现优异。"));
    await expect(h.executeReview()).rejects.toMatchObject({
      code: "INVALID_ARTIFACT",
      message: expect.stringContaining("without submitting"),
    });
    expect(h.memories()).toEqual([]);
    expect(h.snapshot()).toEqual(h.before);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("rejects model-authored returns and evidence fields before saving code-bound metadata", async () => {
    let calls = 0;
    let feedback = "";
    const h = await host(async function* (request) {
      if (++calls === 1) {
        yield* toolCall("stock_submit", {
          ...report,
          content: {
            ...report.content,
            returns: { kind: "recorded", value: 9.99 },
            evidence: [],
          },
        });
        return;
      }
      feedback = lastToolText(request);
      expect(h.memories()).toEqual([]);
      yield* toolCall("stock_submit", report, "corrected-review");
    });
    const requestsBefore = fetch.mock.calls.length;
    expect((await h.executeReview())?.result.kind).toBe("success");
    expect(feedback).toContain("returns");
    expect(calls).toBe(2);
    expect(h.memories()).toHaveLength(1);
    expect(h.memories()[0]!.content.returns.kind).toBe("unavailable");
    expect(h.memories()[0]!.content.evidence.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.length).toBe(requestsBefore);
    expect(h.snapshot()).toEqual(h.before);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("selects an existing review for revision while retaining its earlier immutable version", async () => {
    const state: { previous?: { entryId: string; revision: number } } = {};
    let calls = 0;
    const revised = { ...report, summary: "更新交付观察后继续跟踪单位利润。" };
    const h = await host(async function* () {
      if (state.previous === undefined) yield* toolCall("stock_submit", report);
      else if (++calls === 1)
        yield* toolCall("stock_select_review", state.previous);
      else yield* toolCall("stock_submit", revised);
    });
    expect((await h.executeReview())?.result.kind).toBe("success");
    const previous = h.memories()[0]!.ref;
    state.previous = previous;
    const earlier = h.runtime.memory.read(previous);
    expect(
      (await h.execute(`/stock-review ${h.runId} 2024-01-04 修订已有复盘`))
        ?.result.kind,
    ).toBe("success");
    const updated = h.memories();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.ref).toEqual({
      entryId: previous.entryId,
      revision: previous.revision + 1,
    });
    expect(updated[0]!.content.previous).toEqual(previous);
    expect(updated[0]!.content.outcome).toBe(revised.summary);
    expect(h.runtime.memory.read(previous)).toEqual(earlier);
    expect(h.snapshot()).toEqual(h.before);
  });

  it("rejects a revision target belonging to another run", async () => {
    const state: { target?: { entryId: string; revision: number } } = {};
    let calls = 0;
    let feedback = "";
    const h = await host(async function* (request) {
      if (++calls === 1) yield* toolCall("stock_select_review", state.target);
      else {
        feedback = lastToolText(request);
        yield* toolCall("stock_submit", report);
      }
    });
    expect((await h.executeAndWait())?.result.kind).toBe("success");
    const foreignRunId = h.workflow.state.runId!;
    expect(foreignRunId).not.toBe(h.runId);
    const target = await h.runtime.memory.remember(
      { runId: foreignRunId, identity: "fixture", scope: h.scope },
      {
        previous: null,
        outcome: "其他运行复盘。",
        note: "独立笔记。",
        evidence: [],
        returns: {
          kind: "unavailable",
          gaps: [
            {
              code: "missing",
              field: "returns",
              detail: "本次复盘未查询收益。",
            },
          ],
        },
      },
      "foreign-review",
    );
    state.target = target;
    const earlier = h.runtime.memory.read(target);
    expect((await h.executeReview())?.result.kind).toBe("success");
    expect(feedback).toContain("ACCESS_DENIED");
    expect(h.memories()).toHaveLength(1);
    expect(h.memories()[0]!.content.previous).toBeNull();
    expect(h.runtime.memory.read(target)).toEqual(earlier);
  });

  it("drains an aborted model request on unload and cannot save late", async () => {
    const pause = gate<GenerateOptions>();
    const h = await host(async function* (request) {
      const aborted = () => pause.aborted.resolve();
      request.signal?.addEventListener("abort", aborted, { once: true });
      pause.started.resolve(request);
      try {
        await pause.released.promise;
        request.signal?.throwIfAborted();
        yield* toolCall("stock_submit", report);
      } finally {
        request.signal?.removeEventListener("abort", aborted);
      }
    });
    cleanups.push(async () => pause.released.resolve());
    const controller = new AbortController();
    const work = h.executeReview(controller.signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await pause.started.promise;
    const reason = new Error("Review cancelled by fixture");
    controller.abort(reason);
    expect(await work).toEqual({ error: reason });
    let unloaded = false;
    const unloading = h.fiber.dispose().then(() => {
      unloaded = true;
    });
    try {
      await pause.aborted.promise;
      await setImmediate();
      expect(unloaded).toBe(false);
      expect(h.memories()).toEqual([]);
    } finally {
      pause.released.resolve();
    }
    await unloading;
    expect(unloaded).toBe(true);
    expect(h.memories()).toEqual([]);
    expect(h.snapshot()).toEqual(h.before);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });
});

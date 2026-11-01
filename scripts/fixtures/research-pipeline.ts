import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type { DecisionResult } from "../../src/contracts/artifact-payloads.js";
import type { RunReader } from "../../src/contracts/run-access.js";
import { readCollection } from "../../src/app/collection-input.js";
import { isApplicationBusy } from "../../src/app/activity.js";
import { quickHost, initialInput } from "../../test/fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
  type RoleInput,
} from "../../test/fixtures/research-workflow.js";

type Mode = "quick" | "deep";
type Profile = "slow-macro" | "slow-fundamentals";
type Category = "market" | "fundamentals" | "macro";
type Event = {
  kind: "fetch-start" | "fetch-end" | "role-start" | "role-end";
  atMs: number;
  name: string;
  category?: Category;
};
const TABLES = [
  "market.daily",
  "market.weekly",
  "market.monthly",
  "financial.indicators",
  "financial.quarter",
  "financial.income",
  "financial.balance",
  "financial.cashflow",
  "financial.metrics",
  "macro.gdp",
  "macro.cpi",
  "macro.ppi",
  "macro.pmi",
  "macro.moneySupply",
  "macro.lpr",
  "macro.industrial",
  "macro.retail",
  "macro.investment",
  "macro.trade",
  "macro.socialFinancing",
].sort();
const BUSINESS_TASKS = [
  "analysis.market",
  "analysis.fundamentals",
  "digest.analysis",
  "debate.1.bull",
  "debate.1.bear",
  "digest.debate.1",
  "manager.decision",
  "finalize",
];

function category(url: URL): Category {
  if (
    url.hostname === "web.ifzq.gtimg.cn" &&
    url.pathname === "/appstock/app/fqkline/get"
  )
    return "market";
  if (
    url.hostname === "datacenter.eastmoney.com" &&
    url.pathname.startsWith("/securities/api/data/")
  )
    return "fundamentals";
  if (
    (url.hostname === "datacenter-web.eastmoney.com" &&
      url.pathname === "/api/data/v1/get") ||
    (url.hostname === "data.mofcom.gov.cn" &&
      url.pathname === "/datamofcom/front/gnmy/shrzgmQuery")
  )
    return "macro";
  throw new Error(`Unexpected benchmark source URL: ${url.href}`);
}
function response(url: URL, selected: Category) {
  if (selected === "market") {
    const [symbol, period] = url.searchParams.get("param")!.split(",");
    assert.equal(symbol, "sz002594");
    const dates: Record<string, string> = {
      day: "2024-01-03",
      week: "2023-12-29",
      month: "2023-12-01",
    };
    const date = dates[period!];
    assert.ok(date, `Unexpected Tencent period ${period}`);
    return {
      code: 0,
      data: {
        sz002594: { [period!]: [[date, "190", "192", "193", "189", "100"]] },
      },
    };
  }
  if (url.hostname === "data.mofcom.gov.cn")
    return [
      {
        date: "202312",
        tiosfs: 100,
        rmblaon: 100,
        forcloan: 100,
        entrustloan: 100,
        trustloan: 100,
        ndbab: 100,
        bibae: 100,
        sfinfe: 100,
      },
    ];
  const values = Object.fromEntries(
    (url.searchParams.get("columns") ?? "")
      .split(",")
      .filter(Boolean)
      .map((field) => [field, 100]),
  );
  const row =
    selected === "fundamentals"
      ? {
          ...values,
          SECUCODE: "002594.SZ",
          REPORT_DATE: "2023-09-30",
          NOTICE_DATE: "2023-10-30",
          CURRENCY: "CNY",
          BPS: 100,
          TOTALOPERATEREVE: 100,
          PARENTNETPROFIT: 100,
        }
      : { ...values, REPORT_DATE: "2023-12-01", TRADE_DATE: "2023-12-29" };
  return { success: true, code: 0, result: { pages: 1, data: [row] } };
}
function overlap(events: Event[]) {
  let sources = 0,
    analyses = 0,
    previous = 0,
    result = 0;
  for (const event of [...events].sort((a, b) => a.atMs - b.atMs)) {
    if (sources > 0 && analyses > 0) result += event.atMs - previous;
    if (event.kind === "fetch-start") sources++;
    if (event.kind === "fetch-end") sources--;
    if (event.name.startsWith("analysis.")) {
      if (event.kind === "role-start") analyses++;
      if (event.kind === "role-end") analyses--;
    }
    previous = event.atMs;
  }
  return result;
}
function businessDecision(
  value: DecisionResult,
  runs: Pick<RunReader, "readArtifact" | "readEvidence">,
) {
  const validation = {
    warnings: value.validation.warnings,
    checkedReports: value.validation.checkedRefs
      .map((ref) => runs.readArtifact(ref))
      .filter(({ content }) => content.kind !== "collection")
      .map(({ taskId, attempt, content }) => ({
        taskId,
        attempt,
        kind: content.kind,
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    dataQuality: value.validation.dataQuality
      .map((entry) => {
        const quality = {
          kind: entry.kind,
          gap: entry.gap,
          fieldPattern: entry.fieldPattern,
          count: entry.count,
        };
        if (entry.kind === "artifact")
          return {
            ...quality,
            taskId: runs.readArtifact(entry.artifact).taskId,
          };
        const { taskId, request } = runs.readEvidence(entry.source);
        return { ...quality, taskId, request };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return {
    rating: value.rating,
    horizonEndDate: value.horizonEndDate,
    securityId: value.securityId,
    cutoff: value.cutoff,
    computedReturn: value.computedReturn,
    thesis: value.thesis.map(({ text }) => text),
    risks: value.risks,
    riskResponses: value.riskResponses,
    invalidationConditions: value.invalidationConditions,
    limitations: value.limitations,
    validation,
    report: JSON.parse(
      JSON.stringify(value.report, (key, item) =>
        key === "calculationId" || key === "calculationIds" ? undefined : item,
      ),
    ),
  };
}

/** External responses are fixed; collection, storage, SDK and scheduling are real. */
export async function sample(
  mode: Mode,
  profile: Profile,
  onRunBoundary?: (active: boolean) => void,
) {
  assert.ok(["quick", "deep"].includes(mode));
  assert.ok(["slow-macro", "slow-fundamentals"].includes(profile));
  const originalFetch = globalThis.fetch;
  const events: Event[] = [];
  const counts = { market: 0, fundamentals: 0, macro: 0 };
  let origin = performance.now();
  let activeFetch = 0,
    peakFetch = 0,
    activeStreams = 0,
    peakStreams = 0,
    peakLiveChildAgents = 0;
  const liveChildren = new Set<Agent>();
  const mark = (kind: Event["kind"], name: string, selected?: Category) =>
    events.push({
      kind,
      name,
      atMs: performance.now() - origin,
      ...(selected === undefined ? {} : { category: selected }),
    });
  let h: Awaited<ReturnType<typeof quickHost>> | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const selected = category(url);
      const name =
        selected === "market"
          ? url.searchParams.get("param")!.split(",")[1]!
          : (url.searchParams.get("reportName") ??
            url.searchParams.get("type") ??
            "socialFinancing");
      counts[selected]++;
      activeFetch++;
      peakFetch = Math.max(peakFetch, activeFetch);
      mark("fetch-start", name, selected);
      try {
        const ms =
          selected === "market"
            ? 10
            : selected === "macro"
              ? profile === "slow-macro"
                ? 60
                : 5
              : profile === "slow-fundamentals"
                ? 60
                : 10;
        await delay(ms, undefined, { signal: init?.signal ?? undefined });
        return Response.json(response(url, selected));
      } finally {
        mark("fetch-end", name, selected);
        activeFetch--;
      }
    };
    const model = workflowModel();
    const seen = new Set<string>();
    async function* respond(
      request: GenerateOptions,
    ): AsyncIterable<StreamChunk> {
      activeStreams++;
      peakStreams = Math.max(peakStreams, activeStreams);
      const first = !seen.has(String(request.sessionId));
      seen.add(String(request.sessionId));
      const role =
        !isMainResearchRequest(request) && first
          ? initialInput<RoleInput>(request).task.id
          : undefined;
      if (role !== undefined) mark("role-start", role);
      try {
        if (first) {
          const slow =
            role === "analysis.market" ||
            (profile === "slow-macro" && role === "analysis.fundamentals");
          await delay(slow ? 180 : 5, undefined, { signal: request.signal });
        }
        yield* model.respond(request);
      } finally {
        if (role !== undefined) mark("role-end", role);
        activeStreams--;
      }
    }
    h = await quickHost(
      respond,
      async (fixture) => {
        fixture.ctx.on("agent/created", ({ agent }) => {
          liveChildren.add(agent);
          peakLiveChildAgents = Math.max(
            peakLiveChildAgents,
            liveChildren.size,
          );
          return undefined;
        });
        fixture.ctx.on("agent/disposed", ({ agent }) => {
          liveChildren.delete(agent);
        });
      },
      {
        enabledSources: ["tencent", "eastmoney-income", "china-macro"],
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
    const host = h;
    origin = performance.now();
    onRunBoundary?.(true);
    const acknowledgement = await host.execute(
      `/stock-${mode} SZ.002594 2024-01-03`,
    );
    const acknowledgementMs = performance.now() - origin;
    assert.equal(acknowledgement?.result.kind, "success");
    const completed = await host.waitForResearch(acknowledgement);
    onRunBoundary?.(false);
    const elapsedMs = performance.now() - origin;
    assert.equal(completed?.result.kind, "success", completed?.result.text);
    const view = host.runtime.runs.view({ runId: model.state.runId! });
    assert.equal(view.status, "completed");
    assert.ok(view.tasks.every(({ status }) => status === "succeeded"));
    assert.ok(view.stages?.length);
    assert.ok(view.stages.every(({ accepted }) => accepted));
    for (const id of BUSINESS_TASKS)
      assert.ok(
        view.tasks.some(({ taskId }) => taskId === id),
        id,
      );
    const artifacts = view.tasks.flatMap(({ outputRefs }) =>
      outputRefs.map((ref) => host.runtime.runs.readArtifact(ref).content),
    );
    const nodeSnapshots = artifacts
      .filter(({ kind }) => kind === "collection")
      .map(
        ({ payload }) => (payload as { snapshot: CollectionSnapshot }).snapshot,
      );
    const base = readCollection(host.runtime.runs, view.runId);
    assert.ok(base);
    const snapshots = [base, ...nodeSnapshots];
    for (const snapshot of snapshots) {
      assert.equal(snapshot.scope.cutoff, "2024-01-03T08:00:00.000Z");
      assert.ok(snapshot.recordPath && fs.existsSync(snapshot.recordPath));
      const saved = JSON.parse(fs.readFileSync(snapshot.recordPath, "utf8"));
      assert.equal(saved.status, "complete");
      assert.deepEqual(saved.snapshot.packets, snapshot.packets);
    }
    const packets = snapshots
      .flatMap(({ packets }) => packets)
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      packets.map(({ id }) => id),
      [...TABLES].sort((a, b) => a.localeCompare(b)),
    );
    assert.ok(packets.every(({ envelope }) => envelope.data.rows.length > 0));
    assert.deepEqual(counts, { market: 3, fundamentals: 5, macro: 11 });
    assert.equal(
      packets.find(({ id }) => id === "market.daily")!.envelope.data.rows[0]!
        .values.close,
      192,
    );
    const report = artifacts.find(({ kind }) => kind === "report")!;
    assert.ok(report.body.includes("估值依据"));
    const decision = artifacts.find(({ kind }) => kind === "decision")!
      .payload as DecisionResult;
    assert.equal(decision.report!.content.targetPrice!.value, 230.4);
    const semanticDecision = businessDecision(decision, host.runtime.runs);
    assert.equal(activeFetch, 0);
    assert.equal(activeStreams, 0);
    assert.equal(isApplicationBusy(host.runtime), false);
    assert.equal(liveChildren.size, 0);
    assert.deepEqual(host.ctx.agents.list(), [host.outside.agent]);
    for (const child of host.created)
      assert.equal(host.ctx.sessions.get(child.id), undefined);
    const agents = host.ctx.agents;
    const directory = host.directory;
    h = undefined;
    await host.close();
    assert.equal(agents.list().length, 0);
    assert.equal(fs.existsSync(directory), false);
    const firstAnalysisMs = Math.min(
      ...events
        .filter(
          ({ kind, name }) =>
            kind === "role-start" && name.startsWith("analysis."),
        )
        .map(({ atMs }) => atMs),
    );
    const lastSourceMs = Math.max(
      ...events
        .filter(({ kind }) => kind === "fetch-end")
        .map(({ atMs }) => atMs),
    );
    return {
      mode,
      profile,
      timing: {
        acknowledgementMs,
        elapsedMs,
        firstAnalysisMs,
        lastSourceMs,
        overlapWindowMs: Math.max(0, lastSourceMs - firstAnalysisMs),
        sourceAnalysisStreamOverlapMs: overlap(events),
      },
      peaks: {
        fetch: peakFetch,
        modelStreams: peakStreams,
        liveChildAgents: peakLiveChildAgents,
      },
      sourceRequests: counts,
      timeline: events,
      semantic: {
        data: packets,
        decision: semanticDecision,
        completed: true,
        stagesAccepted: view.stages!.length,
      },
    };
  } finally {
    onRunBoundary?.(false);
    try {
      await h?.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

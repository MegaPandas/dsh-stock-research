import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, expect, it, vi } from "vitest";
import { createResearchReadTools } from "../../src/app/research-read-tools.js";
import { researchRunView } from "../../src/app/research-view.js";
import { SessionBindings } from "../../src/host/bindings.js";
import { createRunReadOperations } from "../../src/host/run-reading.js";
import { DecisionService } from "../../src/services/decisions.js";
import { assembleAgentArtifact } from "../../src/services/agent-artifacts.js";
import {
  agentAnalysisReport,
  reportHandoff,
} from "../fixtures/analysis-report.js";
import { decisionFixture } from "../fixtures/decision.js";

const fixtures: ReturnType<typeof decisionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const f = decisionFixture();
  fixtures.push(f);
  const agent = { id: "coordinator" } as Agent;
  const bindings = new SessionBindings();
  bindings.bind(agent, { kind: "coordinator", runIds: [f.operation.runId] });
  const tools = createResearchReadTools(
    createRunReadOperations(f.runs, bindings),
  );
  const call = (
    name: string,
    value: unknown,
    signal = new AbortController().signal,
  ) =>
    tools
      .find((tool) => tool.name === name)!
      .execute(value, {
        agent,
        signal,
        callId: "read",
      } as ToolRunContext);
  return { ...f, call };
}

it("presents model-facing status and business reports without duplicating run metadata", async () => {
  const f = setup();
  const view = f.runs.view(f.operation);
  const result = await f.call("stock_read_run", { runId: f.operation.runId });
  expect(result).toEqual({
    kind: "run_view",
    view: {
      runId: f.operation.runId,
      scope: f.scope,
      mode: "quick",
      status: view.status,
      tasks: view.tasks.map(({ taskId, status, attempt }) => ({
        taskId,
        status,
        attempt,
      })),
      blockReasons: [],
      stages: [],
    },
    reportCatalog: expect.arrayContaining([
      {
        ref: f.analysisRef,
        taskId: "analysis",
        kind: "analysis",
        title: "Market analysis",
        summary: null,
      },
      {
        ref: f.draftRef,
        taskId: "manager",
        kind: "decision_draft",
        title: "Manager decision",
        summary: null,
      },
    ]),
  });
  const modelView = (result as { view: Record<string, unknown> }).view;
  expect(Object.keys(modelView)).toEqual([
    "runId",
    "scope",
    "mode",
    "status",
    "tasks",
    "blockReasons",
    "stages",
  ]);
  expect(f.runs.view(f.operation)).toEqual(view);
});

it("retains current review refs, rejection feedback and failures without carrying review history", () => {
  const f = setup();
  const view = f.runs.view(f.operation);
  const review = {
    stageId: "manager",
    verdict: "rejected" as const,
    feedback: "Explain the target-price assumptions",
    refs: [f.draftRef],
    identity: "coordinator",
    recordedAt: f.scope.cutoff,
    requestId: "review-manager",
  };
  view.stages = [
    {
      id: "analysis",
      taskIds: ["analysis"],
      beforeTasks: ["digest"],
      readyForReview: false,
      accepted: true,
      refs: [f.analysisRef],
    },
    {
      id: "manager",
      taskIds: ["manager"],
      beforeTasks: ["final"],
      readyForReview: true,
      accepted: false,
      refs: [f.draftRef],
      latestReview: review,
    },
  ];
  view.stageReviews = [review];
  view.tasks[0]!.failure = {
    code: "SOURCE_UNAVAILABLE",
    message: "Source failed",
  };
  view.blockReasons = [
    { id: "block", taskId: "analysis", attempt: 1, ...view.tasks[0]!.failure },
  ];
  const result = researchRunView(view);
  expect(result.stages).toEqual([
    {
      id: "analysis",
      taskIds: ["analysis"],
      readyForReview: false,
      accepted: true,
      refs: [],
    },
    {
      id: "manager",
      taskIds: ["manager"],
      readyForReview: true,
      accepted: false,
      refs: [f.draftRef],
      feedback: "Explain the target-price assumptions",
    },
  ]);
  expect(result.tasks[0]!.failure).toEqual({
    code: "SOURCE_UNAVAILABLE",
    message: "Source failed",
  });
  expect(result.blockReasons).toEqual(view.blockReasons);
  expect(result).not.toHaveProperty("stageReviews");
  expect(view.stages[0]!.refs).toEqual([f.analysisRef]);
});

it("presents final report text while preserving its complete stored artifact", async () => {
  const f = setup();
  const result = new DecisionService(f.runs, f.now).decide(
    f.operation,
    "final",
    "finalize",
  );
  const ref = result.refs[1]!;
  const saved = f.runs.readArtifact(ref);
  const { kind, title, body } = saved.content;
  expect(await f.call("stock_read_artifact", { ref })).toEqual({
    kind: "artifact",
    artifact: { ...saved, content: { kind, title, body } },
  });
  expect(f.runs.readArtifact(ref)).toEqual(saved);
});

it("loads one business report and handoff by default and the complete artifact on demand", async () => {
  const f = setup();
  f.runs.redo(f.operation, "analysis", "redo-analysis");
  const claim = f.runs.claim(f.operation, "analysis", "new-analysis");
  const report = agentAnalysisReport();
  const handoff = reportHandoff(report);
  const content = assembleAgentArtifact(
    "analysis",
    report,
    {
      taskId: "analysis",
      specialty: "market",
      title: "Market research",
      inputRefs: [],
      currency: f.scope.security.currency,
      scope: f.scope,
      referencePrice: null,
    },
    [],
    handoff,
  );
  const ref = f.artifacts.submitArtifact(
    { ...claim, identity: "worker", sessionId: null },
    [content],
    "new-report",
  ).refs[0]!;
  const saved = f.runs.readArtifact(ref);
  expect(await f.call("stock_read_artifact", { ref })).toEqual({
    kind: "artifact",
    artifact: {
      ...saved,
      content: {
        kind: "analysis",
        title: "Market research",
        ...report,
        stageHandoff: handoff,
      },
    },
  });
  expect(await f.call("stock_read_artifact", { ref, view: "full" })).toEqual({
    kind: "artifact",
    artifact: saved,
  });
  expect(f.runs.readArtifact(ref)).toEqual(saved);
});

it("rejects run and artifact reads outside the coordinator binding", async () => {
  const f = setup();
  await expect(
    f.call("stock_read_run", { runId: "another-run" }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    f.call("stock_read_artifact", {
      ref: { ...f.analysisRef, runId: "another-run" },
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

it("validates closed arguments and references before reading storage", async () => {
  const f = setup();
  const view = vi.spyOn(f.runs, "view");
  const read = vi.spyOn(f.runs, "readArtifact");
  for (const [name, value] of [
    ["stock_read_run", { runId: f.operation.runId, cutoff: f.scope.cutoff }],
    ["stock_read_run", { runId: "" }],
    ["stock_read_artifact", { ref: { ...f.analysisRef, sessionId: "forged" } }],
    ["stock_read_artifact", { ref: { ...f.analysisRef, revision: 0 } }],
    ["stock_read_artifact", { ref: f.analysisRef, view: "unknown" }],
  ] as const)
    await expect(f.call(name, value)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("checks cancellation before parsing tool arguments", async () => {
  const f = setup();
  const view = vi.spyOn(f.runs, "view");
  const read = vi.spyOn(f.runs, "readArtifact");
  const reason = new Error("stop reading");
  for (const name of ["stock_read_run", "stock_read_artifact"])
    await expect(f.call(name, {}, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

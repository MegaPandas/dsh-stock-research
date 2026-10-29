import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskOperation } from "../../src/contracts/runs.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import { digestGate, gatedDigest } from "../fixtures/digest-execution.js";
import {
  analysis,
  dispatchHost,
  modelGate,
  type ModelScript,
} from "../fixtures/dispatch-host.js";

const cleanups: (() => Promise<void>)[] = [];
async function host(
  scripts: ModelScript[] = [],
  generateDigest?: Parameters<typeof dispatchHost>[1],
) {
  const h = await dispatchHost(scripts, generateDigest);
  cleanups.push(h.close);
  return h;
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

describe("confirmed interruption recovery at the host boundary", () => {
  it("retains role ownership after artifact submission until the real child has drained", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "save", afterSave: gate }]);
    const work = h.dispatch("role");
    const target = { taskId: "analysis", attempt: 1 };
    expect(h.runs.readAttempt({ ...h.operation, ...target })).toMatchObject({
      status: "running",
      sessionId: null,
    });
    expect(() =>
      h.bridge.recoverInterrupted(
        h.operation,
        [target],
        "recover-starting-role",
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    const request = await gate.started.promise;
    const before = h.runs.readAttempt({ ...h.operation, ...target });
    expect(before).toMatchObject({
      status: "succeeded",
      sessionId: request.sessionId,
    });
    expect(before.outputRefs).toHaveLength(1);
    expect(
      h.ctx.agents.get(SessionId(String(request.sessionId))),
    ).toBeDefined();

    expect(() =>
      h.bridge.recoverInterrupted(h.operation, [target], "recover-live-role"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(h.runs.readAttempt({ ...h.operation, ...target })).toEqual(before);
    gate.released.resolve();
    const result = await work;
    expect(result).toMatchObject({
      status: "succeeded",
      refs: before.outputRefs,
    });
    expect(
      h.ctx.agents.get(SessionId(String(request.sessionId))),
    ).toBeUndefined();
  });

  it("rejects recovery while a cancelled digest execution still belongs to this host", async () => {
    const gate = digestGate();
    const h = await host([], () => gatedDigest(gate));
    cleanups.push(async () => {
      gate.released.resolve();
    });
    const role = h.runs.claim(h.operation, "analysis", "fixed-analysis");
    const roleOperation: TaskOperation = {
      ...role,
      identity: "analyst-worker",
      sessionId: null,
    };
    h.artifacts.submitArtifact(
      roleOperation,
      [
        {
          ...analysis(),
          payload: {
            schemaVersion: 3,
            report: agentAnalysisReport(),
            stageHandoff: {
              keyPoints: ["Fixed finding"],
              disagreements: [],
              risks: [],
              openQuestions: [],
            },
          },
        },
      ],
      "fixed-analysis",
    );
    const controller = new AbortController();
    const work = observe(
      h.bridge.makeDigest(h.operation, "digest", "digest", controller.signal),
    );
    await gate.started.promise;
    controller.abort(new DOMException("Cancel the owned digest", "AbortError"));
    await gate.aborted.promise;
    const target = { taskId: "digest", attempt: 1 };
    const before = h.runs.readAttempt({ ...h.operation, ...target });
    expect(before).toMatchObject({
      status: "running",
      sessionId: null,
      outputRefs: [],
    });
    expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
    expect(h.adapter.requests).toHaveLength(0);

    expect(() =>
      h.bridge.recoverInterrupted(h.operation, [target], "recover-live-digest"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(h.runs.readAttempt({ ...h.operation, ...target })).toEqual(before);
    gate.released.resolve();
    expect(await work).toMatchObject({
      kind: "rejected",
      reason: expect.any(Error),
    });
    expect(h.runs.readAttempt({ ...h.operation, ...target })).toMatchObject({
      status: "failed",
      failure: { code: "CANCELLED" },
      outputRefs: [],
    });
    expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
  });

  it("uses actual session liveness and recovers only the explicitly lost attempt without restarting other work", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "save" }, { kind: "wait", gate }]);
    const successful = await h.dispatch("analysis", "analysis");
    const parallel = h.dispatch("parallel", "parallel");
    const parallelRequest = await gate.started.promise;
    const parallelTarget = { runId: h.runId, taskId: "parallel", attempt: 1 };
    const independent = h.runs.readAttempt(parallelTarget);
    const lost = h.runs.claim(h.operation, "dependent", "previous-host-claim");
    const resident = await h.ctx.agents.create({
      sessionId: SessionId("previous-host-dependent"),
      parentAgent: h.parent.agent,
      agentOptions: { provider: "fixture", model: "dispatch-fixture" },
      meta: { cwd: h.root.path },
    });
    h.runs.bindTaskSession({
      ...lost,
      identity: h.operation.identity,
      sessionId: resident.agent.id,
    });
    const target = { taskId: lost.taskId, attempt: lost.attempt };
    const before = h.runs.readAttempt(lost);
    expect(() =>
      h.bridge.recoverInterrupted(h.operation, [target], "confirmed-loss"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(h.runs.readAttempt(lost)).toEqual(before);

    // The owner explicitly disposes this SDK session; elapsed time is not evidence.
    await resident.dispose();
    expect(h.ctx.agents.get(resident.agent.id)).toBeUndefined();
    const modelCalls = h.adapter.requests.length;
    expect(
      h.bridge.recoverInterrupted(h.operation, [target], "confirmed-loss"),
    ).toEqual({ runId: h.runId, failedAttempts: [target] });
    expect(h.runs.readAttempt(lost)).toMatchObject({
      status: "failed",
      sessionId: resident.agent.id,
      outputRefs: [],
      failure: { code: "HOST_INTERRUPTED" },
    });
    expect(h.runs.readAttempt(successful)).toMatchObject({
      status: "succeeded",
      outputRefs: successful.refs,
    });
    expect(h.runs.readAttempt(parallelTarget)).toEqual(independent);
    expect(
      h.ctx.agents.get(SessionId(String(parallelRequest.sessionId))),
    ).toBeDefined();
    expect(h.runs.view(h.operation)).toMatchObject({
      status: "active",
      tasks: expect.arrayContaining([
        expect.objectContaining({
          taskId: "dependent",
          status: "failed",
          attempt: 1,
        }),
      ]),
    });
    gate.released.resolve();
    await parallel;
    expect(h.adapter.requests).toHaveLength(modelCalls);
    await h.bridge.close();
    expect(() =>
      h.bridge.recoverInterrupted(h.operation, [target], "after-close"),
    ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
  });
});

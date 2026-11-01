import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, expect, it, vi } from "vitest";
import { createDispatchOperations } from "../../src/host/research-operations.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import {
  analysis,
  dispatchHost,
  modelGate,
} from "../fixtures/dispatch-host.js";
import { digestGate, gatedDigest } from "../fixtures/digest-execution.js";

const cleanups: (() => Promise<void> | void)[] = [];
async function host(...args: Parameters<typeof dispatchHost>) {
  const fixture = await dispatchHost(...args);
  cleanups.push(fixture.close);
  return fixture;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("does not publish a pre-cancelled typed task control or consume its request identity", async () => {
  const h = await host([]);
  const operations = createDispatchOperations(h.bridge);
  const caller = h.bindings.require(h.parent.agent);
  const request = {
    runId: h.runId,
    taskId: "analysis",
    expectedAttempt: 0,
    reason: "Stop this branch",
    requestId: "cancel-analysis",
  };
  const before = h.runs.view(h.operation);
  const reason = new DOMException(
    "Control cancelled before execution",
    "AbortError",
  );
  await expect(
    Promise.resolve().then(() =>
      operations.cancelTask(request, caller, AbortSignal.abort(reason)),
    ),
  ).rejects.toBe(reason);
  expect(h.runs.view(h.operation)).toEqual(before);
  await expect(
    operations.cancelTask(
      { ...request, reason: "Explicit retry" },
      caller,
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({
    taskId: "analysis",
    attempt: 0,
    status: "active",
  });
  expect(h.adapter.requests).toEqual([]);
});

it("stops an owned attempt before provisioning starts", async () => {
  const h = await host([]);
  const execution = h
    .dispatch("before-provisioning")
    .catch((reason: unknown) => reason);
  const stopped = await h.bridge.cancelTask(
    h.operation,
    {
      taskId: "analysis",
      expectedAttempt: 1,
      reason: "Stop before activation",
    },
    "cancel-analysis",
  );
  expect(stopped.stopAttempts).toEqual([{ taskId: "analysis", attempt: 1 }]);
  expect(await execution).toBeInstanceOf(Error);
  expect(
    h.runs.readAttempt({ ...h.operation, taskId: "analysis", attempt: 1 })
      .status,
  ).toBe("cancelled");
  expect(h.prepared).toEqual([]);
  expect(h.adapter.requests).toEqual([]);
  expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
});

it("publishes branch cancellation immediately and lets independent work finish while stopping drains", async () => {
  const gate = modelGate();
  const h = await host([{ kind: "wait", gate }, { kind: "save" }]);
  const execution = h.dispatch("waiting");
  const options = await gate.started.promise;
  let returned = false;
  const stopping = h.bridge
    .cancelTask(
      h.operation,
      {
        taskId: "analysis",
        expectedAttempt: 1,
        reason: "Withdraw assumptions",
      },
      "cancel-analysis",
    )
    .finally(() => {
      returned = true;
    });
  await gate.aborted.promise;
  expect(returned).toBe(false);
  expect(h.runs.view(h.operation)).toMatchObject({
    status: "active",
    readyTasks: ["parallel"],
  });
  await expect(
    h.dispatch("cancelled-downstream", "dependent"),
  ).rejects.toMatchObject({ code: "TASK_NOT_READY" });
  const independent = await h.dispatch("parallel", "parallel");
  expect(independent.status).toBe("succeeded");
  expect(h.ctx.agents.get(SessionId(String(options.sessionId)))).toBeDefined();
  gate.released.resolve();
  const [attempt, stopped] = await Promise.all([execution, stopping]);
  expect(attempt.status).toBe("cancelled");
  expect(stopped).toMatchObject({
    affectedTasks: ["analysis", "dependent", "digest", "finalize"],
    stopAttempts: [{ taskId: "analysis", attempt: 1 }],
  });
  expect(
    h.ctx.agents.get(SessionId(String(options.sessionId))),
  ).toBeUndefined();
  expect(h.runs.readAttempt(independent).status).toBe("succeeded");
});

it("holds replacement dispatch behind the stop barrier and does not stop it when cancellation is replayed", async () => {
  const firstGate = modelGate();
  const replacementGate = modelGate();
  const h = await host([
    { kind: "wait", gate: firstGate },
    { kind: "save", afterSave: replacementGate },
  ]);
  const execution = h.dispatch("first");
  await firstGate.started.promise;
  const input = {
    taskId: "analysis",
    expectedAttempt: 1,
    reason: "Replace this branch",
  };
  const stopping = h.bridge.cancelTask(h.operation, input, "cancel-analysis");
  await firstGate.aborted.promise;
  const redo = h.bridge.redo(h.operation, "analysis", "redo-analysis");
  const replacement = h.dispatch("replacement");
  await setImmediate();
  expect(h.adapter.requests).toHaveLength(1);
  expect(h.runs.view(h.operation).tasks[0]).toMatchObject({
    status: "pending",
    attempt: 1,
  });
  firstGate.released.resolve();
  const [old, cancelled] = await Promise.all([execution, stopping, redo]);
  expect(old.status).toBe("cancelled");
  const request = await replacementGate.started.promise;
  let aborted = false;
  void replacementGate.aborted.promise.then(() => {
    aborted = true;
  });
  expect(
    await h.bridge.cancelTask(h.operation, input, "cancel-analysis"),
  ).toEqual(cancelled);
  await setImmediate();
  expect(aborted).toBe(false);
  expect(
    h.runs.readAttempt({ ...h.operation, taskId: "analysis", attempt: 2 })
      .status,
  ).toBe("succeeded");
  expect(h.ctx.agents.get(SessionId(String(request.sessionId)))).toBeDefined();
  replacementGate.released.resolve();
  expect(await replacement).toMatchObject({ attempt: 2, status: "succeeded" });
});

it("propagates execution release failure while preserving the published cancellation", async () => {
  const gate = modelGate();
  const h = await host([{ kind: "wait", gate }]);
  const failure = new Error("Fixture activation release failed");
  const start = h.ctx.subagents.startActivation.bind(h.ctx.subagents);
  vi.spyOn(h.ctx.subagents, "startActivation").mockImplementation(
    async (...args) => {
      const activation = await start(...args);
      return {
        ...activation,
        async dispose() {
          await activation.dispose();
          throw failure;
        },
      };
    },
  );
  const execution = h.dispatch("waiting").catch((reason: unknown) => reason);
  const request = await gate.started.promise;
  const stopping = h.bridge
    .cancelTask(
      h.operation,
      { taskId: "analysis", expectedAttempt: 1, reason: "Stop this branch" },
      "cancel-analysis",
    )
    .catch((reason: unknown) => reason);
  await gate.aborted.promise;
  expect(h.runs.view(h.operation).tasks[0]!.status).toBe("cancelled");
  gate.released.resolve();
  const [attempt, stopped] = await Promise.all([execution, stopping]);
  expect(attempt).toMatchObject({ errors: expect.arrayContaining([failure]) });
  expect(stopped).toMatchObject({ errors: expect.arrayContaining([failure]) });
  expect(
    h.ctx.agents.get(SessionId(String(request.sessionId))),
  ).toBeUndefined();
  expect(h.runs.view(h.operation).tasks[0]!.status).toBe("cancelled");
});

it.each([false, true])(
  "stops a cancelled digest and waits for release after publication failure: %s",
  async (publicationFailure) => {
    const gate = digestGate();
    const h = await host([{ kind: "save" }], () => gatedDigest(gate));
    cleanups.push(() => gate.released.resolve());
    const claim = h.runs.claim(h.operation, "analysis", "source");
    h.artifacts.submitArtifact(
      { ...claim, identity: "source", sessionId: null },
      [
        {
          ...analysis(),
          payload: {
            schemaVersion: 3,
            report: agentAnalysisReport(),
            stageHandoff: {
              keyPoints: ["Fixed conclusion"],
              disagreements: [],
              risks: [],
              openQuestions: [],
            },
          },
        },
      ],
      "source",
    );
    const execution = h.bridge.makeDigest(h.operation, "digest", "digest").then(
      (value) => ({ value }),
      (reason: unknown) => ({ reason }),
    );
    await gate.started.promise;
    const failure = new Error(
      "Fixture directory sync failed after cancellation publication",
    );
    if (publicationFailure) {
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      let published = false;
      vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
        rename(...args);
        if (String(args[1]).endsWith("/manifest.json")) published = true;
      });
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (published && fs.fstatSync(fd).isDirectory()) throw failure;
        sync(fd);
      });
    }
    let returned = false;
    const stopping = h.bridge
      .cancelTask(
        h.operation,
        { taskId: "digest", expectedAttempt: 1, reason: "Stop this summary" },
        "cancel-digest",
      )
      .then(
        (value) => ({ value }),
        (reason: unknown) => ({ reason }),
      )
      .finally(() => {
        returned = true;
      });
    await gate.aborted.promise;
    expect(returned).toBe(false);
    expect(
      h.runs.readAttempt({ ...h.operation, taskId: "digest", attempt: 1 })
        .status,
    ).toBe("cancelled");
    vi.restoreAllMocks();
    gate.released.resolve();
    const [attempt, stopped] = await Promise.all([execution, stopping]);
    expect(attempt).toMatchObject({ reason: expect.any(Error) });
    if (publicationFailure)
      expect(stopped).toMatchObject({
        reason: { code: "STORAGE_FAILED", cause: failure },
      });
    else
      expect(stopped).toMatchObject({
        value: { stopAttempts: [{ taskId: "digest", attempt: 1 }] },
      });
    expect(
      h.digests.isExecuting(h.runId, { taskId: "digest", attempt: 1 }),
    ).toBe(false);
    expect(h.runs.view(h.operation).status).toBe("active");
  },
);

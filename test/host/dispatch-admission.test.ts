import { SubagentError } from "@deepseek-ai/dsh-subagent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchHost, modelGate } from "../fixtures/dispatch-host.js";
import { deferred } from "../fixtures/runtime-host.js";

type Host = Awaited<ReturnType<typeof dispatchHost>>;

function capacityRejected(h: Host) {
  const rejected = deferred<void>();
  const start = h.ctx.subagents.startActivation.bind(h.ctx.subagents);
  vi.spyOn(h.ctx.subagents, "startActivation").mockImplementation(
    async (...args) => {
      try {
        return await start(...args);
      } catch (cause) {
        if (
          cause instanceof SubagentError &&
          cause.code === "ACTIVATION_LIMIT_REACHED"
        )
          rejected.resolve();
        throw cause;
      }
    },
  );
  return rejected.promise;
}

function activeChildren(h: Host) {
  return h.ctx.agents
    .list()
    .filter((agent) => agent.session.header.origin === "subagent");
}

afterEach(() => vi.restoreAllMocks());

describe("DispatchBridge SDK capacity admission", () => {
  it("waits for a finishing child without failing or claiming another attempt", async () => {
    const firstGate = modelGate();
    const h = await dispatchHost(
      [{ kind: "save", afterSave: firstGate }, { kind: "save" }],
      undefined,
      undefined,
      { maxActiveSubagents: 1 },
    );
    try {
      let peak = 0;
      h.ctx.on("agent/created", () => {
        peak = Math.max(peak, activeChildren(h).length);
      });
      const rejected = capacityRejected(h);
      const first = h.dispatch("first");
      const firstRequest = await firstGate.started.promise;
      const committed = h.runs.readAttempt({
        ...h.operation,
        taskId: "analysis",
        attempt: 1,
      });
      expect(committed).toMatchObject({
        status: "succeeded",
        sessionId: firstRequest.sessionId,
      });
      expect(committed.outputRefs).toHaveLength(1);
      const second = h.dispatch("second", "parallel");
      await rejected;
      expect(
        h.runs.readAttempt({ ...h.operation, taskId: "parallel", attempt: 1 }),
      ).toMatchObject({
        status: "running",
        sessionId: null,
        outputRefs: [],
        failure: null,
      });
      expect(
        h.runs
          .view(h.operation)
          .tasks.find(({ taskId }) => taskId === "parallel"),
      ).toMatchObject({ attempt: 1 });
      expect(h.adapter.requests).toHaveLength(2);
      expect(activeChildren(h).map(({ id }) => id)).toEqual([
        firstRequest.sessionId,
      ]);
      firstGate.released.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({
        attempt: 1,
        status: "succeeded",
        refs: committed.outputRefs,
      });
      expect(secondResult).toMatchObject({
        taskId: "parallel",
        attempt: 1,
        status: "succeeded",
      });
      expect(secondResult.refs).toHaveLength(1);
      expect(h.runs.readArtifact(secondResult.refs[0]!)).toMatchObject({
        taskId: "parallel",
        attempt: 1,
      });
      expect(h.runs.readAttempt(secondResult).outputRefs).toEqual(
        secondResult.refs,
      );
      expect(peak).toBe(1);
      expect(activeChildren(h)).toEqual([]);
      expect(h.ctx.agents.list()).toEqual([h.parent.agent]);
      expect(h.adapter.requests).toHaveLength(4);
    } finally {
      firstGate.released.resolve();
      await h.close();
    }
  });

  it("cancels an exact waiting attempt without draining the independent occupied slot", async () => {
    const firstGate = modelGate();
    const h = await dispatchHost(
      [{ kind: "save", afterSave: firstGate }, { kind: "save" }],
      undefined,
      undefined,
      { maxActiveSubagents: 1 },
    );
    try {
      const rejected = capacityRejected(h);
      const first = h.dispatch("first");
      const firstRequest = await firstGate.started.promise;
      const firstAttempt = { ...h.operation, taskId: "analysis", attempt: 1 };
      const committed = h.runs.readAttempt(firstAttempt).outputRefs;
      const second = h.dispatch("second", "parallel");
      await rejected;
      const cancelled = await h.bridge.cancelTask(
        h.operation,
        {
          taskId: "parallel",
          expectedAttempt: 1,
          reason: "Stop queued admission",
        },
        "cancel-queued",
      );
      expect(cancelled).toMatchObject({
        stopAttempts: [{ taskId: "parallel", attempt: 1 }],
      });
      expect(await second).toMatchObject({
        taskId: "parallel",
        attempt: 1,
        status: "cancelled",
        refs: [],
      });
      expect(
        h.runs.readAttempt({ ...h.operation, taskId: "parallel", attempt: 1 }),
      ).toMatchObject({
        status: "cancelled",
        sessionId: null,
        outputRefs: [],
      });
      expect(h.runs.readAttempt(firstAttempt)).toMatchObject({
        status: "succeeded",
        outputRefs: committed,
      });
      expect(h.runs.readArtifact(committed[0]!)).toMatchObject({
        taskId: "analysis",
        attempt: 1,
      });
      expect(activeChildren(h).map(({ id }) => id)).toEqual([
        firstRequest.sessionId,
      ]);
      expect(h.adapter.requests).toHaveLength(2);
      firstGate.released.resolve();
      expect(await first).toMatchObject({
        status: "succeeded",
        refs: committed,
      });
      expect(activeChildren(h)).toEqual([]);
    } finally {
      firstGate.released.resolve();
      await h.close();
    }
  });

  it("admits waiting work after real startup rollback releases capacity without an end event", async () => {
    const creating = deferred<void>();
    const releaseStartup = deferred<void>();
    const secondGate = modelGate();
    const h = await dispatchHost(
      [{ kind: "save", afterSave: secondGate }],
      undefined,
      undefined,
      { maxActiveSubagents: 1 },
    );
    try {
      const failure = new Error("First child startup rejected");
      let firstCreation = true;
      h.ctx.on("agent/created", async ({ agent }) => {
        if (agent.session.header.origin !== "subagent" || !firstCreation)
          return;
        firstCreation = false;
        creating.resolve();
        await releaseStartup.promise;
        throw failure;
      });
      const ended: string[] = [];
      h.ctx.on("subagent/end", ({ id }) => {
        ended.push(id);
      });
      const rejected = capacityRejected(h);
      const first = h
        .dispatch("startup-failure")
        .catch((cause: unknown) => cause);
      await creating.promise;
      const second = h.dispatch("second", "parallel");
      await rejected;
      expect(h.adapter.requests).toEqual([]);
      releaseStartup.resolve();
      expect(await first).toBe(failure);
      const request = await secondGate.started.promise;
      expect(ended).toEqual([]);
      expect(
        h.runs.readAttempt({ ...h.operation, taskId: "analysis", attempt: 1 }),
      ).toMatchObject({
        status: "failed",
        failure: { code: "HOST_FAILED", message: failure.message },
      });
      expect(
        h.runs.readAttempt({ ...h.operation, taskId: "parallel", attempt: 1 }),
      ).toMatchObject({
        status: "succeeded",
        sessionId: request.sessionId,
      });
      expect(activeChildren(h).map(({ id }) => id)).toEqual([
        request.sessionId,
      ]);
      secondGate.released.resolve();
      const result = await second;
      expect(result).toMatchObject({
        taskId: "parallel",
        attempt: 1,
        status: "succeeded",
      });
      expect(result.refs).toHaveLength(1);
      expect(h.runs.readArtifact(result.refs[0]!)).toMatchObject({
        taskId: "parallel",
        attempt: 1,
      });
      expect(activeChildren(h)).toEqual([]);
      expect(h.adapter.requests).toHaveLength(2);
    } finally {
      releaseStartup.resolve();
      secondGate.released.resolve();
      await h.close();
    }
  });
});

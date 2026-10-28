import { setImmediate } from "node:timers/promises";
import fs from "node:fs";
import { createUserMessage, HarnessError } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskOperation } from "../../src/host/bindings.js";
import {
  analysis,
  dispatchHost,
  modelGate,
  type ModelScript,
} from "../fixtures/dispatch-host.js";

const cleanups: (() => Promise<void>)[] = [];
async function host(scripts?: ModelScript[]) {
  const fixture = await dispatchHost(scripts);
  cleanups.push(fixture.close);
  return fixture;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("DispatchBridge with real DSH spawn and research services", () => {
  it("submits a real artifact through a separately bound preset and replays canonical control results", async () => {
    const h = await host([{ kind: "save" }, { kind: "save" }]);
    const args = { runId: h.runId, taskId: "analysis", requestId: "same" };
    const [first, concurrent] = await Promise.all([
      h.call("stock_dispatch_task", args),
      h.call("stock_dispatch_task", args),
    ]);
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({
      isError: false,
      value: {
        runId: h.runId,
        taskId: "analysis",
        attempt: 1,
        status: "succeeded",
        failure: null,
      },
    });
    const result = await h.dispatch("same");
    expect(first.value).toEqual(result);
    expect(h.adapter.requests).toHaveLength(2);
    expect(h.prepared).toHaveLength(1);
    const child = h.children.get(result.sessionId!)!;
    expect(child.binding).toEqual({
      kind: "task",
      runId: h.runId,
      taskId: "analysis",
      attempt: 1,
    });
    expect(child.preset).toBe("research-task");
    expect(h.ctx.agentPresets.composedPreset(h.parent.agent.ctx)).toBe(
      "parent-wide",
    );
    expect(child.tools).toEqual(["stock_save_report"]);
    expect(h.adapter.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "stock_save_report",
    ]);
    expect(
      h.adapter.requests.every(
        (request) => request.sessionId === child.agent.id,
      ),
    ).toBe(true);
    expect(h.runs.readArtifact(result.refs[0]!)).toMatchObject({
      taskId: "analysis",
      attempt: 1,
      producerSessionId: child.agent.id,
      content: analysis(),
    });
    expect(h.runs.readAttempt(result).sessionId).toBe(child.agent.id);
    expect(h.ctx.agents.get(child.agent.id)).toBeUndefined();
    expect(h.ctx.sessions.get(child.agent.id)).toBeUndefined();
    expect(() => h.bindings.require(child.agent)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    expect(h.parent.agent.inbox.nextTurn).toEqual([]);
    expect(h.parent.agent.inbox.nextStep).toEqual([]);

    const redo = await h.call("stock_redo_task", {
      ...args,
      requestId: "redo",
      reason: "Refresh analysis",
    });
    expect(redo).toMatchObject({
      isError: false,
      value: {
        taskId: "analysis",
        status: "active",
        invalidatedRefs: result.refs,
      },
    });
    const replayed = await h.dispatch("same");
    expect(replayed).toMatchObject({ attempt: 1, status: "invalidated" });
    expect(
      h.runs.view(h.operation).tasks.find((task) => task.taskId === "analysis")
        ?.status,
    ).toBe("pending");
    expect(h.adapter.requests).toHaveLength(2);
    const replacement = await h.dispatch("replacement");
    expect(replacement).toMatchObject({ attempt: 2, status: "succeeded" });
    expect(h.adapter.requests).toHaveLength(4);
  });

  it("dispatches independent tasks concurrently in one real parent AgentLoop step", async () => {
    const firstGate = modelGate();
    const secondGate = modelGate();
    const h = await host([
      { kind: "save", afterSave: firstGate },
      { kind: "save", afterSave: secondGate },
    ]);
    h.adapter.prepareParentDispatch(h.runId);
    h.parent.agent.followup(
      createUserMessage({
        content: [
          { type: "text", text: "Dispatch both independent research tasks." },
        ],
        source: { kind: "user" },
      }),
    );
    const idle = h.parent.agent.whenIdle();
    const requests = await Promise.all([
      firstGate.started.promise,
      secondGate.started.promise,
    ]);
    const childIds = requests.map((request) => String(request.sessionId));
    expect(new Set(childIds).size).toBe(2);
    for (const id of childIds)
      expect(h.ctx.agents.get(SessionId(id))).toBeDefined();
    expect(
      h.runs
        .view(h.operation)
        .tasks.filter((task) => ["analysis", "parallel"].includes(task.taskId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "analysis", status: "succeeded" }),
        expect.objectContaining({ taskId: "parallel", status: "succeeded" }),
      ]),
    );
    firstGate.released.resolve();
    secondGate.released.resolve();
    await idle;

    const parentRequests = h.adapter.requests.filter(
      (request) => request.sessionId === h.parent.agent.id,
    );
    expect(parentRequests).toHaveLength(2);
    const toolMessages = parentRequests[1]!.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.every((message) => !message.isError)).toBe(true);
    const results = toolMessages.map((message) =>
      JSON.parse(
        message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      ),
    );
    for (const taskId of ["analysis", "parallel"]) {
      const child = [...h.children.values()].find(
        (entry) =>
          entry.binding.kind === "task" && entry.binding.taskId === taskId,
      )!;
      const result = await h.dispatch(`parent-${taskId}`, taskId);
      expect(result).toMatchObject({
        taskId,
        status: "succeeded",
        sessionId: child.agent.id,
      });
      expect(results).toContainEqual(result);
      expect(childIds).toContain(child.agent.id);
      expect(h.runs.readArtifact(result.refs[0]!)).toMatchObject({
        taskId,
        producerSessionId: child.agent.id,
        content: analysis(),
      });
      expect(h.ctx.agents.get(child.agent.id)).toBeUndefined();
    }
  });

  it("waits for the original owner when a duplicate arrives after artifact submission", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "save", afterSave: gate }]);
    const first = h.dispatch("same");
    const options = await gate.started.promise;
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "analysis", attempt: 1 }),
    ).toMatchObject({ status: "succeeded", sessionId: options.sessionId });
    let duplicateReturned = false;
    const duplicate = h.dispatch("same").then((value) => {
      duplicateReturned = true;
      return value;
    });
    await setImmediate();
    expect(duplicateReturned).toBe(false);
    expect(
      h.ctx.agents.get(SessionId(String(options.sessionId))),
    ).toBeDefined();
    gate.released.resolve();
    const [original, replayed] = await Promise.all([first, duplicate]);
    expect(replayed).toEqual(original);
    expect(original.status).toBe("succeeded");
    expect(h.adapter.requests).toHaveLength(2);
    expect(
      h.ctx.agents.get(SessionId(String(options.sessionId))),
    ).toBeUndefined();
  });

  it.each(["redo", "cancel", "redo-publish-failure"] as const)(
    "%s stops a role still finishing after its artifact was committed",
    async (method) => {
      const gate = modelGate();
      const h = await host([{ kind: "save", afterSave: gate }]);
      const execution = h.dispatch("finishing");
      const options = await gate.started.promise;
      const claimed = { runId: h.runId, taskId: "analysis", attempt: 1 };
      const committed = h.runs.readAttempt(claimed).outputRefs;
      const failure = new Error("Fixture projection deletion failed");
      if (method === "redo-publish-failure") {
        const unlink = fs.unlinkSync;
        vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
          if (String(path).endsWith("/reports/analysis.md")) throw failure;
          unlink(path);
        });
      }
      let returned = false;
      const stop = (
        method === "cancel"
          ? h.bridge.cancel(h.operation, "cancel-finishing")
          : h.bridge.redo(h.operation, "analysis", "redo-finishing")
      )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        .finally(() => {
          returned = true;
        });
      await gate.aborted.promise;
      expect(returned).toBe(false);
      expect(h.runs.readAttempt(claimed).status).toBe(
        method === "cancel" ? "succeeded" : "invalidated",
      );
      expect(
        h.ctx.agents.get(SessionId(String(options.sessionId))),
      ).toBeDefined();
      vi.restoreAllMocks();
      gate.released.resolve();
      const [attempt, stopped] = await Promise.all([execution, stop]);
      expect(attempt.refs).toEqual(committed);
      expect(h.runs.readArtifact(committed[0]!).content).toEqual(analysis());
      expect(
        h.ctx.agents.get(SessionId(String(options.sessionId))),
      ).toBeUndefined();
      if (method === "redo-publish-failure") {
        expect(stopped).toMatchObject({
          status: "rejected",
          reason: { code: "STORAGE_FAILED", cause: failure },
        });
      } else {
        expect(stopped).toMatchObject({
          status: "fulfilled",
          value: { stopAttempts: [] },
        });
      }
    },
  );

  it("treats completion text without a report as failed and retries only under a new request", async () => {
    const h = await host([{ kind: "text" }, { kind: "save" }]);
    const failed = await h.dispatch("no-report");
    expect(failed).toMatchObject({
      attempt: 1,
      status: "failed",
      refs: [],
      failure: { code: "NO_ARTIFACT" },
    });
    expect(h.runs.view(h.operation).status).toBe("active");
    expect(await h.dispatch("no-report")).toEqual(failed);
    expect(h.adapter.requests).toHaveLength(1);
    expect(await h.dispatch("explicit-retry")).toMatchObject({
      attempt: 2,
      status: "succeeded",
    });
    expect(h.adapter.requests).toHaveLength(3);
  });

  it("retains the SDK diagnostic for a model error and retries only under a new request", async () => {
    const cause = new Error("Fixture provider rejected the request body");
    const error = new HarnessError(
      "Fixture model request failed",
      "INVALID_INPUT",
      { cause },
    );
    const h = await host([{ kind: "error", error }, { kind: "save" }]);
    const failed = await h.dispatch("model-error");
    expect(failed).toMatchObject({
      attempt: 1,
      status: "failed",
      refs: [],
      failure: { code: "INVALID_INPUT", message: error.message },
    });
    // The SDK reconstructs agent errors from serializable code/message, without raw cause.
    expect(failed.failure?.message).not.toContain(cause.message);
    const requestsAfterFailure = h.adapter.requests.length;
    expect(await h.dispatch("model-error")).toEqual(failed);
    expect(h.adapter.requests).toHaveLength(requestsAfterFailure);
    const retried = await h.dispatch("explicit-retry");
    expect(retried).toMatchObject({ attempt: 2, status: "succeeded" });
    expect(retried.sessionId).not.toBe(failed.sessionId);
    expect(h.runs.readArtifact(retried.refs[0]!).content).toMatchObject(
      analysis(),
    );
  });

  it("rejects service tasks, unmet dependencies and a running receipt with no local owner", async () => {
    const h = await host([]);
    await expect(h.dispatch("service", "digest")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(h.dispatch("unready", "dependent")).rejects.toMatchObject({
      code: "TASK_NOT_READY",
    });
    h.runs.dispatchForCall(
      h.operation,
      "analysis",
      JSON.stringify(["dispatch", "lost-owner"]),
    );
    await expect(h.dispatch("lost-owner")).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "analysis", attempt: 1 })
        .status,
    ).toBe("running");
    expect(h.adapter.requests).toHaveLength(0);
    expect(h.children.size).toBe(0);
  });

  it("invalidates before draining redo and does not stop or overwrite a replacement", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "wait", gate }, { kind: "save" }]);
    const old = h.dispatch("old");
    const options = await gate.started.promise;
    const child = h.children.get(String(options.sessionId))!;
    const oldOperation = taskOperation(h.bindings.require(child.agent));
    expect(h.runs.readAttempt(oldOperation).sessionId).toBe(child.agent.id);
    let redoReturned = false;
    const redo = h.bridge
      .redo(h.operation, "analysis", "redo-running")
      .then((value) => {
        redoReturned = true;
        return value;
      });
    await gate.aborted.promise;
    expect(h.runs.readAttempt(oldOperation)).toMatchObject({
      status: "invalidated",
      sessionId: child.agent.id,
    });
    expect(() =>
      h.artifacts.submitArtifact(oldOperation, [analysis()], "late-report"),
    ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
    expect(redoReturned).toBe(false);
    let replacementReturned = false;
    const pendingReplacement = h.dispatch("replacement").then((value) => {
      replacementReturned = true;
      return value;
    });
    await setImmediate();
    expect(replacementReturned).toBe(false);
    expect(
      h.runs.view(h.operation).tasks.find((task) => task.taskId === "analysis"),
    ).toMatchObject({ status: "pending", attempt: 1 });
    expect(h.adapter.requests).toHaveLength(1);
    gate.released.resolve();
    const [oldResult, redone, replacement] = await Promise.all([
      old,
      redo,
      pendingReplacement,
    ]);
    expect(oldResult).toMatchObject({ attempt: 1, status: "invalidated" });
    expect(redone).toMatchObject({
      stopAttempts: [{ taskId: "analysis", attempt: 1 }],
    });
    expect(replacement).toMatchObject({ attempt: 2, status: "succeeded" });
    expect(
      await h.bridge.redo(h.operation, "analysis", "redo-running"),
    ).toEqual(redone);
    expect(h.runs.readAttempt(replacement)).toMatchObject({
      status: "succeeded",
      outputRefs: replacement.refs,
    });
    expect(h.ctx.agents.get(child.agent.id)).toBeUndefined();
    expect(h.adapter.requests).toHaveLength(3);
  });

  it("keeps independent tasks isolated when one caller cancels", async () => {
    const gate = modelGate();
    const h = await host([{ kind: "wait", gate }, { kind: "save" }]);
    const controller = new AbortController();
    const waiting = h.dispatch("waiting", "analysis", controller.signal);
    const options = await gate.started.promise;
    const parallel = h.dispatch("parallel", "parallel");
    controller.abort(new DOMException("Caller cancelled", "AbortError"));
    await gate.aborted.promise;
    const completed = await parallel;
    expect(completed).toMatchObject({
      taskId: "parallel",
      attempt: 1,
      status: "succeeded",
    });
    expect(
      h.runs.readAttempt({ runId: h.runId, taskId: "analysis", attempt: 1 })
        .sessionId,
    ).toBe(options.sessionId);
    gate.released.resolve();
    expect(await waiting).toMatchObject({
      taskId: "analysis",
      status: "failed",
    });
    expect(h.runs.readAttempt(completed)).toMatchObject({
      status: "succeeded",
      outputRefs: completed.refs,
    });
    expect(h.adapter.requests).toHaveLength(3);
  });

  it.each(["cancel", "close"] as const)(
    "%s waits for owned model work to stop before returning",
    async (method) => {
      const gate = modelGate();
      const h = await host([{ kind: "wait", gate }]);
      const execution = h.dispatch("waiting");
      const options = await gate.started.promise;
      const child = h.children.get(String(options.sessionId))!;
      const operation = taskOperation(h.bindings.require(child.agent));
      expect(h.runs.readAttempt(operation).sessionId).toBe(child.agent.id);
      let stopReturned = false;
      const stop = (
        method === "cancel"
          ? h.bridge.cancel(h.operation, "cancel")
          : h.bridge.close()
      ).then((value) => {
        stopReturned = true;
        return value;
      });
      await gate.aborted.promise;
      expect(stopReturned).toBe(false);
      expect(h.ctx.agents.get(child.agent.id)).toBe(child.agent);
      if (method === "cancel") {
        expect(h.runs.view(h.operation).status).toBe("cancelled");
        expect(h.runs.readAttempt(operation)).toMatchObject({
          status: "cancelled",
          sessionId: child.agent.id,
        });
        expect(() =>
          h.artifacts.submitArtifact(operation, [analysis()], "late-report"),
        ).toThrowError(expect.objectContaining({ code: "STALE_ATTEMPT" }));
      } else {
        await expect(
          h.dispatch("after-close", "parallel"),
        ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      }
      gate.released.resolve();
      await stop;
      expect(await execution).toMatchObject({
        status: method === "cancel" ? "cancelled" : "failed",
      });
      expect(h.ctx.agents.get(child.agent.id)).toBeUndefined();
      expect(h.ctx.sessions.get(child.agent.id)).toBeUndefined();
    },
  );

  it("preserves a real child creation failure and its cause while failing the attempt", async () => {
    const h = await host([]);
    const cause = new Error("Fixture preset service unavailable");
    const failure = new Error("Child creation listener failed", { cause });
    h.ctx.on("agent/created", ({ agent }) => {
      if (agent.session.header.origin === "subagent") throw failure;
      return undefined;
    });
    await expect(h.dispatch("startup-failure")).rejects.toBe(failure);
    expect(failure.cause).toBe(cause);
    const attempt = h.runs.readAttempt({
      runId: h.runId,
      taskId: "analysis",
      attempt: 1,
    });
    const child = [...h.children.values()][0]!;
    expect(attempt).toMatchObject({
      status: "failed",
      sessionId: child.agent.id,
      failure: { code: "HOST_FAILED", message: failure.message },
    });
    expect(h.ctx.agents.get(child.agent.id)).toBeUndefined();
    expect(h.ctx.sessions.get(child.agent.id)).toBeUndefined();
    expect(() => h.bindings.require(child.agent)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    expect(h.adapter.requests).toHaveLength(0);
  });

  it("enforces coordinator run authorization and closed control parameters through the SDK", async () => {
    const h = await host([]);
    const args = {
      runId: h.runId,
      taskId: "analysis",
      requestId: "unauthorized",
    };
    const ask = await h.ctx.agents.create({
      sessionId: SessionId("ask"),
      agentOptions: { provider: "fixture", model: "dispatch-fixture" },
    });
    h.bindings.bind(ask.agent, { kind: "ask", scope: h.scope });
    for (const name of ["stock_dispatch_task", "stock_redo_task"]) {
      expect(await h.call(name, args, ask.agent)).toMatchObject({
        isError: true,
        error: { info: { code: "ACCESS_DENIED" } },
      });
    }
    expect(
      await h.call("stock_dispatch_task", { ...args, runId: "another-run" }),
    ).toMatchObject({
      isError: true,
      error: { info: { code: "ACCESS_DENIED" } },
    });
    expect(
      await h.call("stock_dispatch_task", {
        ...args,
        agentPreset: "arbitrary",
      }),
    ).toMatchObject({
      isError: true,
      error: { info: { code: "INVALID_INPUT" } },
    });
    expect(
      h.runs.view(h.operation).tasks.every((task) => task.status === "pending"),
    ).toBe(true);
    expect(h.adapter.requests).toHaveLength(0);
  });
});

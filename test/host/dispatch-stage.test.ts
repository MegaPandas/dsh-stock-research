import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { DispatchBridge } from "../../src/host/dispatch.js";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import {
  dispatchHost,
  modelGate,
  type ModelScript,
} from "../fixtures/dispatch-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function host(
  scripts: ModelScript[] = [{ kind: "save" }, { kind: "save" }],
) {
  const h = await dispatchHost(
    scripts.map((script, index) =>
      script.kind === "save"
        ? {
            ...script,
            artifact: {
              kind: "debate",
              title: "Stage debate",
              body: "Fixed qualitative argument.",
              inputRefs: [],
              claims: [],
              payload: {
                side: index === 1 ? "bear" : "bull",
                arguments: [
                  { text: "A supported argument.", evidence: [], numbers: [] },
                ],
                rebuttals: [],
                unresolved: [],
              },
            } satisfies ResearchArtifactInput,
          }
        : script,
    ),
  );
  cleanups.push(h.close);
  const tasks = ["debate.1.bull", "debate.1.bear"].map((id) => ({
    id,
    executor: {
      kind: "role" as const,
      role: "discussion" as const,
      specialty: id.endsWith("bull") ? "bull" : "bear",
    },
    dependsOn: [],
    inputTasks: [],
    outputKinds: ["debate" as const],
    dataRequirements: [],
    instructionVersion: 1,
  }));
  const { runId } = h.runs.open(
    "stage-owner",
    {
      definition: {
        scope: h.scope,
        mode: "quick",
        tasks,
        stages: [
          {
            id: "debate.1",
            taskIds: tasks.map(({ id }) => id),
            beforeTasks: [],
          },
        ],
      },
      versions: {
        plugin: "fixture",
        mode: "fixture",
        prompts: {},
        skills: {},
        adapters: {},
        normalization: {},
      },
      inputs: [],
    },
    "open-stage",
  );
  const parent = await h.ctx.agents.create({
    sessionId: SessionId("stage-parent"),
    agentOptions: { provider: "fixture", model: "dispatch-fixture" },
  });
  h.bindings.bind(parent.agent, { kind: "coordinator", runIds: [runId] });
  return {
    ...h,
    runId,
    parent,
    call: (
      name: string,
      value: unknown,
      signal = new AbortController().signal,
    ) => h.call(name, value, parent.agent, signal),
  };
}

describe("stage dispatch", () => {
  it("starts independent roles before either finishes and replays one batch", async () => {
    const first = modelGate();
    const second = modelGate();
    const h = await host([
      { kind: "wait", gate: first },
      { kind: "wait", gate: second },
    ]);
    const args = { runId: h.runId, stageId: "debate.1", requestId: "pair" };
    const work = h.call("stock_dispatch_stage", args);
    const replay = h.call("stock_dispatch_stage", args);
    await Promise.all([first.started.promise, second.started.promise]);
    expect(h.prepared.map(({ claim }) => claim.taskId).sort()).toEqual([
      "debate.1.bear",
      "debate.1.bull",
    ]);
    expect(
      h.runs
        .view({ runId: h.runId })
        .tasks.every(({ status }) => status === "running"),
    ).toBe(true);
    first.released.resolve();
    second.released.resolve();
    const [result, same] = await Promise.all([work, replay]);
    expect(result).toEqual(same);
    expect(h.prepared).toHaveLength(2);
    expect(result).toMatchObject({
      isError: false,
      value: {
        stageId: "debate.1",
        results: [{ taskId: "debate.1.bull" }, { taskId: "debate.1.bear" }],
      },
    });
    expect(
      await h.call("stock_dispatch_stage", { ...args, stageId: "other" }),
    ).toMatchObject({ isError: true });
  });

  it("rejects scalar dispatch for a ready pair without starting either role", async () => {
    const h = await host();
    const rejected = await h.call("stock_dispatch_task", {
      runId: h.runId,
      taskId: "debate.1.bull",
      requestId: "single",
    });
    expect(JSON.stringify(rejected)).toContain("stock_dispatch_stage");
    expect(h.prepared).toEqual([]);
    expect(
      h.runs
        .view({ runId: h.runId })
        .tasks.every(({ status }) => status === "pending"),
    ).toBe(true);
  });

  it("returns a successful peer when another role fails", async () => {
    const h = await host([{ kind: "save" }, { kind: "text" }]);
    const result = await h.call("stock_dispatch_stage", {
      runId: h.runId,
      stageId: "debate.1",
      requestId: "partial",
    });
    expect(result).toMatchObject({
      isError: false,
      value: {
        results: [
          { status: "succeeded" },
          { status: "failed", failure: { code: "NO_ARTIFACT" } },
        ],
      },
    });
    expect(h.ctx.agents.list()).toContain(h.parent.agent);
    expect(
      h.ctx.agents
        .list()
        .filter(({ session }) => session.header.origin === "subagent"),
    ).toEqual([]);
  });

  it("allows a single-sided revision after the pair has finished", async () => {
    const h = await host([
      { kind: "save" },
      { kind: "save" },
      { kind: "save" },
    ]);
    await h.call("stock_dispatch_stage", {
      runId: h.runId,
      stageId: "debate.1",
      requestId: "pair",
    });
    await h.bridge.redo(
      { runId: h.runId, identity: h.parent.agent.id },
      "debate.1.bull",
      "redo-bull",
    );
    expect(
      await h.call("stock_dispatch_task", {
        runId: h.runId,
        taskId: "debate.1.bull",
        requestId: "revised-bull",
      }),
    ).toMatchObject({
      isError: false,
      value: { taskId: "debate.1.bull", attempt: 2, status: "succeeded" },
    });
  });

  it("replays completed task claims after replacing the dispatch bridge", async () => {
    const h = await host();
    const original = await h.bridge.dispatchStage(
      h.parent.agent,
      h.runId,
      "debate.1",
      "durable",
      new AbortController().signal,
    );
    const fresh = new DispatchBridge(
      h.ctx,
      h.runs,
      h.sessions,
      () => {
        throw new Error("A replay must not prepare another role");
      },
      h.digests,
    );
    cleanups.push(() => fresh.close());
    expect(
      await fresh.dispatchStage(
        h.parent.agent,
        h.runId,
        "debate.1",
        "durable",
        new AbortController().signal,
      ),
    ).toEqual(original);
    expect(h.prepared).toHaveLength(2);
    expect(() =>
      fresh.dispatchStage(
        h.parent.agent,
        h.runId,
        "another",
        "durable",
        new AbortController().signal,
      ),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
    await h.bridge.redo(
      { runId: h.runId, identity: h.parent.agent.id },
      "debate.1.bull",
      "redo-both-bull",
    );
    await h.bridge.redo(
      { runId: h.runId, identity: h.parent.agent.id },
      "debate.1.bear",
      "redo-both-bear",
    );
    const originalTaskRequest = JSON.stringify([
      "stage",
      "debate.1",
      "durable",
      "debate.1.bull",
    ]);
    expect(
      await h.call("stock_dispatch_task", {
        runId: h.runId,
        taskId: "debate.1.bull",
        requestId: originalTaskRequest,
      }),
    ).toMatchObject({
      isError: false,
      value: { status: "invalidated", attempt: 1 },
    });
    expect(h.prepared).toHaveLength(2);
  });

  it("does not start peers after an interrupted partial claim", async () => {
    const h = await host();
    const operation = { runId: h.runId, identity: h.parent.agent.id };
    h.runs.recordStageDispatch(operation, "debate.1", "interrupted");
    const taskRequestId = JSON.stringify([
      "stage",
      "debate.1",
      "interrupted",
      "debate.1.bull",
    ]);
    h.runs.dispatchForCall(
      operation,
      "debate.1.bull",
      JSON.stringify(["dispatch", taskRequestId]),
    );
    expect(
      await h.call("stock_dispatch_stage", {
        runId: h.runId,
        stageId: "debate.1",
        requestId: "interrupted",
      }),
    ).toMatchObject({ isError: true });
    expect(h.prepared).toEqual([]);
    expect(
      h.runs
        .view({ runId: h.runId })
        .tasks.find(({ taskId }) => taskId === "debate.1.bear")!.status,
    ).toBe("pending");
  });

  it("validates stage and run access before starting children", async () => {
    const h = await host();
    for (const args of [
      { runId: h.runId, stageId: "missing", requestId: "unknown" },
      { runId: "unbound", stageId: "debate.1", requestId: "outside" },
      {
        runId: h.runId,
        stageId: "debate.1",
        requestId: "extra",
        taskId: "debate.1.bull",
      },
    ])
      expect(await h.call("stock_dispatch_stage", args)).toMatchObject({
        isError: true,
      });
    expect(h.prepared).toEqual([]);
  });

  it("cancels and drains every child in the batch", async () => {
    const first = modelGate();
    const second = modelGate();
    const h = await host([
      { kind: "wait", gate: first },
      { kind: "wait", gate: second },
    ]);
    const controller = new AbortController();
    const work = h.bridge.dispatchStage(
      h.parent.agent,
      h.runId,
      "debate.1",
      "cancel",
      controller.signal,
    );
    await Promise.all([first.started.promise, second.started.promise]);
    controller.abort(new DOMException("Stop the batch", "AbortError"));
    await Promise.all([first.aborted.promise, second.aborted.promise]);
    first.released.resolve();
    second.released.resolve();
    await work;
    expect(
      h.ctx.agents
        .list()
        .filter(({ session }) => session.header.origin === "subagent"),
    ).toEqual([]);
    expect(
      h.runs
        .view({ runId: h.runId })
        .tasks.every(({ status }) => status !== "running"),
    ).toBe(true);
  });
});

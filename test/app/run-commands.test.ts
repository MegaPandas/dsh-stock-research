import { setImmediate } from "node:timers/promises";
import {
  agentAnalysisReport,
  reportSubmission,
} from "../fixtures/analysis-report.js";
import { valuationRecord } from "../fixtures/valuation.js";
import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Quick from "../../src/quick.js";
import { createQuickInput } from "../../src/app/quick-plan.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import type { OpenRunInput } from "../../src/contracts/runs.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { analysis } from "../fixtures/dispatch-host.js";
import {
  initialInput,
  lastToolResult,
  quickHost,
  toolCall,
} from "../fixtures/quick-host.js";
import { deferred, gate, textResponse } from "../fixtures/runtime-host.js";
import {
  isMainResearchRequest,
  mainResearchRequest,
} from "../fixtures/research-workflow.js";

const cleanups: (() => Promise<void>)[] = [];
const fetch = vi.fn(async (): Promise<Response> => {
  throw new Error("Run control must not request network data");
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});
async function host(
  respond: Parameters<typeof quickHost>[0] = () =>
    textResponse("Stopped without claiming completion."),
) {
  const h = await quickHost(respond);
  cleanups.push(h.close);
  return h;
}
type Host = Awaited<ReturnType<typeof host>>;
const savedPrompt =
  "Saved custom coordinator policy: preserve completed analysis and fixed refs.";
const scope: ResearchScope = {
  security: {
    id: "CN:002594.SZ",
    market: "CN",
    symbol: "002594.SZ",
    exchange: "SZ",
    currency: "CNY",
    timeZone: "Asia/Shanghai",
  },
  date: "2024-01-03",
  cutoff: "2024-01-03T15:59:59.999Z",
};
function seed(h: Host, modify?: (input: OpenRunInput) => void) {
  const input = createQuickInput(scope, h.runtime.policy, []);
  input.inputs.find((input) => input.name === "prompt:coordinator")!.content =
    savedPrompt;
  const fundamentals = input.definition.tasks.find(
    (task) => task.id === "analysis.fundamentals",
  )!;
  fundamentals.dependsOn = ["analysis.market"];
  fundamentals.inputTasks = ["analysis.market"];
  modify?.(input);
  const { runId } = h.runtime.runs.open("seed-owner", input, "seed-open");
  const operation = { runId, identity: "seed-owner" };
  const claim = h.runtime.runs.claim(
    operation,
    "analysis.market",
    "seed-market",
  );
  const marketRef = new ArtifactService(
    h.runtime.runs,
    new NumberService(h.runtime.runs),
  ).submitArtifact(
    { ...claim, identity: "seed-worker", sessionId: null },
    [analysis()],
    "seed-save",
  ).refs[0]!;
  h.runtime.runs.block(
    operation,
    [
      {
        code: "USER_REVIEW",
        message: "Confirm the updated fundamentals instruction.",
        taskId: "analysis.fundamentals",
        attempt: null,
      },
      {
        code: "SOURCE_REVIEW",
        message: "Confirm the retained source limitations.",
        taskId: null,
        attempt: null,
      },
    ],
    "seed-block",
  );
  return {
    runId,
    marketRef,
    reasons: h.runtime.runs.view(operation).blockReasons,
  };
}
interface RoleInput {
  scope: ResearchScope;
  task: { id: string; role: string; objective: string };
  context: { materials: { title: string; body?: string }[] };
}
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (reason: unknown) => ({ kind: "rejected" as const, reason }),
  );
}

describe("explicit run control commands", () => {
  it("resumes through the model tool with task revisions and retains completed artifacts", async () => {
    const h = await host();
    const seeded = seed(h);
    const result = await h.ctx.tools.execute({
      agent: h.outside.agent,
      callId: ToolCallId("resume-tool"),
      name: "stock_resume_research",
      arguments: {
        runId: seeded.runId,
        requestId: "resume-tool",
        input: {
          resolvedReasonIds: seeded.reasons.map(({ id }) => id),
          instructions: [
            {
              taskId: "analysis.fundamentals",
              instruction: "Reconcile the retained financial evidence.",
            },
          ],
        },
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      isError: false,
      value: { runId: seeded.runId },
    });
    const view = h.runtime.runs.view({ runId: seeded.runId });
    expect(view.status).toBe("active");
    expect(view.blockReasons).toEqual([]);
    expect(
      view.tasks.find(({ taskId }) => taskId === "analysis.market")!.outputRefs,
    ).toEqual([seeded.marketRef]);
    const revision = h.runtime.runs
      .inputCatalog(seeded.runId)
      .inputs.findLast(
        ({ name }) => name === "instruction:analysis.fundamentals",
      )!;
    expect(h.runtime.runs.readInput(seeded.runId, revision.ref)).toMatchObject({
      taskId: "analysis.fundamentals",
      instruction: "Reconcile the retained financial evidence.",
    });
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.adapter.requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed model resume input without changing a run", async () => {
    const h = await host();
    const seeded = seed(h);
    const before = h.runtime.runs.view({ runId: seeded.runId });
    const result = await h.ctx.tools.execute({
      agent: h.outside.agent,
      callId: ToolCallId("bad-resume-tool"),
      name: "stock_resume_research",
      arguments: {
        runId: seeded.runId,
        requestId: "bad-resume-tool",
        input: { resolvedReasonIds: [], taskNotes: [] },
      },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(h.runtime.runs.view({ runId: seeded.runId })).toEqual(before);
    expect(h.adapter.requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["4", "5", "6", "7", "8", "9"])(
    "resumes coordinator version %s after plugin restart and reuses successful fixed inputs",
    async (version) => {
      const roles: RoleInput[] = [];
      let coordinatorCalls = 0;
      const h = await host(async function* (request) {
        if (isMainResearchRequest(request)) {
          const input = mainResearchRequest(request);
          if (++coordinatorCalls === 1)
            yield* toolCall("stock_dispatch_task", {
              runId: input.runId,
              taskId: "analysis.fundamentals",
              requestId: `${input.operationId}:analysis.fundamentals`,
            });
          else
            yield* textResponse(
              "Fundamentals submitted; remaining mandatory research is incomplete.",
            );
        } else if (request.messages.some((message) => message.role === "tool"))
          yield* textResponse("Submitted canonical analysis.");
        else {
          const input = initialInput<RoleInput>(request);
          roles.push(input);
          const report = agentAnalysisReport();
          report.content.valuation = valuationRecord(
            input.scope.date,
            input.scope.security.currency,
          );
          yield* reportSubmission(report, "save-fundamentals");
        }
      });
      const seeded = seed(h, (input) => {
        input.versions.prompts.coordinator = version;
      });
      await h.quickFiber.dispose();
      const restarted = h.ctx.plugin(Quick, {
        provider: "runtime-fixture",
        model: "quick",
      });
      await restarted;
      cleanups.push(() => restarted.dispose());
      const result = await h.executeAndWait(
        `/stock-resume ${seeded.runId} ${JSON.stringify({ resolvedReasonIds: seeded.reasons.map((reason) => reason.id), instructions: [{ taskId: "analysis.fundamentals", instruction: "Read only the fixed successful market analysis." }] })}`,
      );
      expect(result?.result.kind).toBe("error");
      expect(roles).toHaveLength(1);
      expect(roles[0]).toMatchObject({
        task: {
          id: "analysis.fundamentals",
          objective: "Read only the fixed successful market analysis.",
        },
        context: {
          materials: [{ title: analysis().title, body: analysis().body }],
        },
      });
      expect(roles[0]).not.toHaveProperty("inputRefs");
      const view = h.runtime.runs.view({ runId: seeded.runId });
      expect(view.scope).toEqual(scope);
      expect(
        view.tasks.find((task) => task.taskId === "analysis.market"),
      ).toMatchObject({
        status: "succeeded",
        attempt: 1,
        outputRefs: [seeded.marketRef],
      });
      expect(
        view.tasks.find((task) => task.taskId === "analysis.fundamentals")!
          .status,
      ).toBe("succeeded");
      const fundamentalsRef = view.tasks.find(
        (task) => task.taskId === "analysis.fundamentals",
      )!.outputRefs[0]!;
      expect(
        h.runtime.runs.readArtifact(fundamentalsRef).content.inputRefs,
      ).toEqual([seeded.marketRef]);
      const coordinator = h.adapter.requests[0]!;
      const saved = h.runtime.runs
        .inputCatalog(seeded.runId)
        .inputs.find(({ name }) => name === "prompt:coordinator")!;
      expect(h.runtime.runs.readInput(seeded.runId, saved.ref)).toBe(
        savedPrompt,
      );
      expect(coordinator.sessionId).toBe(h.outside.agent.id);
      expect(coordinator.tools!.map((tool) => tool.name).sort()).toEqual(
        expect.arrayContaining(
          [
            "stock_read_run",
            "stock_data_health",
            "stock_dispatch_task",
            "stock_make_digest",
            "stock_decide",
          ].sort(),
        ),
      );
      expect(mainResearchRequest(coordinator)).toMatchObject({
        runId: seeded.runId,
        view: expect.objectContaining({ scope }),
        kind: "resume",
      });
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("cancels an existing run while subagent publication is still awaiting the host", async () => {
    let call = 0;
    const h = await host(async function* (request) {
      if (!isMainResearchRequest(request))
        throw new Error("Cancelled child must not call the model.");
      if (++call === 1)
        yield* toolCall("stock_dispatch_task", {
          runId: mainResearchRequest(request).runId,
          taskId: "analysis.fundamentals",
          requestId: "fundamentals",
        });
      else yield* textResponse("研究已取消。");
    });
    const seeded = seed(h);
    const started = deferred<void>();
    const released = deferred<void>();
    cleanups.push(async () => released.resolve());
    h.ctx.on("agent/created", async ({ agent }) => {
      if (agent.session.header.origin !== "subagent") return undefined;
      started.resolve();
      await released.promise;
      return undefined;
    });
    const controller = new AbortController();
    const work = observe(
      h.executeAndWait(
        `/stock-resume ${seeded.runId} ${JSON.stringify({ resolvedReasonIds: seeded.reasons.map((reason) => reason.id), instructions: [] })}`,
        controller.signal,
      ),
    );
    await started.promise;
    const cancel = h.execute(`/stock-cancel ${seeded.runId}`);
    await setImmediate();
    expect(h.runtime.runs.view({ runId: seeded.runId }).status).toBe(
      "cancelled",
    );
    let unloaded = false;
    const unloading = h.quickFiber.dispose().then(() => {
      unloaded = true;
    });
    await setImmediate();
    expect(unloaded).toBe(false);
    released.resolve();
    await Promise.all([work, cancel, unloading]);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(
      h.adapter.requests.every(
        ({ sessionId }) => sessionId === h.outside.agent.id,
      ),
    ).toBe(true);
    expect(h.runtime.runs.readArtifact(seeded.marketRef).content.kind).toBe(
      "analysis",
    );
  });

  it("reports stable reason IDs and attempts, and does not start a model while a reason remains", async () => {
    const h = await host();
    const seeded = seed(h);
    const status = await h.executeAndWait(`/stock-status ${seeded.runId}`);
    expect(status?.result.kind).toBe("success");
    for (const reason of seeded.reasons)
      expect(status?.result.text).toContain(reason.id);
    expect(status?.result.text).toContain("analysis.fundamentals #0");
    const result = await h.executeAndWait(
      `/stock-resume ${seeded.runId} ${JSON.stringify({ resolvedReasonIds: [seeded.reasons[0]!.id], instructions: [] })}`,
    );
    expect(result?.result.kind).toBe("error");
    expect(result?.result.text).toContain(seeded.reasons[1]!.id);
    expect(h.adapter.requests).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.runtime.runs.view({ runId: seeded.runId }).status).toBe("blocked");
  });

  it("drains old producer work across overlapping redo and resume while retaining the main Agent", async () => {
    const producer = gate<GenerateOptions>();
    const coordinatorIds: string[] = [];
    const h = await host(async function* (request) {
      if (!isMainResearchRequest(request)) {
        const aborted = () => producer.aborted.resolve();
        request.signal?.addEventListener("abort", aborted, { once: true });
        producer.started.resolve(request);
        try {
          await producer.released.promise;
          request.signal?.throwIfAborted();
          yield* textResponse("Old role stopped.");
        } finally {
          request.signal?.removeEventListener("abort", aborted);
        }
      } else {
        coordinatorIds.push(String(request.sessionId));
        yield* textResponse("后续研究任务待继续执行。");
      }
    });
    const seeded = seed(h);
    h.runtime.runs.resume(
      { runId: seeded.runId, identity: "seed-owner" },
      {
        resolvedReasonIds: seeded.reasons.map((reason) => reason.id),
        instructions: [],
      },
      "seed-unblock",
    );
    const parent = await h.runtime.createAgent(
      h.agentOptions("external-coordinator"),
      { kind: "coordinator", runIds: [seeded.runId] },
      [],
    );
    cleanups.push(async () => {
      producer.released.resolve();
      await parent.dispose();
    });
    const old = observe(
      h.runtime.dispatch.dispatch(
        parent.agent,
        seeded.runId,
        "analysis.fundamentals",
        "old-fundamentals",
        new AbortController().signal,
      ),
    );
    await producer.started.promise;
    const redo = observe(
      h.executeAndWait(`/stock-redo ${seeded.runId} analysis.fundamentals`),
    );
    await producer.aborted.promise;
    const resume = observe(
      h.executeAndWait(
        `/stock-resume ${seeded.runId} {"resolvedReasonIds":[],"instructions":[]}`,
      ),
    );
    await setImmediate();
    expect(coordinatorIds.every((id) => id === h.outside.agent.id)).toBe(true);
    producer.released.resolve();
    await Promise.all([old, redo, resume]);
    expect(new Set(coordinatorIds).size).toBe(1);
    expect(
      h.runtime.runs
        .view({ runId: seeded.runId })
        .tasks.find((task) => task.taskId === "analysis.market")!.outputRefs,
    ).toEqual([seeded.marketRef]);
    await parent.dispose();
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["bad-json", "scope", "attempt"] as const)(
    "rejects %s at the command boundary without a write or model request",
    async (problem) => {
      const h = await host();
      const seeded = seed(h);
      const before = h.runtime.runs.view({ runId: seeded.runId });
      const line =
        problem === "bad-json"
          ? `/stock-resume ${seeded.runId} {`
          : problem === "scope"
            ? `/stock-resume ${seeded.runId} {"resolvedReasonIds":[],"instructions":[],"scope":{}}`
            : `/stock-recover ${seeded.runId} [{"taskId":"analysis.fundamentals","attempt":0}]`;
      await expect(h.executeAndWait(line)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(h.runtime.runs.view({ runId: seeded.runId })).toEqual(before);
      expect(h.adapter.requests).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "old", "corrupt"] as const)(
    "does not substitute current prompts for %s saved coordinator input",
    async (problem) => {
      const h = await host();
      const seeded = seed(h, (input) => {
        if (problem === "missing")
          input.inputs = input.inputs.filter(
            (input) => input.name !== "prompt:coordinator",
          );
        else if (problem === "old") input.versions.prompts.coordinator = "1";
        else
          input.inputs.find(
            (input) => input.name === "prompt:coordinator",
          )!.content = { invalid: true };
      });
      const before = h.runtime.runs.view({ runId: seeded.runId });
      await expect(
        h.executeAndWait(
          `/stock-resume ${seeded.runId} {"resolvedReasonIds":[],"instructions":[]}`,
        ),
      ).rejects.toMatchObject({
        code: problem === "corrupt" ? "STORAGE_FAILED" : "VERSION_UNAVAILABLE",
      });
      expect(h.runtime.runs.view({ runId: seeded.runId })).toEqual(before);
      expect(h.adapter.requests).toEqual([]);
    },
  );

  it("records explicitly confirmed interruption without dispatching a model", async () => {
    const h = await host();
    const seeded = seed(h);
    const operation = { runId: seeded.runId, identity: "previous-host" };
    h.runtime.runs.resume(
      operation,
      {
        resolvedReasonIds: seeded.reasons.map((reason) => reason.id),
        instructions: [],
      },
      "unblock-before-loss",
    );
    const attempt = h.runtime.runs.claim(
      operation,
      "analysis.fundamentals",
      "lost-fundamentals",
    );
    const result = await h.executeAndWait(
      `/stock-recover ${seeded.runId} [{"taskId":"analysis.fundamentals","attempt":${attempt.attempt}}]`,
    );
    expect(result?.result.kind).toBe("success");
    expect(h.runtime.runs.readAttempt(attempt)).toMatchObject({
      status: "failed",
      failure: { code: "HOST_INTERRUPTED" },
    });
    expect(
      h.runtime.runs
        .view(operation)
        .tasks.find((task) => task.taskId === "analysis.market")!.outputRefs,
    ).toEqual([seeded.marketRef]);
    expect(h.adapter.requests).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("cancels without a model and rejects resume of that terminal run unchanged", async () => {
    const h = await host();
    const seeded = seed(h);
    expect(
      (await h.executeAndWait(`/stock-cancel ${seeded.runId}`))?.result.kind,
    ).toBe("success");
    const before = h.runtime.runs.view({ runId: seeded.runId });
    expect(before.status).toBe("cancelled");
    await expect(
      h.executeAndWait(
        `/stock-resume ${seeded.runId} {"resolvedReasonIds":[],"instructions":[]}`,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(h.runtime.runs.view({ runId: seeded.runId })).toEqual(before);
    expect(h.runtime.runs.readArtifact(seeded.marketRef).content).toEqual(
      analysis(),
    );
    expect(h.adapter.requests).toEqual([]);
  });
});

async function* parallelDispatch(runId: string): AsyncIterable<StreamChunk> {
  for (const [index, taskId] of [
    "analysis.market",
    "analysis.fundamentals",
  ].entries()) {
    const id = ToolCallId(taskId);
    const args = JSON.stringify({ runId, taskId, requestId: taskId });
    yield { type: "block-start", index, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index,
      id,
      name: "stock_dispatch_task",
      argumentsDelta: args,
    };
    yield {
      type: "block-end",
      index,
      block: {
        type: "tool-call",
        id,
        name: "stock_dispatch_task",
        arguments: args,
      },
    };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

describe("run commands during real producers", () => {
  it.each(["redo", "cancel", "redo-cancel"] as const)(
    "%s waits for producers, preserves independent work and retains coordinator ownership",
    async (action) => {
      const market = gate<GenerateOptions>();
      const fundamentals = gate<GenerateOptions>();
      let runId: string | undefined;
      let rootId: string | undefined;
      let coordinatorCalls = 0;
      let marketReleased = false;
      let fundamentalsReleased = false;
      let fundamentalsAborted = false;
      const attempts: (RoleInput & { task: { attempt: number } })[] = [];
      const coordinatorIds: string[] = [];
      const handledControls = new Set<string>();
      async function* wait(
        request: GenerateOptions,
        pause: ReturnType<typeof gate<GenerateOptions>>,
        released: () => void,
      ): AsyncIterable<StreamChunk> {
        const aborted = () => {
          pause.aborted.resolve();
        };
        request.signal?.addEventListener("abort", aborted, { once: true });
        pause.started.resolve(request);
        try {
          await pause.released.promise;
          request.signal?.throwIfAborted();
          yield* textResponse("Independent submitted work drained.");
        } finally {
          released();
          request.signal?.removeEventListener("abort", aborted);
        }
      }
      const h = await host(async function* (request) {
        if (isMainResearchRequest(request)) {
          coordinatorIds.push(String(request.sessionId));
          rootId = String(request.sessionId);
          if (++coordinatorCalls === 1)
            yield* toolCall("stock_start_research", {
              security: "SZ.002594",
              date: "2024-01-03",
              mode: "quick",
              requestId: "open",
            });
          else if (coordinatorCalls === 2) {
            runId = lastToolResult<{ runId: string }>(request).runId;
            yield* parallelDispatch(runId);
          } else {
            const update = mainResearchRequest(request);
            if (
              update.kind === "redo" &&
              !handledControls.has(update.operationId!)
            ) {
              handledControls.add(update.operationId!);
              yield* toolCall("stock_dispatch_task", {
                runId,
                taskId: "analysis.market",
                requestId: `${update.operationId}:analysis.market`,
              });
            } else
              yield* textResponse(
                "本次控制操作已处理，后续研究任务待继续执行。",
              );
          }
          return;
        }
        const role = initialInput<RoleInput>(request);
        const saved = request.messages.some(
          (message) => message.role === "tool",
        );
        const attempt = h.runtime.runs
          .view({ runId: runId! })
          .tasks.find((task) => task.taskId === role.task.id)!.attempt;
        const recordedInput = { ...role, task: { ...role.task, attempt } };
        if (role.task.id === "analysis.market" && attempt === 1) {
          attempts.push(recordedInput);
          yield* wait(request, market, () => {
            marketReleased = true;
          });
          return;
        }
        if (role.task.id === "analysis.fundamentals" && !saved) {
          const agent = h.ctx.agents
            .list()
            .find((agent) => agent.id === request.sessionId)!;
          agent.ctx.effect(() => async () => {
            fundamentals.started.resolve(request);
            try {
              await fundamentals.released.promise;
            } finally {
              fundamentalsReleased = true;
            }
          });
        }
        if (saved) {
          yield* textResponse("New attempt submitted.");
          return;
        }
        attempts.push(recordedInput);
        const report = agentAnalysisReport();
        if (role.task.id === "analysis.fundamentals")
          report.content.valuation = valuationRecord(
            role.scope.date,
            role.scope.security.currency,
          );
        yield* reportSubmission(report, "save");
      });
      const startActivation = h.ctx.subagents.startActivation.bind(
        h.ctx.subagents,
      );
      vi.spyOn(h.ctx.subagents, "startActivation").mockImplementation(
        (spec) => {
          if (spec.label?.startsWith("analysis.fundamentals"))
            spec.signal?.addEventListener(
              "abort",
              () => {
                fundamentalsAborted = true;
                fundamentals.aborted.resolve();
              },
              { once: true },
            );
          return startActivation(spec);
        },
      );
      cleanups.push(async () => {
        market.released.resolve();
        fundamentals.released.resolve();
      });
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              sz002594: {
                day: [["2024-01-03", "190", "192", "193", "189", "100"]],
              },
            },
          }),
        ),
      );
      fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
      fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
      const initial = observe(h.executeAndWait());
      await Promise.all([market.started.promise, fundamentals.started.promise]);
      const priorFundamentals = h.runtime.runs
        .view({ runId: runId! })
        .tasks.find(
          (task) => task.taskId === "analysis.fundamentals",
        )!.outputRefs;
      expect(priorFundamentals).toHaveLength(1);
      let finished = false;
      const control = observe(
        h.executeAndWait(
          action === "cancel"
            ? `/stock-cancel ${runId}`
            : `/stock-redo ${runId} analysis.market Revised user request`,
        ),
      ).then((result) => {
        finished = true;
        return result;
      });
      await market.aborted.promise;
      const overlappingCancel =
        action === "redo-cancel"
          ? observe(h.executeAndWait(`/stock-cancel ${runId}`))
          : undefined;
      await setImmediate();
      expect(finished).toBe(false);
      expect(marketReleased).toBe(false);
      expect(fundamentalsReleased).toBe(false);
      expect(
        h.ctx.agents.list().some((agent) => String(agent.id) === rootId),
      ).toBe(true);
      if (action === "redo") {
        const view = h.runtime.runs.view({ runId: runId! });
        expect(
          view.tasks.find((task) => task.taskId === "analysis.market")!.status,
        ).toBe("pending");
        expect(
          view.tasks.find((task) => task.taskId === "analysis.fundamentals")!
            .outputRefs,
        ).toEqual(priorFundamentals);
        expect(fundamentalsAborted).toBe(false);
        market.released.resolve();
        await setImmediate();
        expect(
          attempts.filter((attempt) => attempt.task.id === "analysis.market"),
        ).toHaveLength(1);
      } else {
        await fundamentals.aborted.promise;
        expect(h.runtime.runs.view({ runId: runId! }).status).toBe("cancelled");
        market.released.resolve();
      }
      fundamentals.released.resolve();
      const outcomes = await Promise.all([initial, control, overlappingCancel]);
      expect(marketReleased).toBe(true);
      expect(fundamentalsReleased).toBe(true);
      expect(new Set(coordinatorIds).size).toBe(1);
      if (action === "redo")
        expect(
          attempts
            .filter((attempt) => attempt.task.id === "analysis.market")
            .map((input) => input.task.attempt),
          JSON.stringify({
            outcomes: outcomes.map((outcome) =>
              outcome?.kind === "rejected"
                ? {
                    kind: outcome.kind,
                    message:
                      outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason),
                  }
                : outcome,
            ),
            steps: h.adapter.requests
              .filter((request) => String(request.sessionId) === rootId)
              .map((request) => ({
                users: request.messages
                  .filter((message) => message.role === "user")
                  .flatMap((message) =>
                    message.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text.slice(0, 180)),
                  ),
                errors: request.messages
                  .filter((message) => message.role === "tool")
                  .flatMap((message) =>
                    message.content
                      .filter(
                        (block) =>
                          block.type === "text" &&
                          block.text.startsWith("Error:"),
                      )
                      .map((block) =>
                        block.type === "text" ? block.text : "",
                      ),
                  ),
              })),
          }),
        ).toEqual([1, 2]);
      else {
        expect(
          h.adapter.requests.filter(
            (request) => request.sessionId === h.outside.agent.id,
          ).length,
        ).toBeGreaterThanOrEqual(2);
        expect(
          attempts
            .filter((attempt) => attempt.task.id === "analysis.market")
            .map((input) => input.task.attempt),
        ).toEqual([1]);
      }
      expect(
        h.runtime.runs.readArtifact(priorFundamentals[0]!).content.kind,
      ).toBe("analysis");
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );
});

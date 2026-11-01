import { setImmediate } from "node:timers/promises";
import {
  createUserMessage,
  ToolCallId,
  type GenerateOptions,
} from "@deepseek-ai/dsh-llm";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../../src/contracts/runs.js";
import type {
  ResearchHandle,
  ResearchObservation,
} from "../../src/app/research-actions.js";
import { isApplicationBusy } from "../../src/app/activity.js";
import {
  quickHost,
  initialInput,
  lastToolResult,
  toolCall,
} from "../fixtures/quick-host.js";
import {
  agentAnalysisReport,
  reportSubmission,
} from "../fixtures/analysis-report.js";
import { gate, textResponse } from "../fixtures/runtime-host.js";
import {
  isMainResearchRequest,
  mainResearchRequest,
  workflowModel,
  type RoleInput,
} from "../fixtures/research-workflow.js";

type Host = Awaited<ReturnType<typeof quickHost>>;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:00:00.000Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => marketResponse()),
  );
});
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
function marketResponse() {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        sz002594: { day: [["2024-01-03", "190", "192", "193", "189", "100"]] },
      },
    }),
  );
}
let callId = 0;
function call(
  h: Host,
  name: string,
  value: unknown,
  signal = new AbortController().signal,
  owner = h.outside.agent,
) {
  return h.ctx.tools.execute({
    agent: owner,
    callId: ToolCallId(`background-${++callId}`),
    name,
    arguments: value,
    signal,
  });
}
async function start(h: Host, signal = new AbortController().signal) {
  const result = await call(
    h,
    "stock_start_research",
    {
      security: "SZ.002594",
      date: "2024-01-03",
      mode: "quick",
      requestId: "start",
    },
    signal,
  );
  expect(result.isError).toBe(false);
  return result.value as ResearchHandle;
}
async function read(h: Host, handle: ResearchHandle) {
  const result = await call(h, "stock_read_research", handle);
  expect(result.isError).toBe(false);
  return result.value as ResearchObservation;
}
function until(
  h: Host,
  runId: string,
  condition: (view: RunView) => boolean,
): Promise<RunView> {
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const view = h.runtime.runs.view({ runId });
        if (condition(view)) {
          release();
          resolve(view);
        }
      } catch (cause) {
        release();
        reject(cause);
      }
    };
    const release = h.runtime.runs.subscribe(runId, () =>
      queueMicrotask(check),
    );
    cleanups.push(release);
    check();
  });
}

it("returns a detached, idempotent handle and cancels collection through its independent owned control", async () => {
  const paused = gate<AbortSignal>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const signal = options.signal!;
      const abort = () => paused.aborted.resolve();
      signal.addEventListener("abort", abort, { once: true });
      paused.started.resolve(signal);
      try {
        await paused.released.promise;
        signal.throwIfAborted();
        return marketResponse();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }),
  );
  const h = await quickHost(workflowModel().respond);
  cleanups.push(h.close, () => paused.released.resolve());
  const request = new AbortController();
  const handle = await start(h, request.signal);
  expect(handle).toEqual({ jobId: expect.any(String) });
  const collectionSignal = await paused.started.promise;
  expect(await start(h)).toEqual(handle);
  expect(h.ctx.jobs.list(h.outside.agent.id)).toHaveLength(1);
  const before = await read(h, handle);
  expect(before).toMatchObject({
    job: { id: handle.jobId, status: "running" },
  });
  expect(before).not.toHaveProperty("runId");
  expect(before).not.toHaveProperty("view");
  request.abort(new Error("Starting tool invocation ended"));
  await setImmediate();
  expect(collectionSignal.aborted).toBe(false);
  const foreign = await h.ctx.agents.create(h.agentOptions("foreign-chat"));
  for (const name of ["stock_read_research", "stock_cancel_research"])
    expect(
      await call(
        h,
        name,
        {
          ...handle,
          ...(name === "stock_cancel_research"
            ? { requestId: "foreign-cancel" }
            : {}),
        },
        new AbortController().signal,
        foreign.agent,
      ),
    ).toMatchObject({
      isError: true,
      error: { info: { code: "ACCESS_DENIED" } },
    });
  expect(collectionSignal.aborted).toBe(false);
  let released = false;
  const stopped = call(h, "stock_cancel_research", {
    ...handle,
    requestId: "cancel",
  }).then((result) => {
    released = true;
    return result;
  });
  await paused.aborted.promise;
  expect(released).toBe(false);
  expect(h.ctx.jobs.get(JobId(handle.jobId), h.outside.agent.id).status).toBe(
    "stopping",
  );
  expect(h.runFiles()).toEqual([]);
  paused.released.resolve();
  expect(await stopped).toMatchObject({
    isError: false,
    value: { job: { id: handle.jobId, status: "killed" } },
  });
  expect(h.runFiles()).toEqual([]);
  expect(
    h.ctx.agents
      .list()
      .filter(({ session }) => session.header.origin === "subagent"),
  ).toEqual([]);
  expect(isApplicationBusy(h.runtime)).toBe(false);
  await foreign.dispose();
});

it("keeps the main Agent interactive, stops only a selected branch, and claims redo with its atomic replacement instruction", async () => {
  const pause = gate<GenerateOptions>();
  const model = workflowModel({ pauseFundamentals: pause });
  const revisedObjectives: string[] = [];
  const h = await quickHost(async function* (request) {
    if (isMainResearchRequest(request)) {
      const question = request.messages.findLast(
        (message) => message.role === "user",
      )!;
      if (
        question.source.kind === "user" &&
        question.content.some(
          (block) => block.type === "text" && block.text === "普通提问",
        )
      ) {
        yield* textResponse("后台运行期间可以继续交流。");
        return;
      }
    } else {
      const input = initialInput<RoleInput>(request);
      if (
        input.task.id === "analysis.fundamentals" &&
        !request.messages.some(({ role }) => role === "tool")
      )
        revisedObjectives.push(input.task.objective);
    }
    yield* model.respond(request);
  });
  cleanups.push(h.close, () => pause.released.resolve());
  const handle = await start(h);
  await pause.started.promise;
  const observation = await read(h, handle);
  const runId = observation.runId!;
  const market = (
    await until(
      h,
      runId,
      (view) =>
        view.tasks.find(({ taskId }) => taskId === "analysis.market")!
          .status === "succeeded",
    )
  ).tasks.find(({ taskId }) => taskId === "analysis.market")!.outputRefs;
  h.outside.agent.followup(
    createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "普通提问" }],
    }),
  );
  await h.outside.agent.whenIdle();
  expect(
    h.adapter.requests.filter(
      ({ sessionId }) => sessionId === h.outside.agent.id,
    ),
  ).toHaveLength(1);
  expect(
    h.runtime.runs
      .view({ runId })
      .tasks.find(({ taskId }) => taskId === "analysis.fundamentals")!.status,
  ).toBe("running");
  let returned = false;
  const stopping = call(h, "stock_cancel_task", {
    runId,
    taskId: "analysis.fundamentals",
    expectedAttempt: 1,
    reason: "Replace assumptions",
    requestId: "cancel-fundamentals",
  }).then((result) => {
    returned = true;
    return result;
  });
  await pause.aborted.promise;
  expect(returned).toBe(false);
  const cancelled = h.runtime.runs.view({ runId });
  expect(cancelled.status).toBe("active");
  expect(
    cancelled.tasks.find(({ taskId }) => taskId === "analysis.fundamentals")!
      .status,
  ).toBe("cancelled");
  expect(
    cancelled.tasks.find(({ taskId }) => taskId === "analysis.market")!
      .outputRefs,
  ).toEqual(market);
  pause.released.resolve();
  expect(await stopping).toMatchObject({
    isError: false,
    value: { taskId: "analysis.fundamentals", attempt: 1 },
  });
  const instruction =
    "Reconcile profitability with the retained market analysis and produce the required valuation.";
  expect(
    await call(h, "stock_redo_task", {
      runId,
      taskId: "analysis.fundamentals",
      requestId: "redo",
      reason: "Revised assumptions",
      instruction,
    }),
  ).toMatchObject({ isError: false });
  expect(await h.waitForResearchCompletion()).toMatchObject({
    kind: "success",
  });
  const completed = h.runtime.runs.view({ runId });
  expect(completed.status).toBe("completed");
  expect(
    completed.tasks.find(({ taskId }) => taskId === "analysis.fundamentals")!
      .attempt,
  ).toBe(2);
  expect(
    completed.tasks.find(({ taskId }) => taskId === "analysis.market")!
      .outputRefs,
  ).toEqual(market);
  expect(revisedObjectives).toHaveLength(2);
  expect(revisedObjectives[1]).toBe(instruction);
  expect(h.ctx.jobs.get(JobId(handle.jobId), h.outside.agent.id).status).toBe(
    "completed",
  );
  expect(isApplicationBusy(h.runtime)).toBe(false);
});

it("returns a background revision handle and reserves the original child session against automatic dispatch", async () => {
  const revised = gate<GenerateOptions>();
  const model = workflowModel();
  const feedback = "Recheck this report in the original session.";
  let phase = 0;
  let handle: ResearchHandle | undefined;
  let originalSession: string | undefined;
  let runId: string | undefined;
  let originalRef: RunView["tasks"][number]["outputRefs"][number] | undefined;
  let revisionRequested = false;
  const h = await quickHost(async function* (request) {
    if (isMainResearchRequest(request)) {
      if (phase === 0) {
        const update = mainResearchRequest(request);
        runId = update.runId!;
        originalRef = h.runtime.runs
          .view({ runId })
          .tasks.find(({ taskId }) => taskId === "analysis.market")!
          .outputRefs[0]!;
        phase = 1;
        yield* toolCall("stock_followup_task", {
          runId,
          taskId: "analysis.market",
          message: feedback,
          requestId: "revision",
          resumeSearch: false,
        });
        return;
      }
      if (phase === 1) {
        handle = lastToolResult<ResearchHandle>(request);
        phase = 2;
        yield* textResponse("修订已在后台进行。");
        return;
      }
      phase = 3;
    } else {
      const input = initialInput<RoleInput>(request);
      if (input.task.id === "analysis.market") {
        const next = request.messages.findLast(({ role }) => role === "user")!;
        if (
          next.content.some(
            (block) => block.type === "text" && block.text.includes(feedback),
          ) &&
          !revisionRequested
        ) {
          revisionRequested = true;
          revised.started.resolve(request);
          await revised.released.promise;
          request.signal?.throwIfAborted();
          const report = agentAnalysisReport();
          report.summary = "Revised report in the retained child session.";
          yield* reportSubmission(report, "revised-report", true);
          return;
        }
        originalSession ??= String(request.sessionId);
      }
    }
    yield* model.respond(request);
  });
  cleanups.push(h.close, () => revised.released.resolve());
  const root = await start(h);
  const request = await revised.started.promise;
  await h.outside.agent.whenIdle();
  expect(handle).toEqual({ jobId: expect.any(String) });
  expect(handle!.jobId).not.toBe(root.jobId);
  expect(String(request.sessionId)).toBe(originalSession);
  expect((await read(h, handle!)).job.status).toBe("running");
  expect(
    h.runtime.runs
      .view({ runId: runId! })
      .tasks.find(({ taskId }) => taskId === "analysis.market"),
  ).toMatchObject({ status: "running", attempt: 2, outputRefs: [] });
  expect(h.runtime.runs.readArtifact(originalRef!).taskId).toBe(
    "analysis.market",
  );
  revised.released.resolve();
  expect(await h.waitForResearchCompletion()).toMatchObject({
    kind: "success",
  });
  const completed = h.runtime.runs.view({ runId: runId! });
  expect(completed.status).toBe("completed");
  expect(
    completed.tasks.find(({ taskId }) => taskId === "analysis.market")!.attempt,
  ).toBe(2);
  expect(
    h.runtime.runs.readArtifact(
      completed.tasks.find(({ taskId }) => taskId === "analysis.market")!
        .outputRefs[0]!,
    ).content.payload.report,
  ).toMatchObject({ summary: "Revised report in the retained child session." });
  expect(h.ctx.jobs.get(JobId(handle!.jobId), h.outside.agent.id).status).toBe(
    "completed",
  );
  expect(
    h.adapter.requests
      .filter(
        (request) =>
          !isMainResearchRequest(request) &&
          initialInput<RoleInput>(request).task.id === "analysis.market",
      )
      .every(({ sessionId }) => String(sessionId) === originalSession),
  ).toBe(true);
  expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
});

it.each(["cancel", "resume"] as const)(
  "retains teardown failures and applies %s to the current execution handle",
  async (action) => {
    const model = workflowModel();
    const h = await quickHost(async function* (request) {
      if (isMainResearchRequest(request))
        yield* textResponse("后台结果已收到，等待明确修订。");
      else yield* model.respond(request);
    });
    cleanups.push(h.close);
    const failure = new Error("Market activation teardown failed");
    const activate = h.ctx.subagents.startActivation.bind(h.ctx.subagents);
    let injected = false;
    vi.spyOn(h.ctx.subagents, "startActivation").mockImplementation(
      async (...args) => {
        const activation = await activate(...args);
        if (injected || !args[0].label?.startsWith("analysis.market"))
          return activation;
        injected = true;
        return {
          ...activation,
          async dispose() {
            await activation.dispose();
            throw failure;
          },
        };
      },
    );
    const notices: string[] = [];
    h.ctx.on("session/event", (session, event) => {
      if (
        session === h.outside.agent.session &&
        event.type === "user/message" &&
        event.data.source.kind === "stock-research" &&
        event.data.source.notice === "failed"
      )
        notices.push(
          event.data.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        );
    });
    const handle = await start(h);
    let job = h.ctx.jobs.get(JobId(handle.jobId), h.outside.agent.id);
    while (job.status === "running" || job.status === "stopping")
      job = await h.ctx.jobs.wait(job.id, 1000, h.outside.agent.id);
    await h.outside.agent.whenIdle();
    expect(job.status).toBe("failed");
    expect(job.detail).toContain(failure.message);
    expect(notices.join("\n")).toContain(failure.message);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(isApplicationBusy(h.runtime)).toBe(false);
    const state = await read(h, handle);
    const runId = state.runId!;
    expect(state.view!.status).toBe("active");
    const market = state.view!.tasks.find(
      ({ taskId }) => taskId === "analysis.market",
    )!.outputRefs[0]!;
    expect(h.runtime.runs.readArtifact(market).taskId).toBe("analysis.market");
    if (action === "cancel") {
      expect(
        await call(h, "stock_cancel_research", {
          jobId: handle.jobId,
          requestId: "cancel-failed",
        }),
      ).toMatchObject({
        isError: false,
        value: { job: { status: "failed" }, view: { status: "cancelled" } },
      });
    } else {
      const resumed = await call(h, "stock_resume_research", {
        runId,
        requestId: "resume-failed",
        input: { resolvedReasonIds: [], instructions: [] },
      });
      expect(resumed.isError).toBe(false);
      const current = { jobId: (resumed.value as ResearchHandle).jobId };
      expect(current.jobId).not.toBe(handle.jobId);
      const before = h.runtime.runs.view({ runId });
      expect(
        await call(h, "stock_cancel_research", {
          jobId: handle.jobId,
          requestId: "stale-control",
        }),
      ).toMatchObject({
        isError: true,
        error: { info: { code: "STALE_ATTEMPT" } },
      });
      expect(h.runtime.runs.view({ runId })).toEqual(before);
      expect(
        h.ctx.jobs.get(JobId(current.jobId), h.outside.agent.id).status,
      ).toBe("running");
      expect(
        await call(h, "stock_cancel_research", {
          jobId: current.jobId,
          requestId: "cancel-current",
        }),
      ).toMatchObject({
        isError: false,
        value: { job: { status: "killed" }, view: { status: "cancelled" } },
      });
    }
    expect(h.ctx.jobs.get(JobId(handle.jobId), h.outside.agent.id)).toEqual(
      job,
    );
    expect(h.runtime.runs.readArtifact(market).taskId).toBe("analysis.market");
  },
);

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ToolRuntime,
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DigestDraft,
  DigestModelInput,
} from "../../src/contracts/digests.js";
import type {
  MemoryState,
  QueryMemoryReturns,
} from "../../src/contracts/memory-service.js";
import {
  SessionBindings,
  type ResearchBinding,
} from "../../src/host/bindings.js";
import { MemoryStore } from "../../src/memory/store.js";
import { DecisionService } from "../../src/services/decisions.js";
import { DigestService } from "../../src/services/digests.js";
import { MemoryService } from "../../src/services/memory.js";
import { rememberInputSchema } from "../../src/tools/write-inputs.js";
import { createWriteTools } from "../../src/tools/write.js";
import { createReportSubmission } from "../../src/host/report-submission.js";
import { decisionFixture } from "../fixtures/decision.js";
import { oneDigest } from "../fixtures/digest-conversation.js";

const cleanups: (() => void | Promise<void>)[] = [];
function note() {
  return {
    previous: null,
    outcome: "Reviewed",
    note: "Review note",
    evidence: [],
    returns: {
      kind: "unavailable",
      gaps: [
        { code: "missing", field: "/returns", detail: "Prices unavailable" },
      ],
    },
  };
}
function analysis() {
  return {
    kind: "analysis",
    title: "Full analysis",
    body: "Qualitative conclusion",
    inputRefs: [],
    claims: [],
    payload: {
      findings: [{ text: "Finding", evidence: [], numbers: [] }],
      risks: [],
      gaps: [],
    },
  };
}
function digest(context: DigestModelInput): DigestDraft {
  return {
    title: "Digest",
    body: "Price {{number:n0}}",
    inputRefs: context.artifacts.map((v) => v.ref),
    facts: [
      {
        text: "Price {{number:n0}}",
        inputRefs: [context.artifacts[0]!.ref],
        numbers: ["n0"],
      },
    ],
    disagreements: [],
    riskSummaries: context.risks.map((risk) => ({
      issueId: risk.issueId,
      text: "Risk summary",
    })),
  };
}
function setup(
  queryReturns: QueryMemoryReturns = async () => {
    throw new Error("Returns failed");
  },
) {
  const f = decisionFixture({
    additionalTasks: [
      {
        id: "writer",
        executor: { kind: "role", role: "analyst", specialty: "writer" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ],
  });
  const claim = f.runs.claim(f.operation, "writer", "claim-writer");
  const memoryStore = new MemoryStore<MemoryState>(f.root, () => ({
    stateVersion: 1,
    receipts: [],
  }));
  const memory = new MemoryService(
    memoryStore,
    f.runs,
    queryReturns,
    () => f.clock.value,
  );
  const generate = vi.fn(
    async (context: DigestModelInput, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return digest(context);
    },
  );
  const digests = new DigestService(f.runs, f.artifacts, oneDigest(generate));
  const decisions = new DecisionService(f.runs, f.now);
  const bindings = new SessionBindings();
  const tools = createWriteTools(
    { artifacts: f.artifacts, memory, digests, decisions },
    bindings,
    {
      freshness: { market: 1234, fundamentals: 2345, macro: 3456 },
      secCiks: {},
    },
  );
  function agent(binding?: ResearchBinding, id = "worker") {
    const value = { id } as Agent;
    if (binding) bindings.bind(value, binding);
    return value;
  }
  const task = agent({
    kind: "task",
    runId: f.operation.runId,
    taskId: "writer",
    attempt: claim.attempt,
  });
  const review = agent(
    { kind: "review", runId: f.operation.runId, scope: f.scope },
    "review",
  );
  const coordinator = agent(
    { kind: "coordinator", runIds: [f.operation.runId] },
    "coordinator",
  );
  const ask = agent({ kind: "ask", scope: f.scope }, "ask");
  function call(
    name: string,
    args: unknown,
    caller: Agent = task,
    signal = new AbortController().signal,
  ) {
    return tools
      .find((t) => t.name === name)!
      .execute(args, {
        agent: caller,
        signal,
        callId: name as ToolRunContext["callId"],
      } as ToolRunContext);
  }
  const serviceArgs = (taskId: string) => ({
    runId: f.operation.runId,
    taskId,
    requestId: `execute-${taskId}`,
  });
  cleanups.push(async () => {
    await memory.close();
    f.close();
  });
  return {
    ...f,
    memory,
    memoryStore,
    bindings,
    tools,
    generate,
    agent,
    task,
    review,
    coordinator,
    ask,
    call,
    serviceArgs,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("write tools", () => {
  it("shares trusted task identity and receipts with direct report submission", async () => {
    const f = setup();
    const submit = createReportSubmission(f.artifacts, f.bindings);
    const saved = submit([analysis()], "shared-save", {
      agent: f.task,
      signal: new AbortController().signal,
    });
    expect(saved).toMatchObject({
      runId: f.operation.runId,
      taskId: "writer",
      attempt: 1,
    });
    expect(f.runs.readArtifact(saved.refs[0]!).content).toEqual(analysis());
    expect(
      await f.call("stock_save_report", {
        requestId: "shared-save",
        contents: [analysis()],
      }),
    ).toEqual(saved);
  });

  it("enforces authorization and cancellation on direct report submission", () => {
    const f = setup();
    const submit = createReportSubmission(f.artifacts, f.bindings);
    const signal = new AbortController().signal;
    for (const agent of [
      undefined,
      f.agent(undefined, f.task.id),
      f.coordinator,
      f.review,
      f.ask,
    ])
      expect(() =>
        submit([analysis()], "denied", { agent, signal }),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    for (const kind of ["digest", "decision", "report"])
      expect(() =>
        submit([{ ...analysis(), kind }], kind, { agent: f.task, signal }),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    const aborted = new AbortController();
    const reason = new Error("caller cancelled");
    aborted.abort(reason);
    expect(() =>
      submit([analysis()], "cancelled", {
        agent: f.task,
        signal: aborted.signal,
      }),
    ).toThrow(reason);
    expect(
      f.runs.view(f.operation).tasks.find((t) => t.taskId === "writer")!
        .outputRefs,
    ).toEqual([]);
  });

  it("omits replay source from memory returns request schema", () => {
    const input = {
      ...note(),
      returns: {
        kind: "query",
        request: {
          provider: "yahoo",
          historyStartDate: "2024-01-01",
          startDate: "2024-01-02",
          endDate: "2024-01-03",
        },
      },
    };
    expect(validateJsonSchemaValue(rememberInputSchema, input)).toEqual([]);
    expect(
      validateJsonSchemaValue(rememberInputSchema, {
        ...input,
        returns: {
          ...input.returns,
          request: {
            ...input.returns.request,
            source: { runId: "run", evidenceId: "evidence" },
          },
        },
      }).length,
    ).toBeGreaterThan(0);
  });
  it("preserves unauthorized error codes through the SDK runtime", async () => {
    const f = setup();
    const ctx = new Context();
    const releasePrompt = ctx.provide("systemPrompt", {
      tools: () => () => {},
    } as never);
    const runtime = new ToolRuntime(ctx, { mode: "native" });
    const unregister = f.tools.map((tool) => runtime.register(tool));
    cleanups.push(() => {
      for (const release of unregister.reverse()) release();
      releasePrompt();
    });
    const result = await runtime.execute({
      name: "stock_save_report",
      arguments: { requestId: "unauthorized", contents: [analysis()] },
      agent: f.review,
      callId: "unauthorized" as ToolRunContext["callId"],
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Expected an authorization failure");
    expect(result.error.info?.code).toBe("ACCESS_DENIED");
    expect(JSON.stringify(result.content)).toContain("ACCESS_DENIED");
    expect(
      f.runs.view(f.operation).tasks.find((t) => t.taskId === "writer")!
        .outputRefs,
    ).toEqual([]);
  });
  it("preserves real number failures and claim diagnostics through the SDK runtime", async () => {
    const f = setup();
    const ctx = new Context();
    const releasePrompt = ctx.provide("systemPrompt", {
      tools: () => () => {},
    } as never);
    const runtime = new ToolRuntime(ctx, { mode: "native" });
    const unregister = f.tools.map((tool) => runtime.register(tool));
    cleanups.push(() => {
      for (const release of unregister.reverse()) release();
      releasePrompt();
    });
    const content = {
      ...analysis(),
      body: "Price {{number:wrong-price}}",
      claims: [
        {
          id: "wrong-price",
          kind: "observed",
          value: 999,
          unit: "USD/share",
          source: f.source,
        },
      ],
    };
    const before = f.store.read(f.operation.runId).artifacts;
    const result = await runtime.execute({
      name: "stock_save_report",
      arguments: { requestId: "bad-number", contents: [content] },
      agent: f.task,
      callId: "bad-number" as ToolRunContext["callId"],
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    if (!result.isError)
      throw new Error("Expected a number validation failure");
    expect(result.error.info?.code).toBe("NUMBER_MISMATCH");
    const rendered = JSON.stringify(result.content);
    expect(rendered).toContain("checks");
    expect(rendered).toContain("NUMBER_MISMATCH");
    expect(rendered).toContain("wrong-price");
    expect(rendered).toContain(
      "The claim does not equal the selected normalized value.",
    );
    expect(f.store.read(f.operation.runId).artifacts).toEqual(before);
    expect(
      f.runs.view(f.operation).tasks.find((t) => t.taskId === "writer")!
        .outputRefs,
    ).toEqual([]);
  });
  it("registers and executes all four tools through the SDK runtime", async () => {
    const f = setup();
    const ctx = new Context();
    const releasePrompt = ctx.provide("systemPrompt", {
      tools: () => () => {},
    } as never);
    const runtime = new ToolRuntime(ctx, { mode: "native" });
    const unregister = f.tools.map((tool) => runtime.register(tool));
    cleanups.push(() => {
      for (const release of unregister.reverse()) release();
      releasePrompt();
    });
    const execute = async (name: string, args: unknown, agent: Agent) => {
      const result = await runtime.execute({
        name,
        arguments: args,
        agent,
        callId: name as ToolRunContext["callId"],
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      if (result.isError) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    expect(
      await execute(
        "stock_save_report",
        { requestId: "save", contents: [analysis()] },
        f.task,
      ),
    ).toMatchObject({
      runId: f.operation.runId,
      taskId: "writer",
      refs: [expect.any(Object)],
    });
    expect(
      await execute(
        "stock_remember",
        { requestId: "memo", input: note() },
        f.review,
      ),
    ).toMatchObject({ revision: 1 });
    expect(
      await execute("stock_decide", f.serviceArgs("final"), f.coordinator),
    ).toMatchObject({ refs: [expect.any(Object), expect.any(Object)] });
    const g = setup();
    g.runs.redo(g.operation, "digest", "redo-digest");
    const digestContext = new Context();
    const releaseDigestPrompt = digestContext.provide("systemPrompt", {
      tools: () => () => {},
    } as never);
    const digestRuntime = new ToolRuntime(digestContext, { mode: "native" });
    const unregisterDigest = g.tools.map((tool) =>
      digestRuntime.register(tool),
    );
    cleanups.push(() => {
      for (const release of unregisterDigest.reverse()) release();
      releaseDigestPrompt();
    });
    const result = await digestRuntime.execute({
      name: "stock_make_digest",
      arguments: g.serviceArgs("digest"),
      agent: g.coordinator,
      callId: "sdk-digest" as ToolRunContext["callId"],
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    if (result.isError) throw new Error(JSON.stringify(result.error));
    expect(result.value).toMatchObject({
      taskId: "digest",
      refs: [expect.any(Object)],
    });
  });
  it("requires a trusted agent object", async () => {
    const f = setup();
    for (const caller of [f.agent(), f.agent(undefined, f.task.id)])
      await expect(
        f.call(
          "stock_save_report",
          { requestId: "save", contents: [analysis()] },
          caller,
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("restricts report saves to task bindings", async () => {
    const f = setup();
    for (const caller of [f.review, f.ask, f.coordinator])
      await expect(
        f.call(
          "stock_save_report",
          { requestId: "save", contents: [analysis()] },
          caller,
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("persists complete role output and replays without another number check", async () => {
    const f = setup();
    const checked = vi.spyOn(f.numbers, "checkNumbers");
    const args = { requestId: "save", contents: [analysis()] };
    const saved = (await f.call("stock_save_report", args)) as {
      refs: Parameters<typeof f.runs.readArtifact>[0][];
    };
    expect(f.runs.readArtifact(saved.refs[0]!).content).toEqual(analysis());
    expect(await f.call("stock_save_report", args)).toEqual(saved);
    expect(checked).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete role output arrays", async () => {
    const f = setup();
    await expect(
      f.call("stock_save_report", { requestId: "save", contents: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    expect(
      f.runs.view(f.operation).tasks.find((t) => t.taskId === "writer")!
        .outputRefs,
    ).toEqual([]);
  });
  it("forbids service-only report kinds before submission", async () => {
    const f = setup();
    const submit = vi.spyOn(f.artifacts, "submitArtifact");
    for (const kind of ["digest", "decision", "report"])
      await expect(
        f.call("stock_save_report", {
          requestId: kind,
          contents: [{ ...analysis(), kind }],
        }),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not accept model run or attempt overrides", async () => {
    const f = setup();
    for (const extra of [
      { runId: "other" },
      { attempt: 99 },
      { taskId: "analysis" },
    ])
      await expect(
        f.call("stock_save_report", {
          requestId: "save",
          contents: [analysis()],
          ...extra,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("closes nested artifact objects", async () => {
    const f = setup();
    await expect(
      f.call("stock_save_report", {
        requestId: "save",
        contents: [
          { ...analysis(), payload: { ...analysis().payload, runId: "other" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  });
  it("restricts memory writes to review bindings", async () => {
    const f = setup();
    for (const caller of [f.task, f.ask, f.coordinator])
      await expect(
        f.call("stock_remember", { requestId: "memo", input: note() }, caller),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("binds memory to the review run and scope without changing run state", async () => {
    const f = setup();
    const before = f.store.read(f.operation.runId);
    const ref = (await f.call(
      "stock_remember",
      {
        requestId: "memo",
        input: { ...note(), evidence: [f.analysisRef, f.source] },
      },
      f.review,
    )) as Parameters<typeof f.memory.read>[0];
    expect(f.memory.read(ref)).toMatchObject({
      runId: f.operation.runId,
      securityId: f.scope.security.id,
      identity: "review",
      evidence: [f.analysisRef, f.source],
    });
    expect(f.store.read(f.operation.runId)).toEqual(before);
  });
  it("requires nonempty memory text, valid references and nonempty gaps", async () => {
    const f = setup();
    for (const input of [
      { ...note(), outcome: " " },
      { ...note(), note: "" },
      { ...note(), evidence: [{ ...f.source, selector: 42 }] },
      { ...note(), returns: { kind: "unavailable", gaps: [] } },
      {
        ...note(),
        returns: {
          kind: "unavailable",
          gaps: [{ code: "missing", field: "/returns", detail: " " }],
        },
      },
    ])
      await expect(
        f.call("stock_remember", { requestId: "memo", input }, f.review),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.memoryStore.readIndex().receipts).toEqual([]);
  });
  it("closes root and nested memory arguments", async () => {
    const f = setup();
    for (const args of [
      { requestId: "memo", input: note(), runId: "other" },
      { requestId: "memo", input: { ...note(), scope: f.scope } },
      {
        requestId: "memo",
        input: {
          ...note(),
          previous: { entryId: "x", revision: 1, extra: true },
        },
      },
      {
        requestId: "memo",
        input: { ...note(), evidence: [{ ...f.analysisRef, extra: true }] },
      },
    ])
      await expect(
        f.call("stock_remember", args, f.review),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("uses configured returns policy and leaves the old run unchanged on query failure", async () => {
    const query = vi.fn<QueryMemoryReturns>(async () => {
      throw new Error("Query unavailable");
    });
    const f = setup(query);
    const before = f.store.read(f.operation.runId);
    const signal = new AbortController().signal;
    await expect(
      f.call(
        "stock_remember",
        {
          requestId: "memo",
          input: {
            ...note(),
            returns: {
              kind: "query",
              request: {
                provider: "yahoo",
                historyStartDate: "2024-01-01",
                startDate: "2024-01-02",
                endDate: "2024-01-03",
              },
            },
          },
        },
        f.review,
        signal,
      ),
    ).rejects.toThrow("Query unavailable");
    expect(query).toHaveBeenCalledWith(
      f.scope,
      {
        dataset: "returns",
        provider: "yahoo",
        parameters: {
          historyStartDate: "2024-01-01",
          startDate: "2024-01-02",
          endDate: "2024-01-03",
          maxAgeMs: 1234,
          comparable: false,
        },
      },
      expect.any(AbortSignal),
    );
    expect(f.memoryStore.readIndex().receipts).toEqual([]);
    expect(f.store.read(f.operation.runId)).toEqual(before);
  });
  it("rejects model returns policy, CIK and replay source overrides", async () => {
    const f = setup();
    for (const extra of [
      { comparable: true },
      { maxAgeMs: 0 },
      { cik: "0000320193" },
      { source: { runId: f.operation.runId, evidenceId: f.source.evidenceId } },
    ])
      await expect(
        f.call(
          "stock_remember",
          {
            requestId: "memo",
            input: {
              ...note(),
              returns: {
                kind: "query",
                request: {
                  provider: "yahoo",
                  historyStartDate: "2024-01-01",
                  startDate: "2024-01-02",
                  endDate: "2024-01-03",
                  ...extra,
                },
              },
            },
          },
          f.review,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("rejects mismatched review security and foreign evidence without writes", async () => {
    const f = setup();
    const wrongScope = f.agent({
      kind: "review",
      runId: f.operation.runId,
      scope: { ...f.scope, security: { ...f.scope.security, id: "OTHER" } },
    });
    await expect(
      f.call(
        "stock_remember",
        { requestId: "memo", input: note() },
        wrongScope,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      f.call(
        "stock_remember",
        {
          requestId: "foreign",
          input: {
            ...note(),
            evidence: [{ ...f.analysisRef, runId: "other" }],
          },
        },
        f.review,
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(f.memoryStore.readIndex().receipts).toEqual([]);
  });
  it("creates explicit revisions and rejects stale previous versions", async () => {
    const f = setup();
    const first = (await f.call(
      "stock_remember",
      { requestId: "first", input: note() },
      f.review,
    )) as Parameters<typeof f.memory.read>[0];
    const revised = (await f.call(
      "stock_remember",
      {
        requestId: "second",
        input: { ...note(), previous: first, note: "Revised view" },
      },
      f.review,
    )) as typeof first;
    expect(revised).toEqual({ entryId: first.entryId, revision: 2 });
    expect(f.memory.read(first).note).toBe("Review note");
    expect(f.memory.read(revised).note).toBe("Revised view");
    await expect(
      f.call(
        "stock_remember",
        { requestId: "stale", input: { ...note(), previous: first } },
        f.review,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it("requires a coordinator and an authorized run for service tasks", async () => {
    const f = setup();
    for (const name of ["stock_make_digest", "stock_decide"]) {
      for (const caller of [f.task, f.review, f.ask])
        await expect(
          f.call(name, f.serviceArgs("final"), caller),
        ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      await expect(
        f.call(
          name,
          { ...f.serviceArgs("final"), runId: "other" },
          f.coordinator,
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    }
  });
  it("closes service task arguments and rejects mismatched service definitions", async () => {
    const f = setup();
    for (const name of ["stock_make_digest", "stock_decide"])
      await expect(
        f.call(name, { ...f.serviceArgs("final"), attempt: 1 }, f.coordinator),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const [name, taskId] of [
      ["stock_make_digest", "final"],
      ["stock_decide", "digest"],
      ["stock_decide", "writer"],
    ])
      await expect(
        f.call(name!, f.serviceArgs(taskId!), f.coordinator),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("drives digest generation and decision publication through real services", async () => {
    const f = setup();
    const signal = new AbortController().signal;
    await f.call("stock_save_report", {
      requestId: "complete-writer",
      contents: [analysis()],
    });
    const final = (await f.call(
      "stock_decide",
      f.serviceArgs("final"),
      f.coordinator,
      signal,
    )) as { refs: Parameters<typeof f.runs.readArtifact>[0][] };
    expect(
      final.refs.map((ref) => f.runs.readArtifact(ref).content.kind),
    ).toEqual(["decision", "report"]);
    expect(f.runs.readArtifact(final.refs[0]!).content.payload).toMatchObject({
      rating: "buy",
      draftRef: f.draftRef,
    });
    expect(f.runs.readArtifact(f.draftRef).content.payload).toMatchObject({
      rating: "buy",
    });
    const g = setup();
    g.runs.redo(g.operation, "digest", "redo");
    const saved = (await g.call(
      "stock_make_digest",
      g.serviceArgs("digest"),
      g.coordinator,
      signal,
    )) as typeof final;
    expect(g.generate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "digest", scope: g.scope }),
      expect.any(AbortSignal),
      expect.objectContaining({
        runId: g.operation.runId,
        taskId: "digest",
        attempt: g.runs.readArtifact(saved.refs[0]!).attempt,
        identity: g.coordinator.id,
        sessionId: null,
      }),
    );
    const content = g.runs.readArtifact(saved.refs[0]!).content;
    expect(content).toMatchObject({
      kind: "digest",
      inputRefs: [g.analysisRef, g.riskRef],
    });
    expect(content.body).toContain("Price 100 USD/股");
  });
  it("checks cancellation before bindings or storage for every write tool", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    const require = vi.spyOn(f.bindings, "require");
    const read = vi.spyOn(f.store, "read");
    for (const tool of f.tools)
      await expect(
        f.call(tool.name, {}, f.task, controller.signal),
      ).rejects.toThrow("Stopped");
    expect(require).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

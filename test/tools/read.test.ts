import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ToolRuntime,
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCache } from "../../src/cache/index.js";
import type { CollectedTableData } from "../../src/contracts/collection.js";
import type { DataEnvelope, DataGap } from "../../src/contracts/data.js";
import type { MemoryState } from "../../src/contracts/memory-service.js";
import {
  SessionBindings,
  type ResearchBinding,
} from "../../src/host/bindings.js";
import { MemoryStore } from "../../src/memory/store.js";
import { MemoryService } from "../../src/services/memory.js";
import { QueryService } from "../../src/services/query.js";
import { createReadTools, createRoleReadTools } from "../../src/tools/read.js";
import { decisionFixture } from "../fixtures/decision.js";

const cleanups: (() => void | Promise<void>)[] = [];
const recall = { relatedRunId: null, text: null, limit: 10 };
function setup(replay?: boolean) {
  const f = decisionFixture({
    additionalTasks: [
      {
        id: "reader",
        executor: { kind: "role", role: "analyst", specialty: "reader" },
        dependsOn: [],
        inputTasks: [],
        outputKinds: ["analysis"],
        dataRequirements: [],
        instructionVersion: 1,
      },
    ],
  });
  const claim = f.runs.claim(f.operation, "reader", "claim-reader");
  const memory = new MemoryService(
    new MemoryStore<MemoryState>(f.root, () => ({
      stateVersion: 1,
      receipts: [],
    })),
    f.runs,
    async () => {
      throw new Error("Unexpected returns query");
    },
    () => f.clock.value,
  );
  const cache = new SqliteCache({ path: ":memory:", maxEntries: 10 });
  const queries = new QueryService({}, cache, f.runs, {
    market: 0,
    fundamentals: 0,
    macro: 0,
    research: 0,
  });
  const bindings = new SessionBindings();
  const tools =
    replay === undefined
      ? createReadTools(
          { runs: f.runs, numbers: f.numbers, memory, queries },
          bindings,
        )
      : createRoleReadTools(
          { runs: f.runs, memory, queries },
          bindings,
          replay,
        );
  function agent(binding?: ResearchBinding, id = "worker") {
    const value = { id } as Agent;
    if (binding) bindings.bind(value, binding);
    return value;
  }
  const taskBinding: ResearchBinding = {
    kind: "task",
    runId: f.operation.runId,
    taskId: "reader",
    attempt: claim.attempt,
  };
  const task = agent(taskBinding);
  const ask = agent({ kind: "ask", scope: f.scope }, "ask");
  const review = agent(
    { kind: "review", runId: f.operation.runId, scope: f.scope },
    "review",
  );
  function call(
    name: string,
    args: unknown,
    caller: Agent | undefined = task,
    callId = "call",
    signal = new AbortController().signal,
  ) {
    const tool = tools.find((entry) => entry.name === name)!;
    return tool.execute(args, {
      agent: caller,
      callId: callId as ToolRunContext["callId"],
      signal,
    } as ToolRunContext);
  }
  async function remember(note: string) {
    return memory.remember(
      { ...f.operation, scope: f.scope },
      {
        previous: null,
        outcome: "Reviewed",
        note,
        evidence: [],
        returns: {
          kind: "unavailable",
          gaps: [{ code: "missing", field: "/data", detail: "Fixture" }],
        },
      },
      note,
    );
  }
  cleanups.push(async () => {
    await queries.close();
    await memory.close();
    cache.close();
    f.close();
  });
  return {
    ...f,
    bindings,
    tools,
    taskBinding,
    task,
    ask,
    review,
    agent,
    call,
    memory,
    queries,
    remember,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("read tools", () => {
  it.each([false, true])(
    "declares bound role reads with replay=%s without changing fixed references",
    async (replay) => {
      const f = setup(replay);
      const health = f.tools.find(({ name }) => name === "stock_data_health")!;
      const memory = f.tools.find(({ name }) => name === "stock_recall")!;
      const artifact = f.tools.find(
        ({ name }) => name === "stock_read_artifact",
      )!;
      expect(validateJsonSchemaValue(health.parameters, {})).toEqual([]);
      expect(
        validateJsonSchemaValue(health.parameters, {
          runId: f.operation.runId,
        }),
      ).not.toEqual([]);
      const withSource = {
        ...recall,
        source: {
          runId: "original-run",
          inputRef: { kind: "input", id: "saved" },
        },
      };
      expect(
        validateJsonSchemaValue(memory.parameters, withSource).length === 0,
      ).toBe(replay);
      expect(
        validateJsonSchemaValue(artifact.parameters, { ref: f.analysisRef }),
      ).toEqual([]);
      expect(await f.call("stock_data_health", {})).toMatchObject({
        scope: f.scope,
      });
      await expect(
        f.call("stock_data_health", { runId: f.operation.runId }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(
        await f.call("stock_read_artifact", { ref: f.analysisRef }),
      ).toMatchObject({ kind: "artifact", artifact: { ref: f.analysisRef } });
    },
  );
  it("registers and executes all read tools through the SDK runtime and output schemas", async () => {
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
    expect(f.tools.map((tool) => tool.name)).not.toContain("stock_read");
    const calls = [
      [
        "stock_read_run",
        { runId: f.operation.runId },
        { kind: "run_view", view: { scope: f.scope } },
      ],
      [
        "stock_read_evidence",
        { ref: f.source },
        { kind: "evidence", value: 100 },
      ],
      [
        "stock_check_pending_numbers",
        {
          contentId: "draft",
          content: {
            kind: "analysis",
            title: "Draft",
            body: "Draft",
            inputRefs: [],
            claims: [],
            payload: {
              findings: [{ text: "Finding", evidence: [], numbers: [] }],
              risks: [],
              gaps: [],
            },
          },
        },
        { passed: true, target: { kind: "pending", contentId: "draft" } },
      ],
      [
        "stock_read_artifact",
        { ref: f.analysisRef },
        { kind: "artifact", artifact: { ref: f.analysisRef } },
      ],
      ["stock_data_health", {}, { scope: f.scope }],
      [
        "stock_recall",
        recall,
        { kind: "task", snapshot: { runId: f.operation.runId, entries: [] } },
      ],
      [
        "stock_check_numbers",
        { ref: f.analysisRef },
        { passed: true, target: { kind: "artifact", ref: f.analysisRef } },
      ],
    ] as const;
    for (const [name, args, expected] of calls) {
      const result = await runtime.execute({
        name,
        arguments: args,
        agent: f.task,
        callId: name as ToolRunContext["callId"],
        signal: new AbortController().signal,
      });
      if (result.isError) throw new Error(JSON.stringify(result.error));
      expect(result.isError).toBe(false);
      expect(result.value).toMatchObject(expected);
    }
  });
  it("rejects discriminator and cross-tool inputs on the split endpoints", async () => {
    const f = setup();
    for (const [name, args] of [
      ["stock_read_run", { kind: "run_view", runId: f.operation.runId }],
      ["stock_read_artifact", { kind: "artifact", ref: f.analysisRef }],
      ["stock_read_evidence", { kind: "evidence", ref: f.source }],
      ["stock_check_numbers", { kind: "artifact", ref: f.analysisRef }],
      ["stock_check_numbers", { contentId: "draft", content: {} }],
      ["stock_check_pending_numbers", { ref: f.analysisRef }],
    ] as const)
      await expect(f.call(name, args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
  });
  it("rejects unknown agents", async () => {
    const f = setup();
    await expect(
      f.call("stock_data_health", {}, f.agent()),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("does not authorize another Agent object with the same id", async () => {
    const f = setup();
    await expect(
      f.call(
        "stock_read_artifact",
        { ref: f.analysisRef },
        f.agent(undefined, f.task.id),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("allows coordinator run views and shared artifact reads", async () => {
    const f = setup();
    const caller = f.agent({
      kind: "coordinator",
      runIds: [f.operation.runId],
    });
    await expect(
      f.call("stock_read_run", { runId: f.operation.runId }, caller),
    ).resolves.toMatchObject({ kind: "run_view", view: { scope: f.scope } });
    await expect(
      f.call("stock_read_artifact", { ref: f.riskRef }, caller),
    ).resolves.toMatchObject({ kind: "artifact" });
  });
  it("allows a task to read another role's historical artifact and evidence", async () => {
    const f = setup();
    await expect(
      f.call("stock_read_artifact", { ref: f.analysisRef }),
    ).resolves.toMatchObject({ kind: "artifact" });
    const result = await f.call("stock_read_evidence", {
      ref: f.source,
    });
    expect(result).toMatchObject({ kind: "evidence", value: 100 });
    expect((result as { metadata: object }).metadata).not.toHaveProperty(
      "data",
    );
    expect((result as { metadata: object }).metadata).not.toHaveProperty(
      "candidateClaims",
    );
    await expect(
      f.call("stock_read_evidence", {
        ref: { ...f.source, selector: "/availableAt" },
      }),
    ).resolves.toMatchObject({ kind: "evidence", value: null });
  });
  it("returns only the selected collected field's gaps while retaining table and row-time limitations", async () => {
    const f = setup();
    const global: DataGap = {
      code: "unverified_time",
      field: "/data/rows",
      detail: "The source does not establish original historical versions.",
    };
    const rowTime: DataGap = {
      code: "unverified_time",
      field: "/data/rows/1/availableAt",
      detail: "The selected row has no precise publication time.",
    };
    const envelope: DataEnvelope<CollectedTableData> = {
      ...f.frame.envelope,
      data: {
        table: "market.daily",
        title: "Synthetic bounded daily table",
        currency: "USD",
        adjustment: "unadjusted",
        interval: "1d",
        columns: {
          close: { label: "Close", unit: "USD/share", price: true },
          volume: { label: "Volume", unit: "shares" },
        },
        rows: [10, 20].map((close, index) => ({
          date: `2024-01-0${index + 2}`,
          asOf: `2024-01-0${index + 2}T21:00:00.000Z`,
          availableAt: null,
          complete: true,
          values: { close, volume: null },
        })),
      },
      gaps: [
        global,
        {
          code: "missing",
          field: "/data/rows/0/values/volume",
          detail: "Earlier missing volume.",
        },
        {
          code: "missing",
          field: "/data/rows/1/values/volume",
          detail: "Other selected-row field.",
        },
        rowTime,
      ],
    };
    const source = f.runs.recordEvidence(
      {
        runId: f.operation.runId,
        taskId: "reader",
        attempt: f.taskBinding.attempt,
        identity: f.task.id,
        sessionId: null,
      },
      {
        dataset: "market",
        provider: "fixture",
        parameters: { table: "market.daily" },
      },
      { envelope, candidates: [] },
      "collected-input",
    );
    const original = f.runs.readEvidence(source);
    await expect(
      f.call("stock_read_evidence", {
        ref: { ...source, selector: "/data/rows/1/values/close" },
      }),
    ).resolves.toMatchObject({
      value: 20,
      metadata: { gaps: [global, rowTime] },
    });
    await expect(
      f.call("stock_read_evidence", {
        ref: { ...source, selector: "" },
      }),
    ).resolves.toMatchObject({
      value: envelope,
      metadata: { gaps: envelope.gaps },
    });
    await expect(
      f.call("stock_read_evidence", {
        ref: { ...source, selector: "/availableAt" },
      }),
    ).resolves.toMatchObject({ value: null });
    expect(f.runs.readEvidence(source)).toEqual(original);
  });
  it("denies references outside the bound run before storage access", async () => {
    const f = setup();
    const read = vi.spyOn(f.runs, "readArtifact");
    await expect(
      f.call("stock_read_artifact", {
        ref: { ...f.analysisRef, runId: "other" },
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(read).not.toHaveBeenCalled();
  });
  it("allows ask health and ordinary recall in its own scope", async () => {
    const f = setup();
    await expect(f.call("stock_data_health", {}, f.ask)).resolves.toMatchObject(
      { scope: f.scope },
    );
    await expect(f.call("stock_recall", recall, f.ask)).resolves.toEqual({
      kind: "ordinary",
      scope: f.scope,
      entries: [],
    });
  });
  it("denies ask formal reads and pending checks", async () => {
    const f = setup();
    for (const [name, args] of [
      ["stock_read_run", { runId: f.operation.runId }],
      ["stock_check_numbers", { ref: f.analysisRef }],
      ["stock_check_pending_numbers", { contentId: "x", content: {} }],
    ] as const)
      await expect(f.call(name, args, f.ask)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
  });
  it("allows review historical reads and ordinary recall", async () => {
    const f = setup();
    await expect(
      f.call("stock_read_artifact", { ref: f.analysisRef }, f.review),
    ).resolves.toMatchObject({ kind: "artifact" });
    await expect(
      f.call("stock_recall", recall, f.review),
    ).resolves.toMatchObject({ kind: "ordinary", scope: f.scope });
  });
  it("requires an authorized run for coordinator health", async () => {
    const f = setup();
    const caller = f.agent({
      kind: "coordinator",
      runIds: [f.operation.runId],
    });
    await expect(
      f.call("stock_data_health", { runId: f.operation.runId }, caller),
    ).resolves.toMatchObject({ scope: f.scope });
    await expect(
      f.call("stock_data_health", { runId: "other" }, caller),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("does not permit task health runId or cutoff overrides", async () => {
    const f = setup();
    for (const args of [
      { runId: f.operation.runId },
      { cutoff: f.scope.cutoff },
    ])
      await expect(f.call("stock_data_health", args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
  });
  it("closes root arguments and nested references", async () => {
    const f = setup();
    for (const args of [
      { kind: "artifact", ref: f.analysisRef, path: "/tmp/x" },
      { kind: "artifact", ref: { ...f.analysisRef, path: "/tmp/x" } },
      { kind: "evidence", ref: { ...f.source, cutoff: f.scope.cutoff } },
    ])
      await expect(
        f.call(
          args.kind === "evidence"
            ? "stock_read_evidence"
            : "stock_read_artifact",
          Object.fromEntries(
            Object.entries(args).filter(([key]) => key !== "kind"),
          ),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
  });
  it("closes recall arguments and source references", async () => {
    const f = setup();
    for (const args of [
      { ...recall, requestId: "model-choice" },
      {
        ...recall,
        source: {
          runId: f.operation.runId,
          inputRef: { kind: "input", id: "x", extra: true },
        },
      },
    ])
      await expect(f.call("stock_recall", args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
  });
  it("uses exec.callId for immutable recall snapshots and reselects a new call", async () => {
    const f = setup();
    f.clock.value = "2024-01-02T00:00:00.000Z";
    const first = await f.call("stock_recall", recall, f.task, "first");
    await f.remember("New memory");
    expect(await f.call("stock_recall", recall, f.task, "first")).toEqual(
      first,
    );
    expect(
      await f.call("stock_recall", recall, f.task, "second"),
    ).toMatchObject({
      kind: "task",
      snapshot: { entries: [{ content: { note: "New memory" } }] },
    });
    expect(f.store.read(f.operation.runId).inputs).toHaveLength(2);
  });
  it.each([undefined, true])(
    "replays an explicitly selected saved memory input with scoped=%s",
    async (scoped) => {
      const f = setup(scoped);
      const original = await f.call("stock_recall", recall, f.task, "original");
      const state = f.store.read(f.operation.runId);
      const input = state.inputs.find(
        (entry) => entry.memory?.callId === "original",
      )!;
      const replay = f.runs.open(
        "owner",
        { replay: { runId: f.operation.runId }, versions: state.versions },
        "replay",
      );
      const claim = f.runs.claim(
        { runId: replay.runId, identity: "owner" },
        "reader",
        "claim-replay",
      );
      const caller = f.agent({
        kind: "task",
        runId: replay.runId,
        taskId: "reader",
        attempt: claim.attempt,
      });
      const result = await f.call(
        "stock_recall",
        {
          ...recall,
          source: { runId: f.operation.runId, inputRef: input.ref },
        },
        caller,
        "replay-call",
      );
      expect(result).toMatchObject({
        kind: "task",
        snapshot: {
          entries: (original as { snapshot: { entries: unknown[] } }).snapshot
            .entries,
        },
      });
    },
  );
  it("checks a fully parsed pending artifact without submitting it", async () => {
    const f = setup();
    const before = f.store.read(f.operation.runId).artifacts;
    const content = {
      kind: "analysis",
      title: "Pending",
      body: "Pending",
      inputRefs: [],
      claims: [],
      payload: {
        findings: [{ text: "Qualitative finding", evidence: [], numbers: [] }],
        risks: [],
        gaps: [],
      },
    };
    await expect(
      f.call("stock_check_pending_numbers", {
        contentId: "draft",
        content,
      }),
    ).resolves.toMatchObject({
      passed: true,
      target: { kind: "pending", contentId: "draft" },
    });
    expect(f.store.read(f.operation.runId).artifacts).toEqual(before);
    await expect(
      f.call("stock_check_pending_numbers", {
        contentId: "draft",
        content: { ...content, payload: {} },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  });
  it("rejects pending checks by coordinator and review", async () => {
    const f = setup();
    for (const caller of [
      f.review,
      f.agent({ kind: "coordinator", runIds: [f.operation.runId] }),
    ])
      await expect(
        f.call(
          "stock_check_pending_numbers",
          { contentId: "draft", content: {} },
          caller,
        ),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("reports malformed JSON Pointer as INVALID_INPUT", async () => {
    const f = setup();
    await expect(
      f.call("stock_read_evidence", {
        ref: { ...f.source, selector: "/data/~2" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("checks cancellation before identity or storage on every tool", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    const require = vi.spyOn(f.bindings, "require");
    const read = vi.spyOn(f.store, "read");
    for (const tool of f.tools)
      await expect(
        f.call(tool.name, {}, f.task, "cancelled", controller.signal),
      ).rejects.toThrow("Stopped");
    expect(require).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

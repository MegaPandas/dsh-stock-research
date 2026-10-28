import { setImmediate } from "node:timers/promises";
import {
  HarnessError,
  isAgentLoopRequest,
  LlmError,
  type LlmCallConfig,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DigestDraft,
  DigestModelInput,
} from "../../src/contracts/digests.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { HostDigestModel } from "../../src/host/digest-model.js";
import { assembleDigest } from "../../src/services/digest-draft.js";
import {
  captureModelLogs,
  DigestAdapter,
  digestSubmit,
  digestText,
  modelGate,
} from "../fixtures/dispatch-host.js";
import { toolCall } from "../fixtures/quick-host.js";
import { runtimeHost } from "../fixtures/runtime-host.js";
import { digestBusinessDraft } from "../../src/services/digest-business.js";
import { US_SECURITY } from "../fixtures/market.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";

const cleanups: (() => Promise<void>)[] = [];
const input: DigestModelInput = {
  protocolVersion: "11",
  scope: {
    security: US_SECURITY,
    date: "2024-01-03",
    cutoff: "2024-01-03T22:00:00.000Z",
  },
  taskId: "digest",
  instructionVersion: 2,
  instruction: "Use fixed input references.",
  artifacts: [],
  reports: [],
  references: [],
  numbers: [],
  risks: [],
  gaps: [],
};
const draft: DigestDraft = {
  title: "Summary",
  body: "Fixed qualitative summary",
  inputRefs: [],
  facts: [],
  disagreements: [],
  riskSummaries: [],
};
function businessDraft(value: DigestDraft) {
  return {
    summary: value.body,
    content: {
      keyPoints: value.facts.map((fact) => fact.text),
      disagreements: value.disagreements,
      riskSummaries: value.riskSummaries,
      openQuestions: [],
    },
  };
}
const operation = {
  runId: "private-run-context",
  taskId: "digest",
  attempt: 7,
  identity: "private-coordinator",
  sessionId: null,
};
const committed = {
  runId: operation.runId,
  taskId: operation.taskId,
  attempt: 7,
  refs: [],
};
const usage = {
  inputTokens: 10,
  outputTokens: 3,
  totalTokens: 37,
  cacheReadTokens: 20,
  cacheWriteTokens: 4,
  reasoningTokens: 1,
};
const signal = () => new AbortController().signal;

async function model(
  adapter: DigestAdapter,
  config: LlmCallConfig = { provider: "digest-fixture", model: "digest" },
) {
  const h = await runtimeHost();
  cleanups.push(h.close);
  h.ctx.llm.registerAdapter(["digest-fixture"], adapter);
  const logs = captureModelLogs(h.ctx);
  return { ...h, logs, host: new HostDigestModel(h.ctx, config) };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("HostDigestModel through DSH AgentLoop", () => {
  it("rejects a recorded older protocol before creating an Agent or calling the model", async () => {
    const adapter = new DigestAdapter(() => digestText("must not run"));
    const h = await model(adapter);
    const create = vi.spyOn(h.ctx.agents, "create");
    const submit = vi.fn(() => committed);
    await expect(
      h.host.generate(
        { ...input, protocolVersion: "9" },
        signal(),
        operation,
        submit,
      ),
    ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
    expect(create).not.toHaveBeenCalled();
    expect(adapter.requests).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("executes the recorded current protocol through the shared submission boundary", async () => {
    const adapter = new DigestAdapter(() =>
      toolCall("stock_submit", businessDraft(draft), "submit"),
    );
    const h = await model(adapter);
    await expect(
      h.host.generate(
        { ...input, protocolVersion: "11" },
        signal(),
        operation,
        () => committed,
      ),
    ).resolves.toEqual(committed);
    expect(adapter.requests).toHaveLength(1);
  });

  it("assembles protocol 12 without creating an Agent or calling a model", async () => {
    const adapter = new DigestAdapter(() => digestText("must not run"));
    const h = await model(adapter);
    const create = vi.spyOn(h.ctx.agents, "create");
    const submit = vi.fn(() => committed);
    await expect(
      h.host.generate(
        { ...input, protocolVersion: "12" },
        signal(),
        operation,
        submit,
      ),
    ).resolves.toEqual(committed);
    expect(create).not.toHaveBeenCalled();
    expect(adapter.requests).toEqual([]);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("preserves direct report inputs for saved protocol 10", async () => {
    const report = {
      ref: { runId: "run", artifactId: "risk", revision: 1 },
      taskId: "risk",
      attempt: 1,
      producerSessionId: null,
      createdAt: input.scope.cutoff,
      schemaVersion: 1 as const,
      content: {
        kind: "risk" as const,
        title: "Full risk",
        body: "Full risk details are already in the direct report.",
        inputRefs: [],
        claims: [],
        payload: {},
      },
    };
    const adapter = new DigestAdapter(async function* (request) {
      const initial = JSON.parse(
        (
          request.messages.find((message) => message.role === "user")!
            .content[0] as { text: string }
        ).text,
      );
      expect(initial.context.materials).toEqual([
        { title: report.content.title, body: report.content.body },
      ]);
      expect(initial.context.reportCatalog).toEqual([]);
      expect(initial.context.requiredRisks).toEqual([{ issueId: "liquidity" }]);
      yield* toolCall(
        "stock_submit",
        {
          ...businessDraft(draft),
          content: {
            ...businessDraft(draft).content,
            riskSummaries: [
              { issueId: "liquidity", text: "Liquidity constrains exposure." },
            ],
          },
        },
        "submit",
      );
    });
    const h = await model(adapter);
    await h.host.generate(
      {
        ...input,
        protocolVersion: "10",
        artifacts: [report],
        reports: [report],
        risks: [
          {
            issueId: "liquidity",
            description: "Full description",
            impact: "Full impact",
            trigger: "Full trigger",
            constraint: "Full constraint",
            recommendation: "Full recommendation",
            evidence: [],
            numbers: [],
          },
        ],
      },
      signal(),
      operation,
      () => committed,
    );
    expect(adapter.requests).toHaveLength(1);
  });

  it("provides root summaries and lets the digest read their full reports on demand", async () => {
    const analysis = agentAnalysisReport();
    const report = {
      ref: { runId: "run", artifactId: "market", revision: 1 },
      taskId: "analysis.market",
      attempt: 1,
      producerSessionId: null,
      createdAt: input.scope.cutoff,
      schemaVersion: 1 as const,
      content: {
        kind: "analysis" as const,
        title: "Market report",
        body: "Long report body not needed initially",
        inputRefs: [],
        claims: [],
        payload: { schemaVersion: 3, report: analysis },
      },
    };
    let turn = 0;
    const adapter = new DigestAdapter(async function* (request) {
      if (++turn === 1) {
        const initial = JSON.parse(
          (
            request.messages.find((message) => message.role === "user")!
              .content[0] as { text: string }
          ).text,
        );
        expect(initial.context.materials).toEqual([
          { id: "report-1", title: "Market report", summary: analysis.summary },
        ]);
        expect(initial.context.reportCatalog).toMatchObject([
          { id: "report-1", title: "Market report" },
        ]);
        expect(JSON.stringify(initial)).not.toContain(
          analysis.content.currentState[0],
        );
        yield* toolCall("stock_read_report", { id: "report-1" }, "read-root");
        return;
      }
      const feedback = request.messages.filter(
        (message) => message.role === "tool",
      );
      expect(JSON.stringify(feedback)).toContain(
        analysis.content.currentState[0],
      );
      yield* toolCall("stock_submit", businessDraft(draft), "submit");
    });
    const h = await model(adapter);
    await expect(
      h.host.generate(
        {
          ...input,
          protocolVersion: "11",
          artifacts: [report],
          reports: [report],
        },
        signal(),
        operation,
        () => committed,
      ),
    ).resolves.toEqual(committed);
  });

  it("offers inherited reports by short ID without serializing their private content", async () => {
    const report = {
      ref: { runId: "hidden-run", artifactId: "hidden-artifact", revision: 3 },
      taskId: "analysis",
      attempt: 1,
      producerSessionId: "hidden-session",
      createdAt: "2024-01-03T22:00:00.000Z",
      schemaVersion: 1 as const,
      content: {
        kind: "analysis" as const,
        title: "Original analysis",
        body: "Original revenue grew 20%.",
        inputRefs: [],
        claims: [],
        payload: { private: "hidden-payload" },
      },
    };
    let turn = 0;
    const adapter = new DigestAdapter(async function* (request) {
      if (++turn === 1) {
        const initial = request.messages.find(
          (message) => message.role === "user",
        )!.content;
        expect(JSON.stringify(initial)).toContain("report-1");
        expect(JSON.stringify(initial)).not.toContain(report.content.body);
        expect(JSON.stringify(initial)).not.toContain("hidden-");
        yield* toolCall("stock_read_report", { id: "report-1" }, "read-report");
        return;
      }
      const feedback = request.messages.filter(
        (message) => message.role === "tool",
      );
      expect(JSON.stringify(feedback)).toContain(report.content.body);
      expect(JSON.stringify(feedback)).not.toContain("hidden-");
      yield* toolCall("stock_submit", businessDraft(draft), "submit");
    });
    const h = await model(adapter);
    expect(
      await h.host.generate(
        { ...input, reports: [report] },
        signal(),
        operation,
        () => committed,
      ),
    ).toEqual(committed);
    expect(adapter.requests).toHaveLength(2);
  });

  it("uses a scoped native tool, copied model config, SDK defaults and middleware, then releases its session", async () => {
    class DefaultsAdapter extends DigestAdapter {
      override async resolveModel(
        provider: string,
        id: string,
      ): Promise<LlmResolvedModelInfo> {
        return { provider, id, name: "Fixture digest", defaultMaxTokens: 1234 };
      }
    }
    const adapter = new DefaultsAdapter((request) =>
      digestSubmit(request, draft, usage),
    );
    const config = {
      provider: "digest-fixture",
      model: "digest",
      temperature: 0.3,
      stop: ["END"],
    };
    const h = await model(adapter, config);
    config.model = "changed";
    config.stop.push("CHANGED");
    let middlewareCalls = 0;
    h.ctx.on("llm/stream", async function* (request, next) {
      middlewareCalls++;
      expect(isAgentLoopRequest(request)).toBe(true);
      yield* next();
    });
    const submit = vi.fn(() => committed);
    expect(await h.host.generate(input, signal(), operation, submit)).toEqual(
      committed,
    );
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      digestBusinessDraft(businessDraft(draft), input),
    );
    expect(middlewareCalls).toBe(1);
    expect(adapter.requests).toHaveLength(1);
    for (const request of adapter.requests) {
      expect(request).toMatchObject({
        provider: "digest-fixture",
        model: "digest",
        maxTokens: 1234,
        temperature: 0.3,
        stop: ["END"],
      });
      expect(request.tools?.map((tool) => tool.name).sort()).toEqual(
        ["stock_submit", "stock_read_report"].sort(),
      );
    }
    const request = adapter.requests[0]!;
    expect(
      request.messages.find((message) => message.role === "user")!.content,
    ).toEqual([{ type: "text", text: expect.any(String) }]);
    const context = JSON.parse(
      (
        request.messages.find((message) => message.role === "user")!
          .content[0] as { text: string }
      ).text,
    );
    expect(Object.keys(context).sort()).toEqual(["context", "scope", "task"]);
    expect(context).toMatchObject({
      scope: input.scope,
      task: { id: input.taskId, role: "digest", objective: input.instruction },
      context: {
        materials: [],
        reportCatalog: [],
        requiredRisks: [],
      },
    });
    expect(context.outputContract).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain(operation.identity);
    expect(h.logs).toHaveLength(1);
    expect(
      h.logs.every(
        (log) =>
          log.kind === "digest" &&
          log.runId === operation.runId &&
          log.taskId === "digest" &&
          log.attempt === 7,
      ),
    ).toBe(true);
    expect(h.logs.map((log) => log.finish)).toEqual(["tool-calls"]);
    expect(h.logs.map((log) => log.usage)).toEqual([usage]);
    expect(h.logs[0]!.sessionId).toBe(request.sessionId);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    expect(h.ctx.sessions.get(request.sessionId!)).toBeUndefined();
    expect(h.ctx.tools.get("stock_submit")).toBeUndefined();
  });

  it("keeps the rejected report and precise feedback in DSH context, then publishes only the correction", async () => {
    const original = {
      ...draft,
      riskSummaries: [{ issueId: "invented", text: "An unsupported risk" }],
    };
    let turn = 0;
    const adapter = new DigestAdapter(async function* (request) {
      if (++turn === 1) {
        yield* toolCall("stock_submit", businessDraft(original), "bad-report");
        return;
      }
      const history = JSON.stringify(request.messages);
      expect(history).toContain("An unsupported risk");
      expect(history).toContain("Expected []");
      expect(history).toContain("invented");
      const feedback = request.messages.filter(
        (message) => message.role === "tool",
      );
      expect(JSON.stringify(feedback)).not.toContain(original.body);
      yield* toolCall("stock_submit", businessDraft(draft), "corrected-report");
    });
    const h = await model(adapter);
    const published: unknown[] = [];
    const submit = vi.fn((value: unknown) => {
      const artifact = assembleDigest(value, input);
      published.push(artifact);
      return committed;
    });
    expect(await h.host.generate(input, signal(), operation, submit)).toEqual(
      committed,
    );
    expect(submit).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      title: `${US_SECURITY.symbol} digest摘要`,
      payload: { risks: [], report: businessDraft(draft) },
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it("returns exact budget feedback to the model before accepting a corrected digest", async () => {
    const oversized = businessDraft(draft);
    oversized.content.keyPoints = ["事实".repeat(5000)];
    const length = [...JSON.stringify(oversized)].length;
    const fieldLength = [...JSON.stringify(oversized.content.keyPoints)].length;
    let turn = 0;
    const adapter = new DigestAdapter(async function* (request) {
      if (++turn === 1) {
        yield* toolCall("stock_submit", oversized, "too-long");
        return;
      }
      const feedback = JSON.stringify(
        request.messages.filter((message) => message.role === "tool"),
      );
      expect(feedback).toContain(`${length}/9000`);
      expect(feedback).toContain(`over by ${length - 9000}`);
      expect(feedback).toContain(`keyPoints=${fieldLength}`);
      yield* toolCall("stock_submit", businessDraft(draft), "corrected");
    });
    const h = await model(adapter);
    const submit = vi.fn(() => committed);
    await expect(
      h.host.generate(input, signal(), operation, submit),
    ).resolves.toEqual(committed);
    expect(submit).toHaveBeenCalledOnce();
    expect(adapter.requests).toHaveLength(2);
  });

  it("propagates storage failure without asking the model to repair it", async () => {
    const adapter = new DigestAdapter((request) =>
      digestSubmit(request, draft),
    );
    const h = await model(adapter);
    const failure = new ResearchError("STORAGE_FAILED", "Fixture write failed");
    await expect(
      h.host.generate(input, signal(), operation, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(adapter.requests).toHaveLength(1);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("ends after the canonical commit without requesting a model closing response", async () => {
    const adapter = new DigestAdapter(async function* (request) {
      if (request.messages.some((message) => message.role === "tool"))
        throw new HarnessError("Post-submit failure", "INVALID_INPUT");
      yield* toolCall("stock_submit", businessDraft(draft), "submit");
    });
    const h = await model(adapter);
    expect(
      await h.host.generate(input, signal(), operation, () => committed),
    ).toEqual(committed);
    expect(adapter.requests).toHaveLength(1);
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });

  it("rejects prose that ends without a successful tool submission", async () => {
    const h = await model(
      new DigestAdapter(() => digestText(JSON.stringify(draft))),
    );
    const submit = vi.fn(() => committed);
    await expect(
      h.host.generate(input, signal(), operation, submit),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("retains the SDK error identity and partial usage without a model retry", async () => {
    const failure = new HarnessError(
      "Fixture digest failure",
      "INVALID_INPUT",
      { cause: new Error("Provider rejected") },
    );
    const adapter = new DigestAdapter(async function* () {
      yield { type: "usage", usage };
      throw failure;
    });
    const h = await model(adapter);
    let sdkError: unknown;
    h.ctx.on("agent/error", ({ error }) => {
      sdkError = error;
    });
    const result = h.host.generate(input, signal(), operation, () => committed);
    await expect(result).rejects.toBeInstanceOf(LlmError);
    await expect(result).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: failure.message,
    });
    await expect(result).rejects.toBe(sdkError);
    expect(adapter.requests).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ finish: "error", usage });
  });

  it("waits for cancelled provider work and iterator cleanup before releasing the Agent", async () => {
    const gate = modelGate();
    let iteratorReleased = false;
    const adapter = new DigestAdapter(async function* (
      request,
    ): AsyncIterable<StreamChunk> {
      yield { type: "usage", usage };
      gate.started.resolve(request);
      try {
        await gate.released.promise;
        request.signal?.throwIfAborted();
      } finally {
        iteratorReleased = true;
      }
    });
    const h = await model(adapter);
    cleanups.push(async () => {
      gate.released.resolve();
    });
    const controller = new AbortController();
    const reason = new DOMException("Digest cancelled", "AbortError");
    let settled = false;
    const result = h.host
      .generate(input, controller.signal, operation, () => committed)
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
    await gate.started.promise;
    controller.abort(reason);
    await setImmediate();
    expect(settled).toBe(false);
    expect(iteratorReleased).toBe(false);
    gate.released.resolve();
    expect(await result).toEqual({ error: reason });
    expect(iteratorReleased).toBe(true);
    expect(h.logs[0]).toMatchObject({
      outcome: "committed",
      finish: null,
      usage,
    });
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
  });
});

import { type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { createDeepInput } from "../../src/app/deep-plan.js";
import { attachCollection } from "../../src/app/collection-input.js";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import { agentReportSchemas } from "../../src/contracts/agent-reports.js";
import { prepareResearchRole } from "../../src/app/prepare-role.js";
import { ROLE_PROMPTS } from "../../src/app/research-prompts.js";
import { createResearchPlugin } from "../../src/runtime.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { analysis } from "../fixtures/dispatch-host.js";
import { MARKET_FIXTURE } from "../fixtures/market.js";
import { runtimeHost, textResponse } from "../fixtures/runtime-host.js";
import { draftSubmission } from "../fixtures/draft-stream.js";
import { initialInput, toolCall } from "../fixtures/quick-host.js";
import {
  analysisReport,
  agentAnalysisReport,
  legacyAnalysisSubmission,
  analysisSubmission,
  reportHandoff,
} from "../fixtures/analysis-report.js";

const cleanups: (() => Promise<void>)[] = [];
async function host(
  respond?: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
) {
  const h = await runtimeHost(respond === undefined ? {} : { respond });
  cleanups.push(h.close);
  await h.ctx.plugin(
    createResearchPlugin((context, parent) =>
      prepareResearchRole(h.ctx.stockResearch, context, parent),
    ),
    h.config(),
  );
  const runtime = h.ctx.stockResearch;
  const sources = runtime.queries
    .health(h.scope)
    .sources.map(({ dataset, provider, capability }) => ({
      dataset,
      provider,
      capability,
    }));
  const input = createQuickInput(h.scope, runtime.policy, sources);
  return {
    ctx: h.ctx,
    runtime,
    input,
    scope: h.scope,
    agentOptions: h.agentOptions,
    adapter: h.adapter as { readonly requests: GenerateOptions[] },
  };
}
function prompt(provision: ReturnType<typeof prepareResearchRole>) {
  const block = provision.prompt[0]!;
  if (block.type !== "text") throw new Error("Expected application text input");
  return JSON.parse(block.text);
}
function collection(scope: ResearchScope): CollectionSnapshot {
  const envelope = {
    ...structuredClone(MARKET_FIXTURE),
    asOf: "2024-01-03T21:00:00.000Z",
    availableAt: "2024-01-03T21:00:00.000Z",
    retrievedAt: scope.cutoff,
    cutoff: scope.cutoff,
    gaps: [],
  };
  return {
    schemaVersion: 1,
    scope,
    failures: [],
    packets: [
      {
        id: "market.daily",
        envelope: {
          ...envelope,
          source: { ...envelope.source, provider: "yahoo" },
          data: {
            table: "market.daily",
            title: "日线",
            columns: {
              close: { label: "收盘价", unit: "USD/share", price: true },
            },
            currency: "USD",
            adjustment: "unadjusted",
            interval: "1d",
            rows: MARKET_FIXTURE.data.bars.slice(0, 2).map((bar) => ({
              date: bar.date,
              asOf: bar.asOf,
              availableAt: bar.availableAt,
              complete: bar.sessionComplete,
              values: { close: bar.close },
            })),
          },
        },
      },
      {
        id: "financial.indicators",
        envelope: {
          ...envelope,
          dataset: "fundamentals",
          source: { ...envelope.source, provider: "sec" },
          data: {
            table: "financial.indicators",
            title: "财务指标",
            columns: { revenue: { label: "营收", unit: "USD" } },
            rows: [
              {
                date: "2023-12-31",
                asOf: "2023-12-31T00:00:00.000Z",
                availableAt: scope.cutoff,
                complete: true,
                values: { revenue: 100 },
              },
            ],
          },
        },
      },
      {
        id: "macro.dgs10",
        envelope: {
          ...envelope,
          dataset: "macro",
          source: { ...envelope.source, provider: "fred" },
          data: {
            table: "macro.dgs10",
            title: "美国十年期国债收益率",
            columns: { value: { label: "收益率", unit: "percent" } },
            rows: [
              {
                date: "2024-01-03",
                asOf: "2024-01-03T00:00:00.000Z",
                availableAt: scope.cutoff,
                complete: true,
                values: { value: 4 },
              },
            ],
          },
        },
      },
    ],
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("persisted research role preparation", () => {
  it("provides direct input once and omits it from the lookup catalog", async () => {
    const h = await host();
    const debate = h.input.definition.tasks.find(
      (task) => task.id === "debate.1.bull",
    )!;
    debate.dependsOn = ["analysis.market"];
    debate.inputTasks = ["analysis.market"];
    const { runId } = h.runtime.runs.open("owner", h.input, "open-reader");
    const operation = { runId, identity: "owner" };
    const market = h.runtime.runs.claim(operation, "analysis.market", "market");
    const content = analysis();
    new ArtifactService(
      h.runtime.runs,
      new NumberService(h.runtime.runs),
    ).submitArtifact(
      { ...market, identity: "worker", sessionId: null },
      [content],
      "save-reader",
    );
    const provision = prepareResearchRole(
      h.runtime,
      h.runtime.runs.dispatchForCall(
        operation,
        "debate.1.bull",
        "debate-reader",
      ),
    );
    const input = prompt(provision);
    expect(input.context.materials).toEqual([
      { title: content.title, body: content.body },
    ]);
    expect(input.context.reportCatalog).toEqual([]);
    const reader = provision.tools.find(
      (tool) => tool.name === "stock_read_report",
    )!;
    const exec = { signal: new AbortController().signal } as ToolRunContext;
    await expect(
      reader.execute({ id: "report-1" }, exec),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(input.context.referencePrice).toBeNull();
    expect(JSON.stringify(input)).not.toContain(runId);
  });

  it.each(["22", "23"])(
    "assigns equity benchmarks to market and external prices and rates to macro under role protocol %s",
    async (version) => {
      const h = await host();
      h.input.versions.prompts.roles = version;
      const snapshot = collection(h.scope);
      for (const [id, title, unit, dataset, attributes] of [
        [
          "benchmark.shanghai.daily",
          "上证指数日线",
          "index",
          "market",
          { assetCode: "CN:000001.SH", assetType: "index" },
        ],
        [
          "benchmark.gold.daily",
          "现货黄金日线",
          "USD/troy_ounce",
          "market",
          { assetCode: "XAU/USD", assetType: "gold", instrument: "spot" },
        ],
        [
          "benchmark.bondYields",
          "中美10年期收益率",
          "percent",
          "macro",
          undefined,
        ],
      ] as const) {
        const envelope = structuredClone(snapshot.packets[0]!.envelope);
        envelope.dataset = dataset;
        envelope.data = {
          table: id,
          title,
          interval: "1d",
          columns: { close: { label: title, unit } },
          basis: "source_reported",
          ...(attributes && { attributes: { ...attributes } }),
          rows: [
            {
              date: "2024-01-03",
              asOf: envelope.asOf,
              availableAt: null,
              complete: true,
              values: { close: 100 },
            },
          ],
        };
        snapshot.packets.push({ id, envelope });
      }
      attachCollection(h.input, snapshot);
      const { runId } = h.runtime.runs.open(
        "owner",
        h.input,
        "open-benchmarks",
      );
      for (const [taskId, expected] of [
        ["analysis.market", ["market.daily", "benchmark.shanghai.daily"]],
        [
          "analysis.macro",
          ["macro.dgs10", "benchmark.gold.daily", "benchmark.bondYields"],
        ],
      ] as const) {
        const context = h.runtime.runs.dispatchForCall(
          { runId, identity: "owner" },
          taskId,
          taskId,
        );
        const prepared = prompt(prepareResearchRole(h.runtime, context));
        expect(
          prepared.context.dataCatalog.map(
            (source: { id: string }) => source.id,
          ),
        ).toEqual(expected);
        if (taskId === "analysis.market") continue;
        expect(prepared.context.dataCatalog).toContainEqual(
          expect.objectContaining({
            id: "benchmark.gold.daily",
            title: "现货黄金日线",
            interval: "1d",
            basis: "source_reported",
          }),
        );
        const gold = h.runtime.runs
          .numberContext(runId)
          .evidence.find(
            (entry) =>
              entry.taskId === taskId &&
              entry.callId === "collection:benchmark.gold.daily",
          )!;
        expect(
          h.runtime.runs.readEvidence({ runId, evidenceId: gold.evidenceId })
            .envelope.data,
        ).toMatchObject({
          attributes: {
            assetCode: "XAU/USD",
            assetType: "gold",
            instrument: "spot",
          },
          columns: { close: { label: "现货黄金日线", unit: "USD/troy_ounce" } },
        });
      }
    },
  );

  it("shares the appropriate collected datasets with the additional deep analysts", async () => {
    const h = await host();
    const input = attachCollection(
      createDeepInput(h.scope, h.runtime.policy, []),
      collection(h.scope),
    );
    const { runId } = h.runtime.runs.open("owner", input, "open-deep");
    for (const [taskId, table] of [
      ["analysis.business", "financial.indicators"],
      ["analysis.geopolitics", "macro.dgs10"],
      ["analysis.sentiment", "market.daily"],
    ] as const) {
      const context = h.runtime.runs.dispatchForCall(
        { runId, identity: "owner" },
        taskId,
        taskId,
      );
      const prepared = prompt(prepareResearchRole(h.runtime, context));
      expect(
        prepared.context.dataCatalog.map((source: { id: string }) => source.id),
      ).toEqual([table]);
      expect(prepared.task.id).toBe(taskId);
      expect(prepared).not.toHaveProperty("fixedQueries");
      expect(JSON.stringify(prepared)).not.toContain('"rows":');
    }
  });

  it("registers only the current task's fixed datasets without duplicating history in the prompt", async () => {
    const h = await host();
    attachCollection(h.input, collection(h.scope));
    const { runId } = h.runtime.runs.open("owner", h.input, "open");
    const context = h.runtime.runs.dispatchForCall(
      { runId, identity: "owner" },
      "analysis.market",
      "market",
    );
    const provision = prepareResearchRole(h.runtime, context);
    const prepared = prompt(provision);
    expect(prepared.context.dataCatalog).toHaveLength(1);
    const source = prepared.context.dataCatalog[0]!;
    expect(source).toMatchObject({
      id: "market.daily",
      recordCount: 2,
      range: { from: "2024-01-02", to: "2024-01-03" },
      quality: {
        stale: false,
        historicalKnowledge: "verified",
        missingValues: 0,
      },
    });
    for (const field of [
      "latest",
      "columns",
      "candidateClaims",
      "gaps",
      "source",
      "attributes",
      "sourceRef",
    ])
      expect(source).not.toHaveProperty(field);
    const registered = h.runtime.runs.numberContext(runId).evidence[0]!;
    expect(
      h.runtime.runs.readEvidence({ runId, evidenceId: registered.evidenceId })
        .envelope.data,
    ).toMatchObject({
      table: "market.daily",
      rows: [{ values: { close: 10 } }, { values: { close: 12 } }],
    });
    const read = provision.tools.find(
      (tool) => tool.name === "stock_read_collection",
    )!;
    const exec = { signal: new AbortController().signal } as ToolRunContext;
    const rows = await read.execute(
      {
        table: "market.daily",
        fields: ["close"],
        offset: 0,
        limit: 1,
      },
      exec,
    );
    expect(rows).toMatchObject({
      data: { rows: [{ index: 0, values: { close: 10 } }] },
    });
    expect(rows).not.toHaveProperty("candidateClaims");
    expect(rows).not.toHaveProperty("sourceRef");
    await expect(
      provision.tools
        .find((tool) => tool.name === "stock_describe_collection")!
        .execute({ table: "financial.indicators" }, exec),
    ).rejects.toMatchObject({ code: "DATA_INSUFFICIENT" });
    expect(JSON.stringify(prepared)).not.toContain('"rows":');
    expect(prompt(prepareResearchRole(h.runtime, context))).toEqual(prepared);
    expect(h.runtime.runs.numberContext(runId).evidence).toHaveLength(1);
  });
  it("prepares the saved policy, instructions and exact upstream artifact contents", async () => {
    const h = await host();
    const fundamentals = h.input.definition.tasks.find(
      (task) => task.id === "analysis.fundamentals",
    )!;
    fundamentals.dependsOn = ["analysis.market"];
    fundamentals.inputTasks = ["analysis.market"];
    const captured = h.input.inputs[0]!.content as {
      policy: { secCiks: Record<string, string> };
    };
    captured.policy.secCiks[h.scope.security.id] = "0000123456";
    const { runId } = h.runtime.runs.open("owner", h.input, "open");
    captured.policy.secCiks = {};
    const operation = { runId, identity: "owner" };
    const market = h.runtime.runs.claim(operation, "analysis.market", "market");
    const content = analysis();
    new ArtifactService(
      h.runtime.runs,
      new NumberService(h.runtime.runs),
    ).submitArtifact(
      { ...market, identity: "worker", sessionId: null },
      [content],
      "save",
    );
    const context = h.runtime.runs.dispatchForCall(
      operation,
      "analysis.fundamentals",
      "fundamentals",
    );
    h.input.instructions!.find(
      (item) => item.taskId === "analysis.fundamentals",
    )!.instruction = "Caller mutation";
    const provision = prepareResearchRole(h.runtime, context);
    const prepared = prompt(provision);
    expect(prepared.task.objective).toContain("12个报告期");
    expect(prepared).not.toHaveProperty("inputRefs");
    expect(prepared.context.materials).toEqual([
      { title: content.title, body: content.body },
    ]);
    expect(prepared.scope).toEqual(h.scope);
    expect(prepared).not.toHaveProperty("secIssuerConfigured");
    expect(provision.agentPreset).toBeUndefined();
    expect(provision.systemPrompt).toBe(ROLE_PROMPTS.analyst);
    expect(provision.tools).toHaveLength(7);
    expect(provision.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "stock_describe_collection",
        "stock_read_collection",
      ]),
    );
    const save = provision.tools.find(
      (tool) => tool.name === "stock_submit",
    )!.parameters;
    expect(validateJsonSchemaValue(save, {})).toEqual([]);
    expect(
      validateJsonSchemaValue(save, agentAnalysisReport()).length,
    ).toBeGreaterThan(0);
    expect(
      validateJsonSchemaValue(save, {
        requestId: "save",
        contents: [{ ...analysis(), kind: "risk", payload: { issues: [] } }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      provision.tools.some((tool) => tool.name === "stock_check_numbers"),
    ).toBe(false);
    for (const tool of provision.tools.filter(
      (tool) =>
        ![
          "stock_read_run",
          "stock_read_artifact",
          "stock_read_evidence",
          "stock_check_numbers",
          "stock_save_report",
        ].includes(tool.name),
    )) {
      expect(tool.parameters.properties ?? {}).not.toHaveProperty("source");
      expect(tool.parameters.properties ?? {}).not.toHaveProperty("runId");
    }
    expect(
      provision.tools.some(
        (tool) =>
          tool.name.startsWith("stock_get_") || tool.name === "stock_research",
      ),
    ).toBe(false);
    expect(
      provision.tools.some((tool) =>
        [
          "stock_read_run",
          "stock_read_artifact",
          "stock_read_evidence",
        ].includes(tool.name),
      ),
    ).toBe(false);
    expect(prepared.context.dataCatalog).toEqual([]);
    expect(prepared).not.toHaveProperty("sourceCatalogue");
  });

  it("keeps claim-fixed instructions and read-only tools in replay preparation", async () => {
    const h = await host();
    const { runId } = h.runtime.runs.open("owner", h.input, "open");
    const operation = { runId, identity: "owner" };
    const first = h.runtime.runs.dispatchForCall(
      operation,
      "analysis.market",
      "first",
    );
    const original = prompt(prepareResearchRole(h.runtime, first));
    h.runtime.runs.failAttempt(
      { ...first.claim, identity: "worker", sessionId: null },
      { code: "MODEL_FAILED", message: "Fixture failure" },
      "failed",
    );
    h.runtime.runs.resume(
      operation,
      {
        resolvedReasonIds: [],
        instructions: [
          {
            taskId: "analysis.market",
            instruction: "Revised necessary market request",
          },
        ],
      },
      "resume",
    );
    const second = h.runtime.runs.dispatchForCall(
      operation,
      "analysis.market",
      "second",
    );
    expect(prompt(prepareResearchRole(h.runtime, first)).task.objective).toBe(
      original.task.objective,
    );
    expect(prompt(prepareResearchRole(h.runtime, second)).task).toMatchObject({
      objective: "Revised necessary market request",
    });
    const replay = h.runtime.runs.open(
      "owner",
      { replay: { runId }, versions: h.input.versions },
      "replay",
    );
    const context = h.runtime.runs.dispatchForCall(
      { ...replay, identity: "owner" },
      "analysis.market",
      "claim",
    );
    const provision = prepareResearchRole(h.runtime, context);
    expect(prompt(provision)).toMatchObject({
      task: { objective: "Revised necessary market request" },
      context: { dataCatalog: original.context.dataCatalog },
    });
    expect(
      provision.tools.some(
        (tool) =>
          tool.name.startsWith("stock_get_") || tool.name === "stock_research",
      ),
    ).toBe(false);
    expect(provision.tools.some((tool) => tool.name === "stock_recall")).toBe(
      false,
    );
    expect(prompt(provision)).not.toHaveProperty("replay");
  });

  it.each(["missing", "unsupported", "malformed"] as const)(
    "rejects %s application snapshots explicitly",
    async (problem) => {
      const h = await host();
      if (problem === "missing") h.input.inputs = [];
      else if (problem === "unsupported")
        h.input.inputs[0]!.content = { schemaVersion: 2 };
      else h.input.inputs[0]!.content = { schemaVersion: 1, policy: {} };
      const { runId } = h.runtime.runs.open("owner", h.input, "open");
      const context = h.runtime.runs.dispatchForCall(
        { runId, identity: "owner" },
        "analysis.market",
        "claim",
      );
      expect(() => prepareResearchRole(h.runtime, context)).toThrowError(
        expect.objectContaining({
          code:
            problem === "malformed" ? "STORAGE_FAILED" : "VERSION_UNAVAILABLE",
        }),
      );
    },
  );

  it("rejects an unrecorded initial instruction without substituting the current template", async () => {
    const h = await host();
    delete h.input.instructions;
    const { runId } = h.runtime.runs.open("owner", h.input, "open");
    const context = h.runtime.runs.dispatchForCall(
      { runId, identity: "owner" },
      "analysis.market",
      "claim",
    );
    expect(() => prepareResearchRole(h.runtime, context)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("loads the saved public role policy and submits native business JSON with scoped tools", async () => {
    let calls = 0;
    const h = await host(async function* () {
      if (++calls > 1) {
        yield* textResponse("Gap analysis submitted.");
        return;
      }
      yield* analysisSubmission(analysisReport(), "save");
    });
    const savedPrompt =
      "Saved application analyst policy; preserve missing evidence.";
    const profile = h.input.inputs[0]!.content as {
      prompts: { analyst: string };
    };
    profile.prompts.analyst = savedPrompt;
    const { runId } = h.runtime.runs.open("owner", h.input, "open");
    const parent = await h.runtime.createAgent(
      h.agentOptions("application-coordinator"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      runId,
      "analysis.market",
      "dispatch",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", failure: null });
    expect(h.adapter.requests).toHaveLength(1);
    expect(
      h.adapter.requests[0]!.tools?.map((tool) => tool.name).sort(),
    ).toEqual(
      [
        "stock_describe_collection",
        "stock_read_collection",
        "stock_read_report",
        "stock_read_report_draft",
        "stock_submit",
        "stock_write_handoff",
        "stock_write_report",
      ].sort(),
    );
    const systemMessages = h.adapter.requests[0]!.messages.filter(
      (message) => message.role === "system",
    );
    expect(systemMessages).toHaveLength(1);
    expect(JSON.stringify(systemMessages)).toContain(savedPrompt);
    expect(JSON.stringify(systemMessages)).not.toContain(ROLE_PROMPTS.analyst);
    expect(h.runtime.runs.readArtifact(result.refs[0]!).content).toMatchObject({
      kind: "analysis",
      payload: { schemaVersion: 3, report: agentAnalysisReport() },
      claims: [],
    });
    expect(h.ctx.agents.get(SessionId(result.sessionId!))).toBeUndefined();
    expect(h.ctx.sessions.get(SessionId(result.sessionId!))).toBeUndefined();
    await parent.dispose();
  });

  it("submits saved protocol 19 business JSON with its recorded prompt and input", async () => {
    const report = agentAnalysisReport();
    const h = await host(async function* () {
      yield* toolCall("stock_submit", report, "submit-v19");
    });
    h.input.versions.prompts.roles = "19";
    const savedPrompt = "Saved version 19 analyst policy.";
    const savedObjective = "Saved version 19 research objective.";
    (
      h.input.inputs[0]!.content as { prompts: { analyst: string } }
    ).prompts.analyst = savedPrompt;
    h.input.instructions!.find(
      ({ taskId }) => taskId === "analysis.market",
    )!.instruction = savedObjective;
    const { runId } = h.runtime.runs.open("owner", h.input, "open-v19");
    const parent = await h.runtime.createAgent(
      h.agentOptions("v19-coordinator"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      runId,
      "analysis.market",
      "dispatch-v19",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "succeeded", failure: null });
    expect(h.adapter.requests).toHaveLength(1);
    const request = h.adapter.requests[0]!;
    expect(request.tools!.map(({ name }) => name).sort()).toEqual([
      "stock_describe_collection",
      "stock_read_collection",
      "stock_read_report",
      "stock_submit",
    ]);
    const schema = request.tools!.find(
      ({ name }) => name === "stock_submit",
    )!.parameters;
    expect(schema).toEqual(agentReportSchemas.analysis);
    expect(validateJsonSchemaValue(schema, report)).toEqual([]);
    expect(validateJsonSchemaValue(schema, {}).length).toBeGreaterThan(0);
    expect(
      JSON.stringify(request.messages.filter(({ role }) => role === "system")),
    ).toContain(savedPrompt);
    expect(
      initialInput<{ task: { objective: string } }>(request).task.objective,
    ).toBe(savedObjective);
    expect(
      h.runtime.runs.readArtifact(result.refs[0]!).content.payload,
    ).toMatchObject({ schemaVersion: 3, report });
    await parent.dispose();
  });

  it("publishes the six business sections and a code-selected closing price without model references", async () => {
    const report = analysisReport();
    report.current_state = ["人工快照最近完整日线收盘为12美元/股。"];
    const h = await host(async function* () {
      yield* analysisSubmission(report, "stage-analysis");
    });
    attachCollection(h.input, collection(h.scope));
    const { runId } = h.runtime.runs.open("owner", h.input, "open-stage");
    const parent = await h.runtime.createAgent(
      h.agentOptions("stage-coordinator"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      runId,
      "analysis.market",
      "dispatch-stage",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    const artifact = h.runtime.runs.readArtifact(result.refs[0]!);
    expect(artifact.content.payload).toEqual({
      schemaVersion: 3,
      report: agentAnalysisReport(report),
      stageHandoff: reportHandoff(agentAnalysisReport(report)),
    });
    expect(artifact.content.body).toContain(report.assessment);
    expect(artifact.content.body).toContain(report.analysis_model.mechanism);
    expect(artifact.content.body).not.toContain("{{number:");
    expect(artifact.content.claims).toEqual([
      expect.objectContaining({
        id: "market.close",
        value: 12,
        unit: "USD/share",
        kind: "observed",
      }),
    ]);
    const request = JSON.stringify(h.adapter.requests[0]!.messages);
    for (const hidden of [
      runId,
      "sourceRef",
      "candidateClaims",
      "inputRefs",
      "draftFile",
    ])
      expect(request).not.toContain(hidden);
    const input = prompt(
      prepareResearchRole(
        h.runtime,
        h.runtime.runs.dispatchForCall(
          { runId, identity: parent.agent.id },
          "analysis.market",
          JSON.stringify(["dispatch", "dispatch-stage"]),
        ),
      ),
    );
    expect(input.context.coverage.availableOutsideTask).toEqual([
      "financial.indicators",
      "macro.dgs10",
    ]);
    expect(h.runtime.runs.numberContext(runId).evidence).toHaveLength(1);
    await parent.dispose();
  });

  it.each(["missing", "incomplete", "after-cutoff", "late-available"] as const)(
    "keeps the business report when the latest closing price is %s",
    async (condition) => {
      const h = await host(async function* () {
        yield* analysisSubmission(
          analysisReport(),
          `without-anchor-${condition}`,
        );
      });
      const snapshot = collection(h.scope);
      const latest = snapshot.packets[0]!.envelope.data.rows.at(-1)!;
      if (condition === "missing") latest.values.close = null;
      if (condition === "incomplete") latest.complete = false;
      if (condition === "after-cutoff")
        latest.asOf = "2024-01-04T00:00:00.000Z";
      if (condition === "late-available")
        latest.availableAt = "2024-01-04T00:00:00.000Z";
      attachCollection(h.input, snapshot);
      const { runId } = h.runtime.runs.open(
        "owner",
        h.input,
        `open-${condition}`,
      );
      const parent = await h.runtime.createAgent(
        h.agentOptions(`no-anchor-${condition}`),
        { kind: "coordinator", runIds: [runId] },
        [],
      );
      const result = await h.runtime.dispatch.dispatch(
        parent.agent,
        runId,
        "analysis.market",
        `dispatch-${condition}`,
        new AbortController().signal,
      );
      expect(result.status).toBe("succeeded");
      expect(
        h.runtime.runs.readArtifact(result.refs[0]!).content.claims,
      ).toEqual([]);
      await parent.dispose();
    },
  );

  it.each(["12", "13"])(
    "uses the saved version %s business prompt and tool protocol",
    async (version) => {
      const h = await host(async function* () {
        yield* legacyAnalysisSubmission();
      });
      h.input.versions.prompts.roles = version;
      const profile = h.input.inputs[0]!.content as {
        prompts: { analyst: string };
      };
      profile.prompts.analyst = "Saved version 12 analyst policy.";
      const { runId } = h.runtime.runs.open("owner", h.input, "open-v12");
      const parent = await h.runtime.createAgent(
        h.agentOptions("v12-coordinator"),
        { kind: "coordinator", runIds: [runId] },
        [],
      );
      const result = await h.runtime.dispatch.dispatch(
        parent.agent,
        runId,
        "analysis.market",
        "dispatch-v12",
        new AbortController().signal,
      );
      expect(result.status).toBe("succeeded");
      expect(h.adapter.requests[0]!.tools).toHaveLength(6);
      expect(h.adapter.requests[0]!.tools!.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "stock_describe_collection",
          "stock_read_collection",
        ]),
      );
      expect(JSON.stringify(h.adapter.requests[0]!.messages)).toContain(
        profile.prompts.analyst,
      );
      expect(
        h.runtime.runs.readArtifact(result.refs[0]!).content.payload,
      ).toMatchObject({
        schemaVersion: 2,
        assessment: analysisReport().assessment,
      });
      await parent.dispose();
    },
  );

  it("uses the saved version 11 draft and tool protocol for historical roles", async () => {
    const h = await host(async function* () {
      yield* draftSubmission(
        "stock_save_report",
        analysis(),
        "legacy-analysis",
      );
    });
    h.input.versions.prompts.roles = "11";
    const profile = h.input.inputs[0]!.content as {
      prompts: { analyst: string };
      guides: { analysis: string };
    };
    profile.prompts.analyst =
      "Saved legacy analyst policy with Markdown drafts.";
    profile.guides.analysis = "Saved legacy analysis container contract.";
    const { runId } = h.runtime.runs.open("owner", h.input, "open-legacy");
    const parent = await h.runtime.createAgent(
      h.agentOptions("legacy-coordinator"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      runId,
      "analysis.market",
      "dispatch-legacy",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(h.adapter.requests[0]!.tools).toHaveLength(11);
    expect(JSON.stringify(h.adapter.requests[0]!.messages)).toContain(
      profile.prompts.analyst,
    );
    expect(
      h.runtime.runs.readArtifact(result.refs[0]!).content.payload,
    ).toEqual(analysis().payload);
    await parent.dispose();
  });

  it("rejects an unknown saved role protocol instead of substituting the current contract", async () => {
    const h = await host();
    h.input.versions.prompts.roles = "unknown";
    const { runId } = h.runtime.runs.open(
      "owner",
      h.input,
      "unknown-role-protocol",
    );
    const context = h.runtime.runs.dispatchForCall(
      { runId, identity: "owner" },
      "analysis.market",
      "unknown",
    );
    expect(() => prepareResearchRole(h.runtime, context)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });
});

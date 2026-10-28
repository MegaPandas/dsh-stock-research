import { SessionId } from "@deepseek-ai/dsh-session";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import { bindScopeParent, createScope } from "@deepseek-ai/dsh-scope";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { prepareResearchRole } from "../../src/app/prepare-role.js";
import { PUBLIC_RESEARCH_PROMPT_INPUT } from "../../src/app/public-research.js";
import {
  APPLICATION_INPUT_NAME,
  captureApplicationInput,
  readApplicationInput,
} from "../../src/app/research-input.js";
import { createResearchPlugin } from "../../src/runtime.js";
import {
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
} from "../../src/tools/parameters.js";
import {
  analysisReport,
  analysisSubmission,
} from "../fixtures/analysis-report.js";
import {
  initialInput,
  lastToolResult,
  lastToolText,
  toolCall,
} from "../fixtures/quick-host.js";
import { runtimeHost } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup(
  publicSearchLimit?: number,
  respond?: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
) {
  const nativeSearch = vi.fn<ToolDefinition["execute"]>(async () => ({
    sources: Array.from({ length: 9 }, (_, index) => ({
      title: `Product ${index}`,
      url: `https://example.com/product/${index}`,
      snippet: "Delivered 12,345 products in the latest quarter.",
      publishedAt: "provider time hint",
    })),
    truncated: false,
  }));
  const h = await runtimeHost({
    search: async () => {
      throw new Error("The native search fixture owns the external response.");
    },
    respond:
      respond ??
      async function* (request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield* toolCall(
            "stock_search_public",
            { query: "EXAMPLE product deliveries" },
            "public-search",
          );
        } else if (
          lastToolResult<{ sources?: unknown[] }>(request).sources !== undefined
        ) {
          yield* analysisSubmission();
        }
      },
  });
  cleanups.push(h.close);
  const native: ToolDefinition = {
    name: "web_search",
    description: "Configured host search fixture",
    parameters: objectSchema({
      queries: { type: "array", items: stringSchema },
    }),
    output: resultOutput(opaqueObjectSchema),
    execute: nativeSearch,
  };
  const unregisterNative = h.ctx.tools.register(native);
  await h.ctx.plugin(
    createResearchPlugin((context, parent) =>
      prepareResearchRole(h.ctx.stockResearch, context, parent),
    ),
    h.config({ enabledSources: ["sina", "fred", "dsh-web"] }),
  );
  const scope = {
    ...h.scope,
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: h.scope.security.timeZone,
    }).format(new Date()),
    cutoff: new Date(Date.now() - 60_000).toISOString(),
  };
  const input = createQuickInput(scope, h.ctx.stockResearch.policy, []);
  if (publicSearchLimit !== undefined)
    input.inputs.find(({ name }) => name === APPLICATION_INPUT_NAME)!.content =
      captureApplicationInput(
        h.ctx.stockResearch.policy,
        [],
        publicSearchLimit,
      );
  return {
    ...h,
    runtime: h.ctx.stockResearch,
    input,
    nativeSearch,
    native,
    unregisterNative,
  };
}

describe("public research analyst", () => {
  it("uses its recorded prompt and allowance with host-configured results and business-only submission", async () => {
    const limit = 2;
    const h = await setup(limit);
    const savedPrompt = "Saved public analyst policy.";
    h.input.inputs.find(
      ({ name }) => name === PUBLIC_RESEARCH_PROMPT_INPUT,
    )!.content = savedPrompt;
    const { runId } = h.runtime.runs.open("owner", h.input, "public-run");
    const parent = await h.runtime.createAgent(
      h.agentOptions("public-parent"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      runId,
      "analysis.public",
      "public-dispatch",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    const request = h.adapter.requests[0]!;
    expect(request.tools!.map(({ name }) => name).sort()).toEqual([
      "stock_read_report",
      "stock_read_report_draft",
      "stock_search_public",
      "stock_submit",
      "stock_write_handoff",
      "stock_write_report",
    ]);
    expect(
      JSON.stringify(request.messages.filter(({ role }) => role === "system")),
    ).toContain(savedPrompt);
    const prompt = initialInput<{
      context: {
        publicSearch: { maxSearches: number; savedSearches: unknown[] };
      };
    }>(request);
    expect(prompt.context.publicSearch).toMatchObject({
      maxSearches: limit,
      savedSearches: [],
    });
    expect(prompt.context.publicSearch).not.toHaveProperty("maxResults");
    expect(
      request.tools!.find(({ name }) => name === "stock_search_public")!
        .description,
    ).toContain(`前${limit}次免审批`);
    expect(prompt).not.toHaveProperty("collectionSources");
    expect(h.nativeSearch).toHaveBeenCalledOnce();
    expect(h.nativeSearch.mock.calls[0]![0]).toEqual({
      queries: ["EXAMPLE product deliveries"],
    });
    const response = lastToolResult<{
      sources: unknown[];
      budget: { limit: number; used: number; remaining: number };
    }>(h.adapter.requests[1]!);
    expect(response.sources).toHaveLength(9);
    expect(response.budget).toEqual({ limit, used: 1, remaining: limit - 1 });
    expect(JSON.stringify(response)).not.toMatch(
      /sourceRef|candidateClaims|evidenceId/,
    );
    const artifact = h.runtime.runs.readArtifact(result.refs[0]!).content;
    expect(artifact.claims).toEqual([]);
    expect(artifact.payload).toMatchObject({ schemaVersion: 3 });
    expect(artifact.body).toContain("公开检索截至：");
    const evidence = h.runtime.runs.numberContext(runId).evidence;
    expect(evidence).toHaveLength(1);
    const record = h.runtime.runs.readEvidence({
      runId,
      evidenceId: evidence[0]!.evidenceId,
    });
    expect(record.envelope.data).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          snippet: "Delivered 12,345 products in the latest quarter.",
        }),
      ]),
    });
    expect(record.envelope.retrievedAt > h.input.definition.scope.cutoff).toBe(
      true,
    );
    expect(h.ctx.agents.get(SessionId(result.sessionId!))).toBeUndefined();
    await parent.dispose();
  });

  it("restores the original allowance for saved application inputs without the field", async () => {
    const h = await setup();
    const saved = h.input.inputs.find(
      ({ name }) => name === APPLICATION_INPUT_NAME,
    )!.content as Record<string, unknown>;
    delete saved.publicSearchLimit;
    const { runId } = h.runtime.runs.open("owner", h.input, "legacy-allowance");
    expect(readApplicationInput(h.runtime.runs, runId).publicSearchLimit).toBe(
      8,
    );
  });

  it("uses the recorded allowance when preparing a legacy public analyst", async () => {
    const h = await setup(2);
    h.input.versions.prompts.roles = "17";
    const { runId } = h.runtime.runs.open(
      "owner",
      h.input,
      "legacy-public-role",
    );
    const context = h.runtime.runs.dispatchForCall(
      { runId, identity: "owner" },
      "analysis.public",
      "claim",
    );
    const provision = prepareResearchRole(h.runtime, context);
    const prompt = provision.prompt[0]!;
    if (prompt.type !== "text")
      throw new Error("Expected the legacy role's fixed text input");
    expect(JSON.parse(prompt.text).publicSearch.maxSearches).toBe(2);
    expect(
      provision.tools.find(({ name }) => name === "stock_search_public")!
        .description,
    ).toContain("前2次免审批");
    expect(h.nativeSearch).not.toHaveBeenCalled();
  });

  it("renews the configured allowance for each redone public analyst attempt", async () => {
    const h = await setup(1);
    const { runId } = h.runtime.runs.open("owner", h.input, "public-redo");
    const parent = await h.runtime.createAgent(
      h.agentOptions("public-redo-parent"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2)
        await h.runtime.dispatch.redo(
          { runId, identity: parent.agent.id },
          "analysis.public",
          "redo-public",
        );
      const result = await h.runtime.dispatch.dispatch(
        parent.agent,
        runId,
        "analysis.public",
        `public-${attempt}`,
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "succeeded", attempt });
      const requests = h.adapter.requests.filter(
        ({ sessionId }) => sessionId === result.sessionId,
      );
      expect(lastToolResult<{ budget: object }>(requests[1]!).budget).toEqual({
        limit: 1,
        used: 1,
        remaining: 0,
      });
    }
    expect(h.nativeSearch).toHaveBeenCalledTimes(2);
    await parent.dispose();
  });

  it("finishes from saved materials after repeated native refusals and renews search on redo", async () => {
    const closedResponses: string[] = [];
    const limitation =
      "继续公开检索未获批准，分析仅使用已取得材料，竞品规划仍待核实。";
    const h = await setup(1, async function* (request) {
      const searches = request.messages.filter(
        (message) => message.role === "tool",
      ).length;
      if (searches >= 3) closedResponses.push(lastToolText(request));
      if (searches < 4)
        yield* toolCall(
          "stock_search_public",
          { query: `EXAMPLE product deliveries ${searches}` },
          `public-search-${searches}`,
        );
      else {
        const report = analysisReport();
        report.handoff.limitations = [limitation];
        yield* analysisSubmission(report);
      }
    });
    if (h.ctx.get("approval") === undefined)
      await h.ctx.plugin(ApprovalService, {});
    h.unregisterNative();
    const presetKey = {};
    await h.ctx.plugin({
      name: "public-search-preset-fixture",
      inject: ["tools"],
      apply(presetCtx: Context) {
        const scope = createScope(presetCtx, presetKey);
        presetCtx.effect(() => scope.rawDispose);
        scope.ctx.tools.register(h.native);
      },
    });
    let approvals = 0;
    const searchCountsAtApproval: number[] = [];
    h.ctx.on("approval/request", async () => {
      approvals += 1;
      searchCountsAtApproval.push(h.nativeSearch.mock.calls.length);
      return "rejected";
    });
    const { runId } = h.runtime.runs.open("owner", h.input, "public-refusals");
    const parent = await h.ctx.agents.create({
      ...h.agentOptions("public-refusals-parent"),
      setup(_ctx, agent) {
        bindScopeParent(agent, presetKey);
      },
    });
    const release = h.runtime.bindCoordinator(parent.agent);
    parent.agent.ctx.effect(() => release);
    h.runtime.authorizeCoordinatorRun(parent.agent, runId);
    expect(h.ctx.tools.get("web_search")).toBeUndefined();
    expect(h.ctx.tools.get("web_search", parent.agent)).toBe(h.native);
    parent.agent.session.append("turn/start", { turn: 1 });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2)
        await h.runtime.dispatch.redo(
          { runId, identity: parent.agent.id },
          "analysis.public",
          "redo-refused-public",
        );
      const result = await h.runtime.dispatch.dispatch(
        parent.agent,
        runId,
        "analysis.public",
        `public-refusals-${attempt}`,
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "succeeded", attempt });
      expect(
        h.runtime.runs.readArtifact(result.refs[0]!).content.body,
      ).toContain(limitation);
      expect(h.nativeSearch).toHaveBeenCalledTimes(attempt);
      expect(approvals).toBe(attempt * 2);
    }
    expect(closedResponses).toHaveLength(4);
    expect(searchCountsAtApproval).toEqual([1, 1, 2, 2]);
    for (const response of closedResponses) {
      expect(response).toContain("Search is paused");
      expect(response).toContain(
        "Complete the draft using the existing data and materials",
      );
    }
    await parent.dispose();
  });

  it("replays a public search from its saved query directory without a new host request", async () => {
    const h = await setup();
    const { runId } = h.runtime.runs.open("owner", h.input, "original-public");
    const original = await h.runtime.createAgent(
      h.agentOptions("original-parent"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const first = await h.runtime.dispatch.dispatch(
      original.agent,
      runId,
      "analysis.public",
      "first",
      new AbortController().signal,
    );
    expect(first.status).toBe("succeeded");
    await original.dispose();
    const replay = h.runtime.runs.open(
      "owner",
      { replay: { runId }, versions: h.input.versions },
      "replay-public",
    );
    const parent = await h.runtime.createAgent(
      h.agentOptions("replay-parent"),
      { kind: "coordinator", runIds: [replay.runId] },
      [],
    );
    const result = await h.runtime.dispatch.dispatch(
      parent.agent,
      replay.runId,
      "analysis.public",
      "replay",
      new AbortController().signal,
    );
    expect(result.status).toBe("succeeded");
    expect(h.nativeSearch).toHaveBeenCalledOnce();
    const replayRequest = h.adapter.requests.find(
      (request) => request.sessionId === result.sessionId,
    )!;
    expect(
      initialInput<{ context: { publicSearch: { savedSearches: unknown[] } } }>(
        replayRequest,
      ).context.publicSearch.savedSearches,
    ).toEqual([
      expect.objectContaining({
        query: "EXAMPLE product deliveries",
        resultCount: 9,
      }),
    ]);
    await parent.dispose();
  });

  it("requires the saved public analyst prompt", async () => {
    const h = await setup();
    h.input.inputs = h.input.inputs.filter(
      ({ name }) => name !== PUBLIC_RESEARCH_PROMPT_INPUT,
    );
    const { runId } = h.runtime.runs.open(
      "owner",
      h.input,
      "missing-public-prompt",
    );
    const context = h.runtime.runs.dispatchForCall(
      { runId, identity: "owner" },
      "analysis.public",
      "claim",
    );
    expect(() => prepareResearchRole(h.runtime, context)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
    expect(h.nativeSearch).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import { SessionBindings, taskOperation } from "../../src/host/bindings.js";
import {
  searchPublic,
  approvePublicSearch,
} from "../../src/host/public-search.js";
import { RunService } from "../../src/services/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";
import type { OpenRunInput, RunState } from "../../src/contracts/runs.js";
import { runtimeHost, markerTool } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(
  date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date()),
) {
  const h = await runtimeHost();
  cleanups.push(h.close);
  const root = new DataRoot(h.directory);
  cleanups.push(async () => root.close());
  const runs = new RunService(new RunStore<RunState>(root), () =>
    new Date().toISOString(),
  );
  const input: OpenRunInput = {
    definition: {
      scope: { ...h.scope, date, cutoff: `${date}T22:00:00.000Z` },
      mode: "quick",
      tasks: [
        {
          id: "research",
          executor: { kind: "role", role: "analyst", specialty: "research" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    },
    versions: {
      plugin: "1",
      mode: "1",
      prompts: {},
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [],
  };
  const { runId } = runs.open("owner", input, "open");
  const bindings = new SessionBindings();
  function bind(id: string) {
    const claim = runs.claim(
      { runId: id, identity: "owner" },
      "research",
      "claim",
    );
    bindings.bind(h.outside.agent, { kind: "task", ...claim });
    const operation = taskOperation(bindings.require(h.outside.agent));
    runs.bindTaskSession({ ...operation, sessionId: h.outside.agent.id });
  }
  bind(runId);
  const exec = {
    agent: h.outside.agent,
    callId: ToolCallId("public-search"),
    signal: new AbortController().signal,
  } as ToolRunContext;
  const raw = {
    sources: [
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "Full snippet",
        publishedAt: "2026-10-26",
      },
    ],
    truncated: true,
  };
  const execute = vi.fn(async () => raw);
  h.ctx.tools.register({ ...markerTool("web_search"), execute });
  return { ...h, runs, bindings, exec, execute, input, runId, raw };
}
describe("public host search", () => {
  it("uses the calling parent's native search while the research child cannot access it directly", async () => {
    const h = await setup();
    const parent = await h.ctx.agents.create(h.agentOptions("search-parent"));
    const execute = vi.fn(async () => h.raw);
    parent.agent.ctx.tools.register({ ...markerTool("web_search"), execute });
    h.exec.agent!.ctx.tools.restrict({ allow: [] });
    expect(h.ctx.tools.get("web_search", h.exec.agent)).toBeUndefined();
    const result = await searchPublic(
      h.ctx,
      h.runs,
      h.bindings,
      "company news",
      h.exec,
      parent.agent,
    );
    expect(result.data.items).toHaveLength(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { queries: ["company news"] },
      h.exec,
    );
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("passes the original context to the native tool and saves the complete evidence", async () => {
    const h = await setup();
    const result = await searchPublic(
      h.ctx,
      h.runs,
      h.bindings,
      "company news",
      h.exec,
    );
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(
      { queries: ["company news"] },
      h.exec,
    );
    expect(result).toMatchObject({
      data: {
        truncated: true,
        items: [{ snippet: "Full snippet", providerTimestamp: "2026-10-26" }],
      },
      cutoff: h.input.definition.scope.cutoff,
      historicalKnowledge: "unverified",
      candidateClaims: [],
    });
    expect(result.source.url).toBe("dsh://web/search?query=company+news");
    expect(
      await searchPublic(h.ctx, h.runs, h.bindings, "company news", h.exec),
    ).toEqual(result);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const replay = h.runs.open(
      "owner",
      { replay: { runId: h.runId }, versions: h.input.versions },
      "replay",
    );
    const agent = (await h.ctx.agents.create(h.agentOptions("replay-worker")))
      .agent;
    const claim = h.runs.claim(
      { runId: replay.runId, identity: "owner" },
      "research",
      "claim",
    );
    h.bindings.bind(agent, { kind: "task", ...claim });
    h.runs.bindTaskSession({
      ...taskOperation(h.bindings.require(agent)),
      sessionId: agent.id,
    });
    const replayed = await searchPublic(
      h.ctx,
      h.runs,
      h.bindings,
      "company news",
      { ...h.exec, agent },
    );
    expect(replayed.data).toEqual(result.data);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("blocks historical live search and unavailable native tools", async () => {
    const historical = await setup("2024-01-03");
    await expect(
      searchPublic(
        historical.ctx,
        historical.runs,
        historical.bindings,
        "news",
        historical.exec,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(historical.execute).not.toHaveBeenCalled();
    const h = await setup();
    vi.spyOn(h.ctx.tools, "get").mockReturnValue(undefined);
    await expect(
      searchPublic(h.ctx, h.runs, h.bindings, "news", h.exec),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });
  it("preserves cancellation reasons", async () => {
    const h = await setup();
    const controller = new AbortController();
    const reason = new Error("cancel search");
    controller.abort(reason);
    await expect(
      searchPublic(h.ctx, h.runs, h.bindings, "news", {
        ...h.exec,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("native public search approval", () => {
  it.each(["allowed-once", "rejected", "unavailable", "cancelled"] as const)(
    "routes %s through the parent session without a child call id",
    async (outcome) => {
      const h = await setup();
      if (h.ctx.get("approval") === undefined)
        await h.ctx.plugin(ApprovalService, {});
      const parent = (
        await h.ctx.agents.create(h.agentOptions("approval-parent"))
      ).agent;
      parent.session.append("turn/start", { turn: 1 });
      const requests: unknown[] = [];
      h.ctx.on("approval/request", async (request) => {
        requests.push(request);
        return outcome;
      });
      const work = approvePublicSearch(h.ctx, "news query", h.exec, 5, parent);
      if (outcome === "allowed-once") await expect(work).resolves.toBe(true);
      else if (outcome === "rejected") await expect(work).resolves.toBe(false);
      else await expect(work).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(requests).toHaveLength(1);
      expect((requests[0] as { agent: unknown }).agent).toBe(parent);
      expect(requests[0]).toMatchObject({
        toolName: "stock_search_public",
        signal: h.exec.signal,
        reason: expect.stringContaining("5"),
        displayReason: {
          en: expect.stringContaining("news query"),
          "zh-CN": expect.stringContaining("news query"),
        },
      });
      expect(requests[0]).not.toHaveProperty("callId");
      expect(
        parent.session
          .snapshotEvents()
          .filter((event) => event.type === "approval/decided"),
      ).toHaveLength(1);
    },
  );
  it("fails closed when approval is absent", async () => {
    const h = await setup();
    const lookup = vi.spyOn(h.ctx, "get");
    lookup.mockReturnValue(undefined);
    try {
      await expect(
        approvePublicSearch(h.ctx, "news", h.exec, 5),
      ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    } finally {
      lookup.mockRestore();
    }
  });
  it("attaches a direct child's call id and withdraws a pending approval", async () => {
    const h = await setup();
    if (h.ctx.get("approval") === undefined)
      await h.ctx.plugin(ApprovalService, {});
    h.outside.agent.session.append("turn/start", { turn: 1 });
    const controller = new AbortController();
    const reason = new Error("withdraw approval");
    h.ctx.on("approval/request", async (request) => {
      expect(request.callId).toBe(h.exec.callId);
      expect(request.agent).toBe(h.outside.agent);
      controller.abort(reason);
      return "allowed-once";
    });
    await expect(
      approvePublicSearch(
        h.ctx,
        "news",
        { ...h.exec, signal: controller.signal },
        5,
      ),
    ).rejects.toBe(reason);
  });
  it("keeps the real abort reason", async () => {
    const h = await setup();
    const controller = new AbortController();
    const reason = new Error("cancel approval");
    controller.abort(reason);
    await expect(
      approvePublicSearch(
        h.ctx,
        "news",
        { ...h.exec, signal: controller.signal },
        5,
      ),
    ).rejects.toBe(reason);
  });
});

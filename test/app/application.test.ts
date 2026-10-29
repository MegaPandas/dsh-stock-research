import CommandRuntime from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Application from "../../src/plugin.js";
import { createQuickInput } from "../../src/app/quick-plan.js";
import {
  analysisReport,
  agentAnalysisReport,
  analysisSubmission,
} from "../fixtures/analysis-report.js";
import { runtimeHost, textResponse } from "../fixtures/runtime-host.js";
import { askAnswerResponse, askCollection } from "../fixtures/ask-host.js";
import {
  initialInput,
  researchCommands,
  toolCall,
} from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
} from "../fixtures/research-workflow.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("application bundle role dispatch", () => {
  it.each([
    { mode: "quick", route: "runtime" },
    { mode: "deep", route: "selected" },
    { mode: "quick", route: "override" },
  ])(
    "uses the $route model for ask, $mode roles and review",
    async ({ mode, route }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-01-03T08:00:00.000Z"));
      const workflow = workflowModel();
      const h = await runtimeHost({
        respond: async function* (request) {
          if (request.sessionId === "host-other") {
            if (isMainResearchRequest(request))
              yield* workflow.respond(request);
            else yield* textResponse("Host model selected.");
            return;
          }
          const { task } = initialInput<{ task: { role: string } }>(request);
          if (task.role === "ask") yield* askAnswerResponse("已核对固定数据。");
          else if (task.role === "review")
            yield* toolCall("stock_submit", {
              summary: "继续观察原研究条件。",
              content: { comparisons: [], lessons: [], followUp: [] },
            });
          else yield* workflow.respond(request);
        },
      });
      cleanups.push(h.close);
      if (route === "selected") {
        h.ctx.llm.registerAdapter(["selected-provider"], h.adapter);
        h.outside.agent.ctx.on("agent/request", async (_payload, next) => ({
          ...(await next()),
          provider: "selected-provider",
          model: "selected",
        }));
        h.outside.agent.followup(
          createUserMessage({
            content: [{ type: "text", text: "Select host model" }],
            source: { kind: "user" },
          }),
        );
        await h.outside.agent.whenIdle();
      }
      await h.ctx.plugin(CommandRuntime);
      const runtimeConfig = h.config({ enabledSources: [] });
      await h.ctx.plugin(Application, {
        runtime: runtimeConfig,
        ...(route === "override"
          ? { model: { provider: "runtime-fixture", model: "override" } }
          : {}),
      });
      vi.spyOn(h.ctx.stockResearch.collection, "collect").mockImplementation(
        async (scope) => askCollection(scope),
      );
      const { executeAndWait: execute } = researchCommands(
        h.ctx,
        h.outside.agent,
      );
      expect(
        (await execute("/stock-ask SZ.002594 2024-01-03 核实固定数据"))?.result
          .kind,
      ).toBe("success");
      expect(
        (await execute(`/stock-${mode} SZ.002594 2024-01-03`))?.result.kind,
      ).toBe("success");
      expect(
        h.ctx.stockResearch.runs.view({ runId: workflow.state.runId! }).status,
      ).toBe("completed");
      expect(
        (
          await execute(
            `/stock-review ${workflow.state.runId} 2024-01-03 复核原研究条件`,
          )
        )?.result.kind,
      ).toBe("success");
      const requests = h.adapter.requests.filter(
        (request) => request.sessionId !== "host-other",
      );
      const roles = new Set(
        requests.map(
          (request) =>
            initialInput<{ task: { role: string } }>(request).task.role,
        ),
      );
      expect([...roles]).toEqual(
        expect.arrayContaining(["ask", "market", "decision", "review"]),
      );
      expect(roles.has("digest")).toBe(false);
      for (const request of requests) {
        expect(request).toMatchObject({
          provider:
            route === "selected" ? "selected-provider" : "runtime-fixture",
          model: route,
        });
      }
      const mainRequests = h.adapter.requests.filter(
        (request) =>
          request.sessionId === h.outside.agent.id &&
          isMainResearchRequest(request),
      );
      expect(mainRequests.length).toBeGreaterThan(0);
      expect(
        mainRequests.every(
          ({ model }) =>
            model === (route === "selected" ? "selected" : "runtime"),
        ),
      ).toBe(true);
      expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    },
  );

  it("cleans data only when no research agent is active and reopens the services", async () => {
    const h = await runtimeHost();
    cleanups.push(h.close);
    await h.ctx.plugin(CommandRuntime);
    await h.ctx.plugin(Application, {
      runtime: h.config({ enabledSources: [] }),
    });
    const runtime = h.ctx.stockResearch;
    const { runId } = runtime.runs.open(
      "owner",
      createQuickInput(h.scope, runtime.policy, []),
      "open",
    );
    fs.mkdirSync(join(h.directory, "drafts"));
    fs.writeFileSync(join(h.directory, "drafts", "old"), "data");
    const agent = await runtime.createAgent(
      h.agentOptions("gc-test"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    const execute = () =>
      h.ctx.commands.execute(
        h.outside.agent,
        "/stock-gc all",
        [],
        new AbortController().signal,
      );
    await expect(execute()).rejects.toThrow(
      "Cannot clean while stock research tasks are running",
    );
    expect(fs.existsSync(join(h.directory, "drafts", "old"))).toBe(true);
    await agent.dispose();
    expect((await execute())?.result).toEqual({
      kind: "success",
      text: "已清理全部股票研究缓存和数据。",
    });
    expect(fs.existsSync(join(h.directory, "drafts"))).toBe(false);
    expect(() => h.ctx.stockResearch.runs.view({ runId })).toThrow();
    expect(
      h.ctx.stockResearch.runs.open(
        "owner",
        createQuickInput(h.scope, h.ctx.stockResearch.policy, []),
        "new",
      ).runId,
    ).toBeTruthy();
  });
  it("prepares and submits a role through the bundle-owned runtime context", async () => {
    let calls = 0;
    const h = await runtimeHost({
      respond: async function* () {
        if (++calls === 1) yield* analysisSubmission(analysisReport(), "save");
        else yield* textResponse("Submitted.");
      },
    });
    cleanups.push(h.close);
    await h.ctx.plugin(CommandRuntime);
    await h.ctx.plugin(Application, {
      runtime: h.config({ enabledSources: [] }),
      model: { provider: "runtime-fixture", model: "runtime" },
    });
    const runtime = h.ctx.stockResearch;
    const { runId } = runtime.runs.open(
      "owner",
      createQuickInput(h.scope, runtime.policy, []),
      "open",
    );
    const parent = await runtime.createAgent(
      h.agentOptions("bundle-coordinator"),
      { kind: "coordinator", runIds: [runId] },
      [],
    );
    try {
      const result = await runtime.dispatch.dispatch(
        parent.agent,
        runId,
        "analysis.market",
        "dispatch",
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: "succeeded", failure: null });
      expect(runtime.runs.readArtifact(result.refs[0]!).content).toMatchObject({
        kind: "analysis",
        payload: { schemaVersion: 3, report: agentAnalysisReport() },
      });
      expect(calls).toBe(1);
    } finally {
      await parent.dispose();
    }
  });
});

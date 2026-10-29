import {
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { bindScopeParent, createScope } from "@deepseek-ai/dsh-scope";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { createQuickInput } from "../../src/app/quick-plan.js";
import { attachResearchStages } from "../../src/app/research-stages.js";
import { prepareResearchRole } from "../../src/app/prepare-role.js";
import type { DispatchResult } from "../../src/host/dispatch.js";
import { createResearchPlugin } from "../../src/runtime.js";
import {
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
} from "../../src/tools/parameters.js";
import { continuationHost } from "../fixtures/continuation-host.js";
import {
  agentAnalysisReport,
  reportSubmission,
  reportHandoff,
} from "../fixtures/analysis-report.js";
import {
  lastToolResult,
  lastToolText,
  toolCall,
} from "../fixtures/quick-host.js";
import { textResponse } from "../fixtures/runtime-host.js";

describe("public role follow-up contract", () => {
  it("cold-restores one child and preserves drafts, search pause, budget and stage invalidation", async () => {
    const receipts: DispatchResult[] = [];
    const rounds = new Map<number, number>();
    const snapshots: unknown[] = [];
    const childSessions: string[] = [];
    const searchResults: unknown[] = [];
    let mainPhase = 0;
    let runId = "";
    let firstArtifact: unknown;
    const secondHandoff = {
      implications: ["second-round修订结论"],
      openQuestions: [],
      limitations: ["保留已有检索材料。"],
    };
    async function* respond(
      request: GenerateOptions,
    ): AsyncIterable<StreamChunk> {
      if (String(request.sessionId) === "followup-main") {
        if (mainPhase === 0) {
          mainPhase = 1;
          yield* toolCall("stock_dispatch_task", {
            runId,
            taskId: "analysis.public",
            requestId: "first-round",
          });
          return;
        }
        if (mainPhase <= 3) {
          const feedback = lastToolResult<DispatchResult>(request);
          expect(feedback).toMatchObject({
            status: "succeeded",
            attempt: mainPhase,
          });
          expect(
            h.ctx.agents.get(SessionId(feedback.sessionId!)),
          ).toBeUndefined();
          expect(
            h.ctx.sessions.get(SessionId(feedback.sessionId!)),
          ).toBeUndefined();
          receipts.push(feedback);
          snapshots.push(
            structuredClone(
              h.ctx.stockResearch.runs.readArtifact(feedback.refs[0]!).content,
            ),
          );
          if (mainPhase === 1) {
            firstArtifact = snapshots[0];
            h.ctx.stockResearch.runs.reviewStage(
              { runId, identity: "followup-main" },
              {
                stageId: "analysis",
                verdict: "accepted",
                feedback: "已检查首轮报告。",
                refs: feedback.refs,
              },
              "accept-first",
            );
            expect(
              h.ctx.stockResearch.runs.view({ runId }).stages![0]!.accepted,
            ).toBe(true);
          } else {
            expect(
              h.ctx.stockResearch.runs.view({ runId }).stages![0]!.accepted,
            ).toBe(false);
          }
          mainPhase += 1;
          if (mainPhase <= 3) {
            yield* toolCall("stock_followup_task", {
              runId,
              taskId: "analysis.public",
              requestId: mainPhase === 2 ? "second-round" : "third-round",
              message:
                mainPhase === 2
                  ? "second-round 请保留原稿，仅修订交接章节。"
                  : "third-round 恢复搜索并修订摘要。",
              resumeSearch: mainPhase === 3,
            });
            return;
          }
        }
        yield* textResponse("三轮研究修订已完成。");
        return;
      }
      const history = JSON.stringify(request.messages);
      const round = history.includes("third-round")
        ? 3
        : history.includes("second-round")
          ? 2
          : 1;
      const step = rounds.get(round) ?? 0;
      rounds.set(round, step + 1);
      childSessions.push(String(request.sessionId));
      if (round === 1) {
        if (step < 3) {
          if (step === 1) searchResults.push(lastToolResult(request));
          yield* toolCall(
            "stock_search_public",
            { query: `first-round query ${step}` },
            `first-search-${step}`,
          );
        } else {
          expect(lastToolText(request)).toContain("Search is paused");
          yield* reportSubmission(agentAnalysisReport(), "first-report");
        }
        return;
      }
      expect(history).toContain("first-round query 0");
      if (step === 0) {
        yield* toolCall("stock_read_report_draft", {}, `read-round-${round}`);
      } else if (step === 1) {
        const { draft, missingSections } = lastToolResult<{
          draft: unknown;
          missingSections: string[];
        }>(request);
        expect(missingSections).toEqual([]);
        expect(draft).toEqual(
          round === 2
            ? agentAnalysisReport()
            : {
                ...agentAnalysisReport(),
                content: {
                  ...agentAnalysisReport().content,
                  handoff: secondHandoff,
                },
              },
        );
        yield* toolCall(
          "stock_search_public",
          { query: `${round === 2 ? "second" : "third"}-round new search` },
          `search-round-${round}`,
        );
      } else if (step === 2) {
        if (round === 2)
          expect(lastToolText(request)).toContain("Search is paused");
        else searchResults.push(lastToolResult(request));
        yield* toolCall(
          "stock_write_report",
          round === 2
            ? {
                handoff: secondHandoff,
              }
            : {
                summary: "third-round新增搜索后的修订摘要。",
              },
          `write-round-${round}`,
        );
      } else if (step === 3)
        yield* toolCall(
          "stock_write_handoff",
          reportHandoff(agentAnalysisReport()),
          `handoff-round-${round}`,
        );
      else if (step === 4)
        yield* toolCall("stock_submit", {}, `submit-round-${round}`);
      else throw new Error(`Unexpected child round ${round} step ${step}`);
    }
    const h = await continuationHost({
      respond,
      search: async () => {
        throw new Error("Native fixture owns search");
      },
    });
    try {
      await h.ctx.plugin(ApprovalService, {});
      const nativeSearch = vi.fn<ToolDefinition["execute"]>(async () => ({
        sources: [
          {
            title: "公开经营材料",
            url: "https://example.com/report",
            snippet: "产品组合改善。",
            publishedAt: "2026-10-28",
          },
        ],
        truncated: false,
      }));
      const native: ToolDefinition = {
        name: "web_search",
        description: "Native search fixture",
        parameters: objectSchema({
          queries: { type: "array", items: stringSchema },
        }),
        output: resultOutput(opaqueObjectSchema),
        execute: nativeSearch,
      };
      const presetKey = {};
      await h.ctx.plugin({
        name: "followup-search-preset",
        inject: ["tools"],
        apply(ctx: Context) {
          const scope = createScope(ctx, presetKey);
          ctx.effect(() => scope.rawDispose);
          scope.ctx.tools.register(native);
        },
      });
      await h.ctx.plugin(
        createResearchPlugin((context, parent) =>
          prepareResearchRole(h.ctx.stockResearch, context, parent),
        ),
        h.config({ enabledSources: ["dsh-web"] }),
      );
      const scope = {
        ...h.scope,
        date: new Intl.DateTimeFormat("en-CA", {
          timeZone: h.scope.security.timeZone,
        }).format(new Date()),
        cutoff: new Date(Date.now() - 60_000).toISOString(),
      };
      const input = createQuickInput(
        scope,
        h.ctx.stockResearch.policy,
        [],
        [],
        1,
      );
      input.definition.tasks = input.definition.tasks.filter(
        ({ id }) => id === "analysis.public",
      );
      input.instructions = input.instructions!.filter(
        ({ taskId }) => taskId === "analysis.public",
      );
      input.instructions[0]!.instruction += " first-round";
      runId = h.ctx.stockResearch.runs.open(
        "owner",
        attachResearchStages(input, [
          { id: "analysis", taskIds: ["analysis.public"], beforeTasks: [] },
        ]),
        "followup-run",
      ).runId;
      const parent = await h.ctx.agents.create({
        ...h.agentOptions("followup-main"),
        setup(_ctx, agent) {
          bindScopeParent(agent, presetKey);
        },
      });
      const release = h.ctx.stockResearch.bindCoordinator(parent.agent);
      parent.agent.ctx.effect(() => release);
      for (const tool of h.ctx.stockResearch.tools.filter(({ name }) =>
        ["stock_dispatch_task", "stock_followup_task"].includes(name),
      ))
        parent.agent.ctx.tools.register(tool);
      h.ctx.stockResearch.authorizeCoordinatorRun(parent.agent, runId);
      const approvalCounts: number[] = [];
      h.ctx.on("approval/request", async () => {
        approvalCounts.push(nativeSearch.mock.calls.length);
        return approvalCounts.length <= 2 ? "rejected" : "allowed-once";
      });
      parent.agent.followup(
        createUserMessage({
          content: [
            { type: "text", text: "first-round 开始并完成三轮公开研究。" },
          ],
          source: { kind: "user" },
        }),
      );
      await parent.agent.whenIdle();
      expect(receipts.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
      expect(new Set(receipts.map(({ sessionId }) => sessionId)).size).toBe(1);
      expect(new Set(childSessions).size).toBe(1);
      expect(receipts.map(({ refs }) => refs[0]!.revision)).toEqual([1, 2, 3]);
      expect(nativeSearch).toHaveBeenCalledTimes(2);
      expect(approvalCounts).toEqual([1, 1, 1]);
      expect(searchResults).toMatchObject([
        { budget: { limit: 1, used: 1, remaining: 0 } },
        { budget: { limit: 1, used: 2, remaining: 0 } },
      ]);
      const payloads = snapshots.map(
        (snapshot) =>
          (
            snapshot as {
              payload: { publicSearchAsOf: string; report: unknown };
            }
          ).payload,
      );
      expect(payloads[0]!.publicSearchAsOf).toBeTypeOf("string");
      expect(payloads[1]!.publicSearchAsOf).toBe(payloads[0]!.publicSearchAsOf);
      expect(payloads[1]!.report).toMatchObject({
        content: { handoff: secondHandoff },
      });
      expect(payloads[2]!.report).toMatchObject({
        summary: "third-round新增搜索后的修订摘要。",
        content: { handoff: secondHandoff },
      });
      expect(
        h.ctx.stockResearch.runs.readArtifact(receipts[0]!.refs[0]!).content,
      ).toEqual(firstArtifact);
      await parent.dispose();
    } finally {
      await h.close();
    }
  });
});

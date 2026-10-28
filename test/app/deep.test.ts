import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReportPayload,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import { readCollection } from "../../src/app/collection-input.js";
import { quickHost, lastToolResult, toolCall } from "../fixtures/quick-host.js";
import {
  workflowModel,
  isMainResearchRequest,
} from "../fixtures/research-workflow.js";
import { textResponse } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>(
  async () =>
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

beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:00:00.000Z"));
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("stock-deep command and resume", () => {
  it("opens deep and resumes all twenty-two nodes with plan, risk responses and retained source gaps", async () => {
    let openedRunId: string | undefined;
    let opening = true;
    const model = workflowModel();
    const h = await quickHost(async function* (
      request: GenerateOptions,
    ): AsyncIterable<StreamChunk> {
      if (!opening) {
        yield* model.respond(request);
        return;
      }
      if (!isMainResearchRequest(request))
        throw new Error(
          "Only the existing main Agent should run before explicit continuation.",
        );
      if (!request.messages.some((message) => message.role === "tool")) {
        yield* toolCall("stock_start_research", {
          security: "SZ.002594",
          date: "2024-01-03",
          mode: "deep",
          requestId: "open-deep",
        });
        return;
      }
      openedRunId = lastToolResult<{ runId: string }>(request).runId;
      yield* textResponse("数据已准备，后续任务待继续执行。");
    });
    cleanups.push(h.close);
    const first = await h.executeAndWait("/stock-deep SZ.002594 2024-01-03");
    expect(first?.result.kind).toBe("error");
    const before = h.runtime.runs.view({ runId: openedRunId! });
    expect(before.mode).toBe("deep");
    expect(before.status).toBe("active");
    expect(before.tasks.every((task) => task.status === "pending")).toBe(true);
    expect(before.blockReasons).toEqual([]);
    const collection = readCollection(h.runtime.runs, before.runId)!;
    expect(collection.packets).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    opening = false;
    const result = await h.executeAndWait(
      `/stock-resume ${before.runId} ${JSON.stringify({
        resolvedReasonIds: before.blockReasons.map((reason) => reason.id),
        instructions: [],
      })}`,
    );
    expect(result?.result.kind).toBe("success");
    const view = h.runtime.runs.view({ runId: before.runId });
    expect(view.scope).toEqual(before.scope);
    expect(view.mode).toBe("deep");
    expect(view.status).toBe("completed");
    expect(view.tasks).toHaveLength(22);
    expect(
      view.tasks.every(
        (task) => task.status === "succeeded" && task.attempt === 1,
      ),
    ).toBe(true);
    expect(model.state.taskIds).toHaveLength(22);
    expect(readCollection(h.runtime.runs, view.runId)).toEqual(collection);
    expect(fetch).toHaveBeenCalledTimes(3);
    const contentFor = (id: string) =>
      view.tasks
        .find((task) => task.taskId === id)!
        .outputRefs.map(
          (ref) =>
            h.runtime.runs.readArtifact(ref).content as ResearchArtifactInput,
        );
    const plan = contentFor("manager.research")[0]!;
    for (const side of ["bull", "bear"] as const) {
      expect(contentFor(`debate.1.${side}`)[0]).toMatchObject({
        kind: "debate",
        payload: {
          schemaVersion: 3,
          side,
          report: {
            summary: "本方围绕产品组合及价格竞争展开判断。",
            content: {
              arguments: [
                {
                  claim: "产品组合决定利润率的变化。",
                  mechanism: "高价产品占比提高能够改善单车利润。",
                  conditions: ["高价产品交付增长。"],
                },
              ],
              responses: [],
            },
          },
        },
      });
    }
    expect(plan).toMatchObject({
      kind: "plan",
      payload: {
        report: {
          summary: "围绕固定分析与两轮讨论确定研究问题。",
          content: {
            questions: [
              {
                question: "来源历史版本能否核实？",
                whyItMatters: "决定当时可知信息的比较范围。",
                nextStep: "核对原披露时间和对应版本。",
              },
            ],
            constraints: ["采用同一统计期间和价格口径。"],
          },
        },
      },
    });
    const final = contentFor("finalize");
    expect(final.map((content) => content.kind).sort()).toEqual([
      "decision",
      "report",
    ]);
    const report = final.find((content) => content.kind === "report")!
      .payload as ReportPayload;
    const risks = ["risk.finance", "risk.valuation", "risk.events"].flatMap(
      (id) => {
        const content = contentFor(id)[0]!;
        if (content.kind !== "risk") throw new Error("Expected risk artifact");
        return content.payload.issues;
      },
    );
    expect(risks.map((risk) => risk.issueId).sort()).toEqual([
      "risk.events.1",
      "risk.finance.1",
      "risk.valuation.1",
    ]);
    expect(
      [...report.decision.riskResponses].sort((a, b) =>
        a.issueId.localeCompare(b.issueId),
      ),
    ).toEqual(
      risks
        .map((risk) => ({
          issueId: risk.issueId,
          disposition: "unresolved",
          reason: "人工场景明确保留尚未解决的风险。",
        }))
        .sort((a, b) => a.issueId.localeCompare(b.issueId)),
    );
    expect(report.sections).toContainEqual(
      view.tasks.find((task) => task.taskId === "manager.research")!
        .outputRefs[0],
    );
    expect(report.gaps).toContainEqual(
      expect.objectContaining({
        kind: "source",
        gap: expect.objectContaining({
          code: "unverified_time",
          field: "/data/rows",
        }),
      }),
    );
    expect(h.ctx.agents.list()).toEqual([h.outside.agent]);
    for (const agent of h.created)
      expect(h.ctx.sessions.get(agent.id)).toBeUndefined();
  });
});

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  assertSupportedJsonSchema,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { type AgentReport } from "../../src/contracts/agent-reports.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { createReportDraft } from "../../src/host/report-draft.js";
import {
  STAGE_HANDOFF_MAX_CHARACTERS,
  type StageHandoff,
} from "../../src/contracts/stage-handoff.js";

const report: AgentReport<"analysis"> = {
  summary: "回款改善。",
  content: {
    currentState: ["回款上升。"],
    analysisModel: {
      drivers: ["回款"],
      mechanism: "回款增加现金。",
      assumptions: [],
      alternativeExplanations: [],
    },
    outlook: {
      horizon: "下一年",
      baseCase: { conditions: [], expectation: "现金增加。" },
      alternativeCases: [],
      watchPoints: [],
    },
    risks: [],
    handoff: { implications: [], openQuestions: [], limitations: [] },
  },
};

function execution(controller = new AbortController()) {
  return {
    signal: controller.signal,
    callId: ToolCallId("draft-1"),
    concludeTurn: vi.fn(),
    agent: { cancel: vi.fn() },
  } as unknown as ToolRunContext;
}

describe("section report drafts", () => {
  const handoff: StageHandoff = {
    keyPoints: ["回款改善。"],
    disagreements: [],
    risks: [],
    openQuestions: [],
  };

  it("requires a bounded handoff after the final report edit and saves it with the report", async () => {
    const accept = vi.fn(() => "saved");
    const session = createReportDraft("analysis", accept, report, false, {});
    const [write, read, submit, writeHandoff] = session.tools;
    const exec = execution();
    for (const tool of session.tools)
      assertSupportedJsonSchema(tool.parameters);
    await expect(submit!.execute({}, exec)).rejects.toThrow(
      /stock_write_handoff/,
    );
    await writeHandoff!.execute(handoff, exec);
    expect(await read!.execute({}, exec)).toMatchObject({
      stageHandoff: handoff,
      handoffConfirmed: true,
    });
    await write!.execute({ summary: "修订判断。" }, exec);
    await expect(submit!.execute({}, exec)).rejects.toThrow(/reconfirm/);
    await writeHandoff!.execute(handoff, exec);
    await submit!.execute({}, exec);
    expect(accept).toHaveBeenCalledExactlyOnceWith(
      { ...report, summary: "修订判断。" },
      exec,
      handoff,
    );
  });

  it("reports the actual handoff budget without truncating and preserves prior content", async () => {
    const session = createReportDraft(
      "analysis",
      () => "saved",
      report,
      false,
      {},
    );
    const write = session.tools[3]!;
    const exec = execution();
    expect(write.description).toContain("目标450个Unicode字符，上限900字符");
    await write.execute({ ...handoff, keyPoints: ["中".repeat(650)] }, exec);
    const exact = structuredClone(handoff);
    exact.keyPoints[0] += "🚀".repeat(
      STAGE_HANDOFF_MAX_CHARACTERS - [...JSON.stringify(exact)].length,
    );
    await write.execute(exact, exec);
    const oversized = structuredClone(exact);
    oversized.keyPoints[0] += "中";
    await expect(write.execute(oversized, exec)).rejects.toThrow(
      /901\/900.*target 450.*over by 1.*keyPoints=.*disagreements=.*risks=.*openQuestions=/,
    );
    expect(await session.tools[1]!.execute({}, exec)).toMatchObject({
      stageHandoff: exact,
    });
    await expect(
      write.execute({ ...handoff, extra: [] }, exec),
    ).rejects.toThrow(/extra/);
    await expect(
      write.execute(
        { keyPoints: [], disagreements: [], risks: [], openQuestions: [] },
        exec,
      ),
    ).rejects.toThrow(/at least one/);
  });

  it("retains seeded handoffs but requires confirmation in a follow-up", async () => {
    const session = createReportDraft(
      "analysis",
      () => "saved",
      report,
      false,
      { seed: handoff },
    );
    const exec = execution();
    expect(await session.tools[1]!.execute({}, exec)).toMatchObject({
      stageHandoff: handoff,
      handoffConfirmed: false,
    });
    await expect(session.tools[2]!.execute({}, exec)).rejects.toThrow(
      /reconfirm/,
    );
    await session.tools[3]!.execute(handoff, exec);
    await session.tools[2]!.execute({}, exec);
    expect(session.result()).toBe("saved");
  });

  it("matches risk summaries to the final report issues by order", async () => {
    const riskReport: AgentReport<"risk"> = {
      summary: "存在回款风险。",
      content: {
        issues: [
          {
            description: "回款下降",
            impact: "现金减少",
            trigger: "账期拉长",
            constraint: "限制暴露",
            recommendation: "跟踪账期",
          },
        ],
      },
    };
    const session = createReportDraft(
      "risk",
      () => "saved",
      riskReport,
      false,
      {},
    );
    const exec = execution();
    await session.tools[3]!.execute(handoff, exec);
    await expect(session.tools[2]!.execute({}, exec)).rejects.toThrow(
      /exactly one summary/,
    );
    await session.tools[3]!.execute(
      { ...handoff, risks: ["账期拉长会减少现金，应限制暴露。"] },
      exec,
    );
    await session.tools[2]!.execute({}, exec);
  });

  it("writes analysis in sections, shows gaps and commits only a complete report", async () => {
    const accept = vi.fn(() => ({ receipt: "saved" }));
    const session = createReportDraft("analysis", accept);
    const [write, read, submit] = session.tools;
    const exec = execution();
    for (const tool of session.tools)
      assertSupportedJsonSchema(tool.parameters);
    await write!.execute({ summary: report.summary }, exec);
    await write!.execute({ currentState: report.content.currentState }, exec);
    expect(await read!.execute({}, exec)).toEqual({
      draft: {
        summary: report.summary,
        content: { currentState: ["回款上升。"] },
      },
      missingSections: ["analysisModel", "outlook", "risks", "handoff"],
    });
    await expect(submit!.execute({}, exec)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(accept).not.toHaveBeenCalled();
    for (const [section, value] of Object.entries(report.content))
      await write!.execute({ [section]: value }, exec);
    await expect(submit!.execute({}, exec)).resolves.toEqual({
      status: "submitted",
    });
    expect(accept).toHaveBeenCalledWith(report, exec);
    expect(session.result()).toEqual({ receipt: "saved" });
    expect(exec.concludeTurn).toHaveBeenCalledOnce();
  });

  it("revises seeded sections, clones drafts and preserves prior content on invalid writes", async () => {
    const session = createReportDraft("analysis", () => "saved", report);
    const [write, read, submit] = session.tools;
    const exec = execution();
    await write!.execute({ currentState: ["新观察。"] }, exec);
    const expected = structuredClone(report);
    expected.content.currentState = ["新观察。"];
    for (const input of [
      { currentState: "bad" },
      { unknown: [] },
      { summary: "标题", extra: true },
      { handoff: { ...report.content.handoff, extra: [] } },
    ])
      await expect(write!.execute(input, exec)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    await expect(
      write!.execute({ summary: "标题", risks: [] }, exec),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "INVALID_INPUT: Provide exactly one report section per call; received 2: summary, risks. Write separate sections in separate stock_write_report calls.",
    });
    const copy = session.draft();
    copy.content.currentState!.push("外部修改");
    expect(session.draft()).toEqual(expected);
    expect(report.content.currentState).toEqual(["回款上升。"]);
    await expect(submit!.execute(report, exec)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(read!.execute({ extra: true }, exec)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("explains valid sections and the selected section's format when a write fails", async () => {
    const [write] = createReportDraft("analysis", () => "saved").tools;
    const exec = execution();
    expect(write!.parameters).toMatchObject({
      properties: {
        currentState: { type: "array", items: { type: "string" } },
      },
    });
    await expect(
      write!.execute({ facts: { item: "测试" } }, exec),
    ).rejects.toThrow(/facts/);
    await expect(
      write!.execute({ currentState: { item: ["测试"] } }, exec),
    ).rejects.toThrow(/currentState.*array/s);
    await write!.execute({ currentState: ["2026年10月27日测试条目"] }, exec);
  });

  it("enforces business rules at submission and accepts corrected sections", async () => {
    const accept = vi.fn(() => "saved");
    const session = createReportDraft("analysis", accept, report);
    const [write, , submit] = session.tools;
    const exec = execution();
    await write!.execute({ currentState: [] }, exec);
    await expect(submit!.execute({}, exec)).rejects.toThrow(/at least one/);
    expect(accept).not.toHaveBeenCalled();
    await write!.execute({ currentState: ["恢复观察。"] }, exec);
    await submit!.execute({}, exec);
    expect(session.result()).toBe("saved");
  });

  it("keeps the saved version 20 section/value contract", async () => {
    const session = createReportDraft("analysis", () => "saved", report, true);
    await session.tools[0]!.execute(
      { section: "currentState", value: ["旧版继续写入。"] },
      execution(),
    );
    expect(session.draft().content.currentState).toEqual(["旧版继续写入。"]);
  });

  it("does not mutate or save when cancelled", async () => {
    const accept = vi.fn();
    const session = createReportDraft("analysis", accept, report);
    const controller = new AbortController();
    controller.abort();
    const exec = execution(controller);
    await expect(
      session.tools[0]!.execute({ summary: "修改" }, exec),
    ).rejects.toThrow();
    await expect(session.tools[2]!.execute({}, exec)).rejects.toThrow();
    expect(session.draft()).toEqual(report);
    expect(accept).not.toHaveBeenCalled();
  });

  it("preserves saving failure and cancellation semantics", async () => {
    const cause = new ResearchError("STORAGE_FAILED", "disk unavailable");
    const session = createReportDraft(
      "analysis",
      () => {
        throw cause;
      },
      report,
    );
    const exec = execution();
    await expect(session.tools[2]!.execute({}, exec)).rejects.toMatchObject({
      code: "STORAGE_FAILED",
    });
    expect(() => session.result()).toThrow(cause);
    expect(exec.agent!.cancel).toHaveBeenCalledOnce();
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });
});

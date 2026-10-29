import { ToolCallId, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { AnalysisReport } from "../../src/contracts/artifact-payloads.js";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import { valuationSelection } from "./valuation.js";

export function analysisReport(): AnalysisReport {
  return {
    assessment: "人工场景仅判断本方向的已知状态。",
    current_state: ["人工同时点样本收盘价为192元；来源历史版本仍有限制。"],
    analysis_model: {
      drivers: ["价格结构与后续经营变化"],
      mechanism: "本人工场景用于检验阶段产物的固定输入交接。",
      assumptions: ["未来变化仍需后续数据确认。"],
      alternative_explanations: ["当前变化也可能是短期波动。"],
    },
    outlook: {
      horizon: "下一个报告期",
      base_case: {
        conditions: ["现有条件持续。"],
        expectation: "保持当前阶段判断。",
      },
      alternative_case: {
        conditions: ["后续资料与当前前提不同。"],
        expectation: "重新评估本方向判断。",
      },
      watch_points: ["后续完整交易日及披露数据。"],
    },
    risks: [
      {
        factor: "来源历史版本限制",
        impact: "观察不自动证明当时公开可得。",
        invalidation: "后续资料否定当前前提。",
      },
    ],
    handoff: {
      implications: ["将本方向判断交给后续综合讨论。"],
      open_questions: ["来源历史版本能否核实？"],
      limitations: ["人工样本，不代表真实市场判断。"],
    },
  };
}

export function agentAnalysisReport(
  report: AnalysisReport = analysisReport(),
): AgentReport<"analysis"> {
  return {
    summary: report.assessment,
    content: {
      currentState: report.current_state,
      analysisModel: {
        drivers: report.analysis_model.drivers,
        mechanism: report.analysis_model.mechanism,
        assumptions: report.analysis_model.assumptions,
        alternativeExplanations: report.analysis_model.alternative_explanations,
      },
      outlook: {
        horizon: report.outlook.horizon,
        baseCase: report.outlook.base_case,
        alternativeCases: [report.outlook.alternative_case],
        watchPoints: report.outlook.watch_points,
      },
      risks: report.risks.map(({ invalidation, ...risk }) => ({
        ...risk,
        trigger: invalidation,
      })),
      handoff: {
        implications: report.handoff.implications,
        openQuestions: report.handoff.open_questions,
        limitations: report.handoff.limitations,
      },
    },
  };
}

/** The provider submits business fields; the application owns storage metadata. */
export async function* analysisSubmission(
  report: AnalysisReport = analysisReport(),
  requestId = "save-analysis",
): AsyncIterable<StreamChunk> {
  yield* reportSubmission(agentAnalysisReport(report), requestId);
}

export async function* reportSubmission(
  report: AgentReport,
  requestId = "submit-report",
  includeHandoff = true,
): AsyncIterable<StreamChunk> {
  yield* submitCalls(
    [
      {
        name: "stock_write_report",
        arguments: { summary: report.summary },
      },
      ...Object.entries(report.content).map(([section, value]) => ({
        name: "stock_write_report",
        arguments: {
          [section]:
            section === "valuation" && value !== null
              ? valuationSelection(
                  value as NonNullable<
                    AgentReport<"analysis">["content"]["valuation"]
                  >,
                )
              : section === "targetPrice" &&
                  value !== null &&
                  typeof value === "object" &&
                  "calculationId" in value
                ? { calculationId: value.calculationId }
                : value,
        },
      })),
      ...(includeHandoff
        ? [{ name: "stock_write_handoff", arguments: reportHandoff(report) }]
        : []),
      { name: "stock_submit", arguments: {} },
    ],
    requestId,
  );
}

export function reportHandoff(report: AgentReport) {
  return {
    keyPoints: ["阶段判断与依据已核对，详见报告。"],
    disagreements: [],
    risks:
      "issues" in report.content
        ? report.content.issues.map(
            (_issue, index) => `风险${index + 1}按正文条件控制暴露。`,
          )
        : [],
    openQuestions: [],
  };
}

export async function* legacyAnalysisSubmission(
  report: AnalysisReport = analysisReport(),
  requestId = "save-analysis",
): AsyncIterable<StreamChunk> {
  yield* submitCalls(
    [
      {
        name: "stock_write_draft",
        arguments: { content: JSON.stringify(report) },
      },
      { name: "stock_save_report", arguments: { requestId } },
    ],
    requestId,
  );
}

async function* submitCalls(
  calls: { name: string; arguments: object }[],
  requestId: string,
): AsyncIterable<StreamChunk> {
  for (const [index, call] of calls.entries()) {
    const id = ToolCallId(`${requestId}-${index}`);
    const args = JSON.stringify(call.arguments);
    yield { type: "block-start", index, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index,
      id,
      name: call.name,
      argumentsDelta: args,
    };
    yield {
      type: "block-end",
      index,
      block: { type: "tool-call", id, name: call.name, arguments: args },
    };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

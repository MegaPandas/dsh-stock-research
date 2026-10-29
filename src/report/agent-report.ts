import type {
  AgentReport,
  AgentReportContent,
  AgentReportKind,
} from "../contracts/agent-reports.js";
import { inline } from "./render.js";
import { renderValuation } from "./valuation.js";

function list(title: string, items: readonly string[]): string[] {
  return items.length === 0
    ? []
    : ["", `## ${title}`, "", ...items.map((item) => `- ${item}`)];
}

function outlook(content: AgentReportContent<"analysis">["outlook"]): string[] {
  const lines = ["", "## 前景与条件", "", `预测期限：${content.horizon}`];
  const scenarios = [
    { title: "基准路径", ...content.baseCase },
    ...content.alternativeCases.map((scenario, index) => ({
      title: `替代路径 ${index + 1}`,
      ...scenario,
    })),
  ];
  for (const scenario of scenarios) {
    lines.push("", `### ${scenario.title}`, "", scenario.expectation);
    if (scenario.conditions.length > 0)
      lines.push(
        "",
        "成立条件：",
        ...scenario.conditions.map((item) => `- ${item}`),
      );
  }
  return [...lines, ...list("关键观察", content.watchPoints)];
}

function risks(items: AgentReportContent<"analysis">["risks"]): string[] {
  if (items.length === 0) return [];
  return [
    "",
    "## 关键风险",
    ...items.flatMap((risk) => [
      "",
      `### ${inline(risk.factor)}`,
      "",
      `影响：${risk.impact}`,
      "",
      `触发条件：${risk.trigger}`,
    ]),
  ];
}

interface RenderOptions {
  includeSummary?: boolean;
  riskIssueIds?: readonly string[];
}

const renderers: {
  [Kind in AgentReportKind]: (
    report: AgentReport<Kind>,
    options: RenderOptions,
  ) => string[];
} = {
  analysis({ content }) {
    return [
      ...list("现状与变化", content.currentState),
      "",
      "## 分析模型",
      "",
      content.analysisModel.mechanism,
      ...list("关键驱动", content.analysisModel.drivers),
      ...list("主要假设", content.analysisModel.assumptions),
      ...list("其他可能解释", content.analysisModel.alternativeExplanations),
      ...renderValuation(content.valuation),
      ...outlook(content.outlook),
      ...risks(content.risks),
      ...list("对后续研究的含义", content.handoff.implications),
      ...list("未决问题", content.handoff.openQuestions),
      ...list("影响判断的材料缺口", content.handoff.limitations),
    ];
  },
  debate({ content }) {
    return [
      "",
      "## 本方论点",
      ...content.arguments.flatMap((argument) => [
        "",
        `### ${inline(argument.claim)}`,
        "",
        argument.mechanism,
        ...(argument.conditions.length === 0
          ? []
          : [
              "",
              "成立条件：",
              ...argument.conditions.map((item) => `- ${item}`),
            ]),
      ]),
      ...(content.responses.length === 0
        ? []
        : [
            "",
            "## 对方观点与回应",
            ...content.responses.flatMap((response) => [
              "",
              `### ${inline(response.point)}`,
              "",
              response.response,
            ]),
          ]),
      ...outlook(content.outlook),
      ...risks(content.risks),
      ...list("未决问题", content.openQuestions),
    ];
  },
  risk({ content }, options) {
    return content.issues.flatMap((issue, index) => [
      "",
      `## ${options.riskIssueIds === undefined ? "" : `${inline(options.riskIssueIds[index]!)}：`}${inline(issue.description)}`,
      "",
      `影响：${issue.impact}`,
      "",
      `触发条件：${issue.trigger}`,
      "",
      `建议约束：${issue.constraint}`,
      "",
      `处置建议：${issue.recommendation}`,
    ]);
  },
  plan({ content }) {
    return [
      ...(content.questions.length === 0
        ? []
        : [
            "",
            "## 研究问题",
            ...content.questions.flatMap((question) => [
              "",
              `### ${inline(question.question)}`,
              "",
              `判断影响：${question.whyItMatters}`,
              "",
              `研究路径与检查点：${question.nextStep}`,
            ]),
          ]),
      ...list("研究约束", content.constraints),
    ];
  },
  decision_draft({ content }) {
    return [
      ...list("投资逻辑", content.thesis),
      ...renderValuation(content.valuation),
      ...list("关键风险", content.risks),
      ...list("改变判断的条件", content.invalidationConditions),
      ...list("影响决策的材料缺口", content.limitations),
    ];
  },
  digest({ content }) {
    return [
      ...list("关键要点", content.keyPoints),
      ...list("未决分歧", content.disagreements),
      ...list(
        "风险摘要",
        content.riskSummaries.map(
          (risk) => `${inline(risk.issueId)}：${risk.text}`,
        ),
      ),
      ...list("后续问题", content.openQuestions),
    ];
  },
  ask({ content }) {
    return [
      ...content.explanation.flatMap((item) => ["", item]),
      ...list("影响答案的材料缺口", content.limitations),
    ];
  },
  review({ content }) {
    return [
      ...(content.comparisons.length === 0
        ? []
        : [
            "",
            "## 判断与后续观察",
            ...content.comparisons.flatMap((comparison) => [
              "",
              `原判断：${comparison.original}`,
              "",
              `后续观察：${comparison.observed}`,
              "",
              `检验结果：${comparison.implication}`,
            ]),
          ]),
      ...list("复盘经验", content.lessons),
      ...list("后续行动", content.followUp),
    ];
  },
  coordinator() {
    return [];
  },
};

export function renderAgentReport<Kind extends AgentReportKind>(
  kind: Kind,
  report: AgentReport<Kind>,
  options: RenderOptions = {},
): string {
  const lines = [
    ...(options.includeSummary === false ? [] : [report.summary]),
    ...renderers[kind](report, options),
  ];
  const body = lines.join("\n").trim();
  return body === "" ? "" : `${body}\n`;
}

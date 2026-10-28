import { expect, it } from "vitest";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import { renderAgentReport } from "../../src/report/agent-report.js";

const outlook: AgentReport<"analysis">["content"]["outlook"] = {
  horizon: "未来两个季度",
  baseCase: { conditions: ["销量保持增长。"], expectation: "单车利润提高。" },
  alternativeCases: [],
  watchPoints: [],
};

it("renders the full analysis model and conditional paths with original numbers", () => {
  const report = renderAgentReport("analysis", {
    summary: "产品组合改善，现金流同比下降16.69%。",
    content: {
      currentState: ["经营现金流为208.00亿元。"],
      analysisModel: {
        drivers: ["高价产品占比。"],
        mechanism: "产品组合影响单车利润。",
        assumptions: ["终端折扣保持稳定。"],
        alternativeExplanations: ["规模变化也会影响成本。"],
      },
      outlook: {
        ...outlook,
        alternativeCases: [
          { conditions: ["竞争对手降价。"], expectation: "折扣扩大。" },
          {
            conditions: ["新产品交付超预期。"],
            expectation: "组合进一步改善。",
          },
        ],
        watchPoints: ["终端价格。"],
      },
      risks: [
        {
          factor: "价格竞争",
          impact: "单车利润下降。",
          trigger: "终端折扣扩大。",
        },
      ],
      handoff: {
        implications: ["估值需要纳入产品组合变化。"],
        openQuestions: ["销量增长能否持续？"],
        limitations: ["区域交付结构缺失，无法分解海外组合贡献。"],
      },
    },
  });
  expect(report.startsWith("产品组合改善，现金流同比下降16.69%。\n")).toBe(
    true,
  );
  for (const text of [
    "208.00亿元",
    "## 现状与变化",
    "## 分析模型",
    "## 关键驱动",
    "## 主要假设",
    "## 其他可能解释",
    "### 基准路径",
    "### 替代路径 1",
    "### 替代路径 2",
    "## 关键观察",
    "触发条件：终端折扣扩大。",
    "## 对后续研究的含义",
    "## 未决问题",
    "## 影响判断的材料缺口",
  ])
    expect(report).toContain(text);
});

it("renders focused debate arguments and existing opposing responses", () => {
  const report = renderAgentReport("debate", {
    summary: "多方逻辑由产品组合驱动。",
    content: {
      arguments: [
        {
          claim: "利润率提升",
          mechanism: "产品结构变化改善盈利。",
          conditions: ["高价产品交付增长。"],
        },
      ],
      responses: [
        { point: "降价压缩盈利", response: "需要比较终端折扣与组合提升幅度。" },
      ],
      outlook,
      risks: [],
      openQuestions: ["组合贡献是否超过折扣影响？"],
    },
  });
  expect(report).toContain("## 本方论点\n\n### 利润率提升");
  expect(report).toContain("成立条件：\n- 高价产品交付增长。");
  expect(report).toContain(
    "### 降价压缩盈利\n\n需要比较终端折扣与组合提升幅度。",
  );
  expect(report).not.toContain("## 现状与变化");
  expect(report).not.toContain("## 关键风险");
});

it("renders each risk action as a recommendation", () => {
  const report = renderAgentReport(
    "risk",
    {
      summary: "价格竞争影响盈利兑现。",
      content: {
        issues: [
          {
            description: "折扣扩大",
            impact: "毛利率下降。",
            trigger: "主销车型降价。",
            constraint: "估值按较低利润计算。",
            recommendation: "跟踪终端价格。",
          },
        ],
      },
    },
    { riskIssueIds: ["risk.finance.1"] },
  );
  expect(report).toContain("## risk.finance.1：折扣扩大");
  expect(report).toContain("影响：毛利率下降。");
  expect(report).toContain("触发条件：主销车型降价。");
  expect(report).toContain("建议约束：估值按较低利润计算。");
  expect(report).toContain("处置建议：跟踪终端价格。");
  expect(report).not.toContain("已缓解");
});

it("renders a research question together with its decision impact and next step", () => {
  const report = renderAgentReport("plan", {
    summary: "先确定新产品的盈利贡献。",
    content: {
      questions: [
        {
          question: "产品组合贡献多少？",
          whyItMatters: "决定利润率提升能否持续。",
          nextStep: "比较分车型交付与终端价格。",
        },
      ],
      constraints: ["比较相同季度。"],
    },
  });
  expect(report).toContain("### 产品组合贡献多少？");
  expect(report).toContain("判断影响：决定利润率提升能否持续。");
  expect(report).toContain("研究路径与检查点：比较分车型交付与终端价格。");
  expect(report).toContain("## 研究约束\n\n- 比较相同季度。");
});

it("renders only populated digest sections and keeps risk business identifiers", () => {
  const report = renderAgentReport("digest", {
    summary: "组合改善与折扣变化是下一阶段的判断重点。",
    content: {
      keyPoints: ["新产品交付占比提高。"],
      disagreements: [],
      riskSummaries: [
        { issueId: "risk.finance.1", text: "降价可能压缩利润。" },
      ],
      openQuestions: [],
    },
  });
  expect(report).toContain("## 关键要点\n\n- 新产品交付占比提高。");
  expect(report).toContain("- risk.finance.1：降价可能压缩利润。");
  expect(report).not.toContain("## 未决分歧");
  expect(report).not.toContain("## 后续问题");
});

it("renders decisions without duplicating the final rating and price renderer", () => {
  const report = renderAgentReport("decision_draft", {
    summary: "盈利兑现决定估值空间。",
    content: {
      thesis: ["产品结构改善。"],
      targetPrice: null,
      risks: ["终端折扣扩大。"],
      riskResponses: [],
      invalidationConditions: ["产品交付明显下降。"],
      limitations: [],
    },
  });
  expect(report).toContain("## 投资逻辑\n\n- 产品结构改善。");
  expect(report).toContain("## 改变判断的条件");
  expect(report).not.toContain("评级：");
  expect(report).not.toContain("目标价格：");
});

it("renders concise ask answers and omits empty sections", () => {
  expect(
    renderAgentReport("ask", {
      summary: "收盘价为83.90元。",
      content: { explanation: [], limitations: [] },
    }),
  ).toBe("收盘价为83.90元。\n");
  expect(
    renderAgentReport("ask", {
      summary: "收盘价为83.90元。",
      content: {
        explanation: ["采用当日已完成交易日的未复权价格。"],
        limitations: [],
      },
    }),
  ).toBe("收盘价为83.90元。\n\n采用当日已完成交易日的未复权价格。\n");
});

it("renders review observations and can exclude the separately stored summary", () => {
  const value: AgentReport<"review"> = {
    summary: "交付增长符合原判断。",
    content: {
      comparisons: [
        {
          original: "预期交付增长。",
          observed: "后续季度交付增长。",
          implication: "原有需求假设得到支持。",
        },
      ],
      lessons: ["跟踪新产品交付节奏。"],
      followUp: ["观察终端价格。"],
    },
  };
  const report = renderAgentReport("review", value);
  expect(report).toContain("原判断：预期交付增长。");
  expect(report).toContain("后续观察：后续季度交付增长。");
  expect(report).toContain("检验结果：原有需求假设得到支持。");
  expect(report).toContain("## 复盘经验");
  expect(report).toContain("## 后续行动");
  const note = renderAgentReport("review", value, { includeSummary: false });
  expect(note).not.toContain(value.summary);
  expect(note.startsWith("## 判断与后续观察")).toBe(true);
});

it("adds no filler for empty report bodies", () => {
  expect(
    renderAgentReport("coordinator", { summary: "研究已完成。", content: {} }),
  ).toBe("研究已完成。\n");
  expect(
    renderAgentReport("risk", {
      summary: "本阶段判断。",
      content: { issues: [] },
    }),
  ).toBe("本阶段判断。\n");
  expect(
    renderAgentReport(
      "review",
      {
        summary: "复盘结论。",
        content: { comparisons: [], lessons: [], followUp: [] },
      },
      { includeSummary: false },
    ),
  ).toBe("");
});

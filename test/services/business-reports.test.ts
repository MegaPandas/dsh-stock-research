import { expect, it } from "vitest";
import { assembleAgentArtifact } from "../../src/services/agent-artifacts.js";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import { CN_SECURITY } from "../fixtures/market.js";
import { parseArtifactInput } from "../../src/artifacts/schema.js";

const scope = {
  security: CN_SECURITY,
  date: "2026-10-28",
  cutoff: "2026-10-28T15:00:00.000Z",
};
const context = {
  taskId: "manager.decision",
  specialty: "decision",
  title: "Decision",
  inputRefs: [],
  currency: "CNY",
  referencePrice: null,
  scope,
};

it("records decision inputs at report level and leaves thesis and estimate sources unassigned", () => {
  const ref = { runId: "run", artifactId: "digest", revision: 1 };
  const content = assembleAgentArtifact(
    "decision_draft",
    {
      summary: "Demand and margins determine the outlook.",
      content: {
        thesis: ["Demand and margins determine the outlook."],
        targetPrice: {
          value: 83.9,
          method: "Earnings times a valuation multiple",
          assumptions: ["Earnings of 30 billion CNY"],
        },
        risks: [],
        riskResponses: [],
        invalidationConditions: [],
        limitations: [],
      },
    },
    {
      ...context,
      inputRefs: [ref],
    },
  );
  expect(content.inputRefs).toEqual([ref]);
  expect(content.payload).toMatchObject({
    thesis: [
      {
        text: "Demand and margins determine the outlook.",
        evidence: [],
        numbers: [],
      },
    ],
  });
  expect(content.claims).toEqual([
    {
      id: "decision.target",
      kind: "estimated",
      value: 83.9,
      unit: "CNY/share",
      method: "Earnings times a valuation multiple",
      assumptions: ["Earnings of 30 billion CNY"],
      evidence: [],
    },
  ]);
});

it("binds the rating and six-month horizon without changing the submitted business report", () => {
  const report: AgentReport<"decision_draft"> = {
    summary: "产品结构改善，现金回收决定估值。",
    content: {
      thesis: ["毛利率与存货周转决定利润和现金流。"],
      targetPrice: {
        value: 80,
        method: "预期利润乘估值倍数，再除总股数。",
        assumptions: ["利润310亿元，PE23.5倍，总股数91.17亿股。"],
      },
      risks: [],
      riskResponses: [],
      invalidationConditions: [],
      limitations: [],
    },
  };
  const original = structuredClone(report);
  const artifact = assembleAgentArtifact("decision_draft", report, {
    taskId: "manager.decision",
    specialty: "decision",
    title: "Manager decision",
    inputRefs: [],
    currency: "CNY",
    scope: {
      date: "2026-10-28",
      cutoff: "2026-10-27T16:21:19.148Z",
      security: {
        id: "CN:002594.SZ",
        market: "CN",
        symbol: "002594.SZ",
        exchange: "SZ",
        currency: "CNY",
        timeZone: "Asia/Shanghai",
      },
    },
    referencePrice: {
      artifact: { runId: "run", artifactId: "market", revision: 1 },
      claim: {
        id: "market.close",
        kind: "observed",
        value: 82.01,
        unit: "CNY/share",
        source: {
          runId: "run",
          evidenceId: "prices",
          selector: "/data/rows/0/values/close",
        },
      },
    },
  });
  expect(artifact.payload).toMatchObject({
    rating: "neutral",
    horizonEndDate: "2027-04-28",
    ratingPolicy: "absolute-price-6m/1",
    report: original,
  });
  expect(report).toEqual(original);
});

it("preserves assigned risk identifiers, report text and the stage handoff", () => {
  const issue = {
    description: "折扣扩大",
    impact: "毛利率下降。",
    trigger: "主销车型降价。",
    constraint: "估值按较低利润计算。",
    recommendation: "跟踪终端价格。",
  };
  const report: AgentReport<"risk"> = {
    summary: "价格竞争影响盈利兑现。",
    content: { issues: [issue] },
  };
  const handoff = {
    keyPoints: ["价格竞争影响盈利兑现。"],
    disagreements: [],
    risks: ["risk.finance.1"],
    openQuestions: [],
  };
  const artifact = assembleAgentArtifact(
    "risk",
    report,
    { ...context, taskId: "risk.finance" },
    [],
    handoff,
  );
  expect(artifact.payload).toEqual({
    issues: [
      { ...issue, issueId: "risk.finance.1", evidence: [], numbers: [] },
    ],
    report,
    stageHandoff: handoff,
  });
  expect(artifact.body).toBe(
    "价格竞争影响盈利兑现。\n\n## risk.finance.1：折扣扩大\n\n影响：毛利率下降。\n\n触发条件：主销车型降价。\n\n建议约束：估值按较低利润计算。\n\n处置建议：跟踪终端价格。\n",
  );
  expect(parseArtifactInput(artifact)).toEqual(artifact);
});

it("keeps research questions and their decision impact in a valid plan artifact", () => {
  const report: AgentReport<"plan"> = {
    summary: "确定新产品的盈利贡献。",
    content: {
      questions: [
        {
          question: "产品组合贡献多少？",
          whyItMatters: "决定利润率能否持续。",
          nextStep: "比较交付与价格。",
        },
      ],
      constraints: ["比较相同季度。"],
    },
  };
  const artifact = assembleAgentArtifact("plan", report, context);
  expect(artifact.payload).toEqual({
    thesis: [{ text: report.summary, evidence: [], numbers: [] }],
    questions: [
      "产品组合贡献多少？：决定利润率能否持续。；研究路径：比较交付与价格。",
    ],
    constraints: ["比较相同季度。"],
    report,
  });
  expect(artifact.body).toContain("判断影响：决定利润率能否持续。");
  expect(artifact.body).toContain("研究路径与检查点：比较交付与价格。");
  expect(parseArtifactInput(artifact)).toEqual(artifact);
});

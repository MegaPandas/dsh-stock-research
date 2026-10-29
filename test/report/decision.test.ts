import { describe, expect, it } from "vitest";
import type { DecisionResult } from "../../src/contracts/artifact-payloads.js";
import type {
  ArtifactVersion,
  NumericClaim,
} from "../../src/contracts/artifacts.js";
import { renderDecisionReport } from "../../src/report/decision.js";
import { renderArtifact } from "../../src/report/render.js";

const ref = { runId: "run", artifactId: "draft", revision: 2 };
const source = {
  runId: "run",
  evidenceId: "prices",
  selector: "/data/bars/0/close",
};
const base: NumericClaim = {
  id: "original-base",
  kind: "observed",
  value: 100,
  unit: "USD/share",
  source,
};
const target: NumericClaim = {
  id: "original-target",
  kind: "estimated",
  value: 120,
  unit: "USD/share",
  method: "情景估值",
  assumptions: ["利润增长"],
  evidence: [source],
};
function result(): DecisionResult {
  return {
    rating: "strong_sell",
    horizonEndDate: "2025-06-30",
    thesis: [
      {
        text: "## 判断\n\n**保留 Markdown**",
        evidence: [],
        numbers: [{ kind: "local", claimId: base.id }],
      },
    ],
    basePrice: { kind: "local", claimId: base.id },
    targetPrice: { kind: "local", claimId: target.id },
    risks: ["需求回落"],
    riskResponses: [
      { issueId: "demand", disposition: "unresolved", reason: "仍需观察" },
    ],
    invalidationConditions: ["需求恢复"],
    limitations: ["缺少最新披露"],
    schemaVersion: 1,
    runId: "run",
    securityId: "US:EXAMPLE",
    cutoff: "2024-06-30T20:00:00.000Z",
    draftRef: ref,
    inputRefs: [],
    computedReturn: 0.2,
    validation: { checkedRefs: [ref], warnings: ["时点未经验证"] },
    finalizedAt: "2024-07-01T00:00:00.000Z",
  };
}
function section(
  artifactId: string,
  revision: number,
  body: string,
): ArtifactVersion {
  return {
    ref: { runId: "run", artifactId, revision },
    taskId: "task",
    attempt: 1,
    producerSessionId: null,
    createdAt: "2024-07-01T00:00:00.000Z",
    schemaVersion: 1,
    content: {
      kind: "analysis",
      title: artifactId,
      body,
      inputRefs: [],
      claims: [],
      payload: {},
    },
  };
}

describe("renderDecisionReport", () => {
  it("shows the fixed six-month price-rating policy separately from model prose", () => {
    const decision: DecisionResult = {
      ...result(),
      rating: "neutral",
      ratingPolicy: "absolute-price-6m/1",
      horizonEndDate: "2024-12-30",
      computedReturn: -0.02,
    };
    const report = renderDecisionReport(
      decision,
      { base, target: { ...target, value: 98 } },
      [],
    );
    expect(report).toContain("评级：中性");
    expect(report).toContain("判断期限：2024-12-30");
    expect(report).toContain("评级口径：六个月绝对价格变动");
    expect(report).toContain("预期价格变动（不含股息）：-2%");
    expect(report).not.toContain("预期收益");
  });

  it.each([
    ["buy", "买入"],
    ["overweight", "增持"],
    ["neutral", "中性"],
    ["underweight", "减持"],
    ["sell", "卖出"],
  ] as const)("renders current rating %s as %s", (rating, label) => {
    expect(
      renderDecisionReport(
        { ...result(), rating, ratingPolicy: "absolute-price-6m/1" },
        { base, target },
        [],
      ),
    ).toContain(`评级：${label}`);
  });

  it("uses the submitted summary on the front page and retains all supporting theses", () => {
    const decision = result();
    decision.thesis = [
      { text: "海外渠道扩张推动增长。", evidence: [], numbers: [] },
    ];
    decision.report = {
      summary: "增长驱动仍在，投资判断取决于渠道扩张兑现。",
      content: {
        thesis: decision.thesis.map(({ text }) => text),
        targetPrice: null,
        risks: decision.risks,
        riskResponses: [
          {
            issueId: "demand",
            disposition: "constrained",
            reason: "将需求转弱纳入仓位约束。",
          },
        ],
        invalidationConditions: decision.invalidationConditions,
        limitations: decision.limitations,
      },
    };
    decision.riskResponses = decision.report.content.riskResponses;
    const report = renderDecisionReport(decision, { base, target: null }, []);
    expect(report).toContain(`## 核心判断\n\n- ${decision.report.summary}`);
    expect(report.indexOf("海外渠道扩张推动增长。")).toBeGreaterThan(
      report.indexOf("详细论据与适用范围"),
    );
    expect(report).toContain("纳入决策约束");
  });

  it("renders an unavailable rating and base price without inventing numeric values", () => {
    const report = renderDecisionReport(
      { ...result(), rating: null, basePrice: null, computedReturn: null },
      { base: null, target },
      [],
    );
    expect(report).toContain("评级：未评级");
    expect(report).toContain("基准价格：未设定");
    expect(report).toContain("目标价格：120 USD/股");
    expect(report).not.toContain("预期收益");
  });
  it("preserves rating, horizon and ordinary security/date text", () => {
    const report = renderDecisionReport(result(), { base, target }, []);
    expect(report).toContain("评级：强烈卖出");
    expect(report).toContain("判断期限：2025-06-30");
    expect(report).toContain("US:EXAMPLE");
    expect(report).toContain("2024-06-30T20:00:00.000Z");
  });
  it("renders prices and the already computed return without recalculation", () => {
    const report = renderDecisionReport(
      { ...result(), computedReturn: 0.125 },
      { base, target },
      [],
    );
    expect(report).toContain("基准价格：100 USD/股");
    expect(report).toContain("目标价格：120 USD/股（估计）");
    expect(report).toContain("预期收益（基于估计）：12.5%");
    expect(report).not.toContain("20%");
  });
  it("shows estimate method and assumptions with source records accessible through the decision JSON", () => {
    const report = renderDecisionReport(result(), { base, target }, []);
    expect(report).toContain("方法：情景估值");
    expect(report).toContain("- 利润增长");
    expect(report).toContain("(decision.json)");
    expect(report).not.toContain("evidence/prices.json");
  });
  it("marks return based on an estimated base price", () => {
    const estimatedBase: NumericClaim = { ...target, id: "base", value: 100 };
    const observedTarget: NumericClaim = { ...base, value: 120 };
    expect(
      renderDecisionReport(
        result(),
        { base: estimatedBase, target: observedTarget },
        [],
      ),
    ).toContain("预期收益（基于估计）：20%");
  });
  it("omits absent target and null return while preserving the selected rating", () => {
    const report = renderDecisionReport(
      { ...result(), targetPrice: null, computedReturn: null },
      { base, target: null },
      [],
    );
    expect(report).toContain("评级：强烈卖出");
    expect(report).not.toContain("目标价格：");
    expect(report).not.toContain("预期收益");
    expect(report).not.toContain("0%");
  });
  it("retains business risks and limitations without rendering internal validation warnings", () => {
    const report = renderDecisionReport(result(), { base, target }, []);
    expect(report).toContain("demand（待解决）：仍需观察");
    expect(report).toContain("缺少最新披露");
    expect(report).not.toContain("时点未经验证");
    expect(report).not.toContain("校验记录</summary>");
    expect(report).toContain("需求回落");
    expect(report).toContain("需求恢复");
    const main = report.slice(0, report.indexOf("<details>"));
    expect(main).not.toContain("仍需观察");
    expect(main).not.toContain("时点未经验证");
    expect(main).not.toContain("缺少最新披露");
  });
  it("links the exact versions without concatenating the upstream reports", () => {
    const first = section(
      "first",
      3,
      "**原文**\n\n日期 2024-06-30，代码 000001。",
    );
    const second = section("second", 8, "第二节 {{number:price}}");
    second.content.claims = [{ ...base, id: "price" }];
    const report = renderDecisionReport(result(), { base, target }, [
      second,
      first,
    ]);
    expect(report.indexOf("[second](artifacts/second/8.json)")).toBeLessThan(
      report.indexOf("[first](artifacts/first/3.json)"),
    );
    expect(report).not.toContain("第二节");
    expect(report).not.toContain("**原文**");
    expect(report).not.toContain("## 数值声明");
  });
  it("keeps business prose free of inline provenance and preserves the structured references", () => {
    const input = result();
    input.thesis = [
      {
        text: "当前观察支持判断。",
        evidence: [ref, source, { ...source, selector: "/data/bars/0/open" }],
        numbers: [{ kind: "artifact", artifact: ref, claimId: "close" }],
      },
    ];
    input.validation.warnings = ["时点未经验证", "时点未经验证"];
    const before = structuredClone(input);
    const report = renderDecisionReport(input, { base, target }, []);
    expect(report).toContain("- 当前观察支持判断。\n");
    expect(report).not.toMatch(/\[\d+\]\(/);
    expect(report).not.toContain("### 正文引用");
    expect(input).toEqual(before);
    expect(report).not.toContain("时点未经验证");
    expect(report).not.toContain("产物：run/");
    expect(report).not.toContain("数字：run/");
  });
  it("keeps the executive premise on the first page and preserves detail in the appendix", () => {
    const input = result();
    input.thesis = [
      { text: "走势偏弱，反弹尚未确认。", evidence: [ref], numbers: [] },
      { text: "详细价格路径及其证据。", evidence: [source], numbers: [] },
    ];
    const report = renderDecisionReport(input, { base, target }, []);
    const main = report.slice(0, report.indexOf("<details>"));
    expect(main).toContain("走势偏弱，反弹尚未确认。");
    expect(main).not.toContain("详细价格路径");
    expect(report).toContain("<summary>详细论据与适用范围</summary>");
    expect(report).toContain("详细价格路径及其证据。");
    expect(report).toContain("(decision.json)");
  });
  it("shows the actual limitations when no supported thesis is available", () => {
    const report = renderDecisionReport(
      { ...result(), rating: null, thesis: [] },
      { base, target },
      [],
    );
    const main = report.slice(0, report.indexOf("<details>"));
    expect(main).toContain("## 已知情况与限制");
    expect(main).toContain("缺少最新披露");
    expect(main).not.toContain("## 核心判断");
  });
  it("distinguishes fixed-data cutoff from the latest public search capture", () => {
    const report = renderDecisionReport(
      result(),
      { base, target },
      [],
      "2024-06-30T23:00:00.000Z",
    );
    expect(report).toContain("固定数据截止：2024-06-30T20:00:00.000Z");
    expect(report).toContain("公开检索截至：2024-06-30T23:00:00.000Z");
    expect(renderDecisionReport(result(), { base, target }, [])).not.toContain(
      "公开检索截至",
    );
  });
  it("leaves trusted results, price claims and sections unchanged", () => {
    const input = {
      result: result(),
      prices: { base, target },
      sections: [section("first", 3, "原文")],
    };
    const before = structuredClone(input);
    renderDecisionReport(input.result, input.prices, input.sections);
    expect(input).toEqual(before);
  });
  it("keeps metadata template text literal when the final container is rendered", () => {
    const markdown = renderDecisionReport(
      { ...result(), limitations: ["Quote {{number:missing}}"] },
      { base, target },
      [],
    );
    expect(markdown).toContain("Quote &#123;&#123;number:missing}}");
    expect(() =>
      renderArtifact({
        kind: "report",
        title: "Final",
        body: markdown,
        claims: [],
        inputRefs: [],
        payload: {},
      }),
    ).not.toThrow();
  });
});

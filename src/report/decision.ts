import type { DecisionResult, Rating } from "../contracts/artifact-payloads.js";
import type { ArtifactVersion, NumericClaim } from "../contracts/artifacts.js";
import type { ArtifactRef, ISOTime } from "../contracts/data.js";
import { inline, numberText, valueText } from "./render.js";
import { PRICE_RATING_POLICY } from "../contracts/rating-policy.js";
import { renderValuation } from "./valuation.js";

const RATINGS: Record<Rating, string> = {
  strong_buy: "强烈买入",
  buy: "买入",
  hold: "持有",
  sell: "卖出",
  strong_sell: "强烈卖出",
  overweight: "增持",
  neutral: "中性",
  underweight: "减持",
};
const DISPOSITIONS = {
  accepted: "已采纳",
  mitigated: "已缓解",
  constrained: "纳入决策约束",
  unresolved: "待解决",
} as const;

function artifactPath(ref: ArtifactRef): string {
  return `artifacts/${encodeURIComponent(ref.artifactId)}/${ref.revision}.json`;
}
function appendix(title: string, contents: string[]): string[] {
  return contents.length === 0
    ? []
    : [
        "",
        "<details>",
        `<summary>${title}</summary>`,
        "",
        ...contents,
        "",
        "</details>",
      ];
}

export function renderDecisionReport(
  result: DecisionResult,
  prices: { base: NumericClaim | null; target: NumericClaim | null },
  sections: readonly ArtifactVersion[],
  publicSearchAsOf: ISOTime | null = null,
): string {
  const lines = [
    `# 决策报告 ${inline(result.securityId)}`,
    "",
    `**评级：${result.rating === null ? "未评级" : RATINGS[result.rating]}** · 判断期限：${result.horizonEndDate}`,
    ...(result.ratingPolicy === PRICE_RATING_POLICY
      ? [
          "评级口径：六个月绝对价格变动；买入 >15%，增持 >5% 至15%，中性 -5% 至5%，减持 -15% 至 <-5%，卖出 <-15%。",
        ]
      : []),
    "",
    `固定数据截止：${result.cutoff}`,
    ...(publicSearchAsOf === null ? [] : [`公开检索截至：${publicSearchAsOf}`]),
    "",
    prices.base === null
      ? "基准价格：未设定"
      : `基准价格：${numberText(prices.base)}`,
  ];
  if (prices.target !== null)
    lines.push(`目标价格：${numberText(prices.target)}`);
  if (result.computedReturn !== null) {
    const estimated =
      prices.base?.kind === "estimated" || prices.target?.kind === "estimated";
    const label =
      result.ratingPolicy === PRICE_RATING_POLICY
        ? "预期价格变动（不含股息）"
        : estimated
          ? "预期收益（基于估计）"
          : "预期收益";
    lines.push(`${label}：${valueText(result.computedReturn, "ratio")}`);
  }
  const list = (title: string, items: string[]): void => {
    if (items.length > 0)
      lines.push("", `## ${title}`, "", ...items.map((item) => `- ${item}`));
  };
  const thesis = result.thesis.map((thesis) => thesis.text);
  const summary = result.report?.summary;
  list("核心判断", summary === undefined ? thesis.slice(0, 1) : [summary]);
  list("关键风险", result.risks);
  list("何时需要重新评估", result.invalidationConditions);
  const limitations = [...new Set(result.limitations)];
  if (summary === undefined && thesis.length === 0)
    list("已知情况与限制", limitations);
  lines.push(
    ...appendix("详细论据与适用范围", [
      ...(summary === undefined ? thesis.slice(1) : thesis).map(
        (item) => `- ${item}`,
      ),
      ...((summary !== undefined || thesis.length > 0) && limitations.length > 0
        ? [
            "",
            "### 数据范围与限制",
            "",
            ...limitations.map((item) => `- ${item}`),
          ]
        : []),
    ]),
  );
  lines.push(
    ...appendix(
      "风险处置明细",
      result.riskResponses.map(
        (response) =>
          `- ${inline(response.issueId)}（${DISPOSITIONS[response.disposition]}）：${response.reason}`,
      ),
    ),
  );
  const estimates = (
    [
      ["基准价格", prices.base],
      ["目标价格", prices.target],
    ] as const
  ).flatMap(([label, claim]) =>
    claim?.kind === "estimated"
      ? [
          `### ${label}的估计依据`,
          "",
          `方法：${inline(claim.method)}`,
          "",
          ...claim.assumptions.map((assumption) => `- ${inline(assumption)}`),
        ]
      : [],
  );
  const valuation =
    result.report !== undefined && "valuation" in result.report.content
      ? result.report.content.valuation
      : undefined;
  lines.push(
    ...appendix("估值假设", [...estimates, ...renderValuation(valuation)]),
  );
  lines.push(
    ...appendix("研究过程与数据依据", [
      ...sections.map(
        (section) =>
          `- [${inline(section.content.title)}](${artifactPath(section.ref)}) · 版本 ${section.ref.revision}`,
      ),
      "",
      "[完整决策与核验记录](decision.json)",
      "",
      `定档时间：${result.finalizedAt}`,
    ]),
  );
  return `${lines.join("\n")}\n`.replace(/\{\{number\b/g, "&#123;&#123;number");
}

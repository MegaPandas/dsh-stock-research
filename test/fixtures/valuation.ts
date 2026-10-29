import type { ValuationRecord } from "../../src/contracts/agent-reports.js";
import { decisionPolicy } from "../../src/contracts/rating-policy.js";
import type { ValuationRequest } from "../../src/contracts/valuation.js";
import type { ValuationSelection } from "../../src/services/valuation-calculations.js";

export function calculationRequest(
  purpose: "valuation" | "target_price" = "valuation",
): ValuationRequest {
  return {
    methodId: "comparable_multiples",
    purpose,
    amountUnit: "unit",
    shares: { value: 1, unit: "unit" },
    inputs: {
      multipleType: "pe",
      netIncome: 8,
      multiples: purpose === "valuation" ? [24, 30] : [28.8],
    },
    assumptions: [
      "人工测试情景：每股盈利8，研究日倍数24至30，目标日倍数28.8；无期间分红、融资或股数变化。",
    ],
    provenance: [
      { path: "/inputs", kind: "assumed", basis: "人工测试的盈利与定价假设。" },
      { path: "/shares", kind: "assumed", basis: "人工固定普通股股数。" },
    ],
    sensitivities: [],
  };
}

export function valuationSelection(
  record: ValuationRecord,
): ValuationSelection {
  return {
    companyProfile: record.companyProfile,
    methods: record.methods.map(
      ({ methodId, suitability, limitations, calculationIds }) => ({
        methodId,
        suitability,
        limitations,
        calculationIds: calculationIds ?? [],
      }),
    ),
    targetPriceBasis: record.targetPriceBasis,
  };
}

/** Synthetic valuation inputs; no live company observations. */
export function valuationRecord(
  date = "2024-01-03",
  currency = "CNY",
  quantified = false,
): ValuationRecord {
  return {
    companyProfile: "人工成熟制造企业，阶段判断仅用于测试。",
    valuationDate: date,
    targetDate: decisionPolicy(date).horizonEndDate,
    methods: [
      {
        methodId: "comparable_multiples",
        suitability:
          "人工盈利情景用于检验估值记录交接；真实可比样本仍需另行核实。",
        valueObject: "per_share",
        inputs: quantified
          ? [
              {
                name: `未来年度普通股EPS（${currency}/share）`,
                value: "8",
                kind: "assumed",
                basis: "人工预测情景。",
              },
              {
                name: "可比PE（倍）",
                value: "24至30",
                kind: "assumed",
                basis: "人工定价区间，不代表市场样本。",
              },
            ]
          : [],
        assumptions: quantified ? ["人工情景EPS为8，PE为24至30倍。"] : [],
        calculation: quantified ? ["8×24=192；8×30=240。"] : [],
        valueRange: quantified
          ? { low: 192, high: 240, unit: `${currency}/share` }
          : null,
        sensitivity: quantified ? ["PE每变化1倍，每股价值变化8。"] : [],
        limitations: ["人工测试材料，真实公司输入与可比样本未核实。"],
      },
    ],
    targetPriceBasis: quantified
      ? "人工六个月情景采用PE28.8倍；假设期间无分红、融资或股数变化，价格在目标日反映该盈利假设。"
      : null,
  };
}

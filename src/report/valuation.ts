import type { ValuationRecord } from "../contracts/agent-reports.js";
import type { ValuationMethodId } from "../contracts/valuation.js";
import { formatNumber, inline, valueText } from "./render.js";
import {
  formatValuationDiagnostic,
  formatValuationStep,
} from "./valuation-labels.js";

export function renderValuation(
  record: ValuationRecord | null | undefined,
): string[] {
  if (record == null) return [];
  const list = (label: string, items: readonly string[]) =>
    items.length === 0
      ? []
      : ["", `**${label}**`, "", ...items.map((item) => `- ${item}`)];
  const inputs = {
    observed: "观察值",
    normalized: "正常化调整",
    assumed: "预测假设",
  };
  return [
    "",
    "## 估值依据",
    "",
    record.companyProfile,
    "",
    `价值日期：${record.valuationDate}；目标价格日期：${record.targetDate}。`,
    ...record.methods.flatMap((method, index) => [
      "",
      `### ${index === 0 ? "主模型" : "交叉核对"}：${inline(method.methodId)}`,
      "",
      method.suitability,
      "",
      "价值对象：普通股每股价值。",
      ...list(
        "输入与依据",
        method.calculations.flatMap((calculation) =>
          calculation.inputs.map((input) => {
            const value = JSON.stringify(input.value, (_key, item: unknown) =>
              typeof item === "number" ? Number(formatNumber(item)) : item,
            );
            return `${calculation.calculationId}:${input.path}：${value} (amountUnit=${calculation.amountUnit}; shareUnit=${calculation.shareUnit})（${inputs[input.kind]}）；${input.basis}`;
          }),
        ),
      ),
      ...list("模型假设", [
        ...new Set(
          method.calculations.flatMap(({ assumptions }) => assumptions),
        ),
      ]),
      ...list(
        "计算步骤",
        method.calculations.flatMap((calculation) => [
          `计算 ${calculation.calculationId}；算法版本 ${calculation.engineVersion}`,
          ...calculation.steps.map((step) =>
            formatValuationStep(step, method.methodId as ValuationMethodId),
          ),
        ]),
      ),
      "",
      method.valueRange === null
        ? "研究日价值区间：未量化。"
        : `研究日价值区间：${valueText(method.valueRange.low, method.valueRange.unit)} 至 ${valueText(method.valueRange.high, method.valueRange.unit)}。`,
      ...list(
        "敏感性与替代情景",
        method.calculations.flatMap((calculation) =>
          calculation.sensitivities.map((scenario) => {
            const values = scenario.perShareValues
              .map((value) => valueText(value, `${record.currency}/share`))
              .join(", ");
            return `${scenario.label}：${scenario.path}=${formatNumber(scenario.value)}；每股结果=${values}；依据：${scenario.basis}`;
          }),
        ),
      ),
      ...list("输入缺口与适用限制", [
        ...new Set([
          ...method.limitations,
          ...method.calculations.flatMap(({ diagnostics }) =>
            diagnostics.map(formatValuationDiagnostic),
          ),
        ]),
      ]),
    ]),
    ...(record.targetPriceBasis === null
      ? []
      : ["", "### 六个月目标价依据", "", record.targetPriceBasis]),
  ];
}

import type { ValuationRecord } from "../contracts/agent-reports.js";
import { inline, valueText } from "./render.js";

export function renderValuation(
  record: ValuationRecord | null | undefined,
): string[] {
  if (record == null) return [];
  const list = (label: string, items: readonly string[]) =>
    items.length === 0
      ? []
      : ["", `**${label}**`, "", ...items.map((item) => `- ${item}`)];
  const objects = {
    operating_assets: "经营资产",
    common_equity: "普通股股权",
    per_share: "普通股每股价值",
    project: "项目",
  };
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
      `价值对象：${objects[method.valueObject]}。`,
      ...list(
        "输入与依据",
        method.inputs.map(
          (input) =>
            `${input.name}：${input.value}（${inputs[input.kind]}）；${input.basis}`,
        ),
      ),
      ...list("模型假设", method.assumptions),
      ...list("计算步骤", method.calculation),
      "",
      method.valueRange === null
        ? "研究日价值区间：未量化。"
        : `研究日价值区间：${valueText(method.valueRange.low, method.valueRange.unit)} 至 ${valueText(method.valueRange.high, method.valueRange.unit)}。`,
      ...list("敏感性与替代情景", method.sensitivity),
      ...list("输入缺口与适用限制", method.limitations),
    ]),
    ...(record.targetPriceBasis === null
      ? []
      : ["", "### 六个月目标价依据", "", record.targetPriceBasis]),
  ];
}

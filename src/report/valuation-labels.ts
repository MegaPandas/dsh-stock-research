import type {
  CalculationStep,
  ValuationMethodId,
} from "../contracts/valuation.js";
import { valueText } from "./render.js";

const STEP_LABELS: Record<string, string> = {
  "Discount rate": "折现率",
  "Excess cash": "超额现金",
  "Non-operating assets": "非经营资产",
  Debt: "有息债务",
  "Preferred equity": "优先股权益",
  "Minority interest": "少数股东权益",
  "Other claims": "其他索取权",
  "Terminal recovery": "期末回收额",
  "Terminal growth rate": "永续增长率",
  "Next-period cash flow": "下一期现金流",
  "Terminal value": "终值",
  "Terminal present value": "终值现值",
  "Terminal present value / total present value": "终值现值占总现值比例",
  "Terminal base full period years": "终值基期完整年数",
  "Terminal annualized NOPAT": "终值基期年化税后经营利润",
  "Terminal annualized net income": "终值基期年化净利润",
  "Terminal annualized dividend": "终值基期年化股利",
  "Terminal reinvestment rate": "终值再投资比例",
  "Terminal next NOPAT": "下一期税后经营利润",
  "Terminal next net income": "下一期净利润",
  "Terminal reinvestment": "终值再投资额",
  "Terminal sustainable cash flow": "终值可持续现金流",
  "Terminal financing discount rate": "终值融资折现率",
  "Terminal financing amount": "期末融资净额",
  "Terminal next annual financing cash flow": "下一完整年度融资净现金流",
  "Terminal financing value": "融资终值",
  "Terminal financing present value": "融资终值现值",
  "Terminal required capital increase": "终值所需资本增加额",
  "Terminal retained income": "终值留存收益",
  "Terminal payout ratio": "终值派息率",
  "Terminal dividend": "终值股利",
  "Terminal residual income": "终值剩余收益",
  "Opening common book equity at value date": "估值日期初普通股账面权益",
  "Comparable metric": "倍数法经济指标",
  "Comparable multiple": "估值倍数",
  "Metric times multiple": "经济指标乘以估值倍数",
  Liabilities: "负债",
  "Priority claims": "优先索取权",
  "Disposal costs": "处置费用",
  "Initial project cash flow": "项目初始现金流",
  "Unallocated group assets": "集团未分配资产",
  "Unallocated group liabilities": "集团未分配负债",
  "Head office present value": "总部费用现值",
  "Common shares": "普通股股数",
};

const PERIOD_LABELS: Record<string, string> = {
  "remaining fraction": "剩余期间比例",
  "discount years": "折现年数",
  "remaining cash flow": "剩余期间现金流",
  "cash flow present value": "现金流现值",
  EBIT: "息税前经营利润",
  "operating tax": "经营税额",
  NOPAT: "税后经营利润",
  "working capital increase": "营运资本增加额",
  FCFF: "企业自由现金流",
  "financing discount rate": "融资折现率",
  "financing present value": "融资效应现值",
  "required capital increase": "所需资本增加额",
  dividends: "股利",
  "opening common book equity": "期初普通股账面权益",
  "closing common book equity": "期末普通股账面权益",
  "residual income": "剩余收益",
};

const RATE_SUFFIXES = [
  [" beta times equity risk premium", "β乘以股权风险溢价"],
  [" cost of equity", "股权成本"],
  [" weighted equity cost", "加权股权成本"],
  [" weighted after-tax debt cost", "加权税后债务成本"],
  [" CAPM", "（CAPM）"],
  [" WACC", "（WACC）"],
] as const;

const ACTION_LABELS: Record<string, string> = {
  exercise: "行权",
  abandon: "放弃",
  continue: "继续",
};

function stepLabel(label: string, methodId: ValuationMethodId): string {
  const attributed =
    /^(.*): (attributable fair value|probability-weighted equity|attributable common equity)$/.exec(
      label,
    );
  if (attributed !== null) {
    const descriptions: Record<string, string> = {
      "attributable fair value": "归属公允价值",
      "probability-weighted equity": "概率加权股权价值",
      "attributable common equity": "归属普通股权益",
    };
    return `${attributed[1]}：${descriptions[attributed[2]!]}`;
  }

  if (methodId === "real_options") {
    const action = /^(.*): (exercise|abandon|continue) value$/.exec(label);
    if (action !== null)
      return `${action[1]}：${ACTION_LABELS[action[2]!]}价值`;
    const optimal = /^(.*): optimal (exercise|abandon|continue)$/.exec(label);
    if (optimal !== null)
      return `${optimal[1]}：最优决策为${ACTION_LABELS[optimal[2]!]}`;
    const nodeRate = /^(.*) discount rate$/.exec(label);
    if (nodeRate !== null) return `节点${nodeRate[1]}折现率`;
  }

  const fixed = STEP_LABELS[label];
  if (fixed !== undefined) return fixed;

  if (methodId === "sum_of_parts" && label.startsWith("Head office "))
    return `总部费用：${stepLabel(label.slice("Head office ".length), methodId)}`;

  for (const [suffix, translated] of RATE_SUFFIXES)
    if (label.endsWith(suffix))
      return `${stepLabel(label.slice(0, -suffix.length), methodId)}${translated}`;

  const period = /^Period (\d+) (.+)$/.exec(label);
  if (period !== null && PERIOD_LABELS[period[2]!] !== undefined)
    return `第${period[1]}期${PERIOD_LABELS[period[2]!]}`;

  const year = /^Year (\d+) probability-weighted cash flow$/.exec(label);
  if (year !== null) return `第${year[1]}年概率加权现金流`;

  const equity = /^Common equity value (\d+)$/.exec(label);
  if (equity !== null) return `普通股权益价值${equity[1]}`;
  const perShare = /^Common value per share (\d+)$/.exec(label);
  if (perShare !== null) return `普通股每股价值${perShare[1]}`;

  throw new Error(`Unknown valuation report step label: ${label}`);
}

export function formatValuationStep(
  { label, value, unit }: CalculationStep,
  methodId: ValuationMethodId,
): string {
  return `${stepLabel(label, methodId)}=${valueText(value, unit)}`;
}

const DIAGNOSTICS: Record<string, string> = {
  "Terminal reinvestment exceeds income; the forecast assumes additional financing.":
    "终值再投资额超过收益，预测假设需要额外融资。",
  "Terminal retained income exceeds net income; the forecast assumes additional financing.":
    "终值留存收益超过净利润，预测假设需要额外融资。",
  "Negative equity residual is not a usable target share price; analyze solvency and allocation of claims.":
    "股权残值为负，不能作为目标股价；应分析偿付能力和索取权分配。",
};

export function formatValuationDiagnostic(message: string): string {
  const translated = DIAGNOSTICS[message];
  if (translated === undefined)
    throw new Error(`Unknown valuation report diagnostic: ${message}`);
  return translated;
}

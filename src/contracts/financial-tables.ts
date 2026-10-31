// Names identify derived series; arrays list retained table fields in preference order.
export const FINANCIAL_FLOW_FIELDS = {
  "financial.income": {
    REVENUE: ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME"],
    NET_INCOME: ["PARENT_NETPROFIT"],
    DEDUCTED_NET_INCOME: ["DEDUCT_PARENT_NETPROFIT"],
    COST: ["OPERATE_COST"],
    OPERATING_PROFIT: ["OPERATE_PROFIT"],
  },
  "financial.indicators": {
    REVENUE: ["TOTALOPERATEREVE"],
    NET_INCOME: ["PARENTNETPROFIT"],
    DEDUCTED_NET_INCOME: ["KCFJCXSYJLR"],
  },
  "financial.revenue": { REVENUE: ["revenue"] },
  "financial.netIncome": { NET_INCOME: ["netIncome"] },
  "financial.cashflow": {
    OCF: ["NETCASH_OPERATE"],
    CAPEX: ["CONSTRUCT_LONG_ASSET"],
  },
} as const;

// Each group requires one reported value; optional calculation inputs stay optional.
export const FINANCIAL_CORE_FIELDS: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  "financial.indicators": [
    FINANCIAL_FLOW_FIELDS["financial.indicators"].REVENUE,
    FINANCIAL_FLOW_FIELDS["financial.indicators"].NET_INCOME,
    ["BPS"],
  ],
  "financial.quarter": [
    FINANCIAL_FLOW_FIELDS["financial.indicators"].REVENUE,
    FINANCIAL_FLOW_FIELDS["financial.indicators"].NET_INCOME,
  ],
  "financial.income": [
    FINANCIAL_FLOW_FIELDS["financial.income"].REVENUE,
    FINANCIAL_FLOW_FIELDS["financial.income"].NET_INCOME,
  ],
  "financial.balance": [
    ["TOTAL_ASSETS"],
    ["TOTAL_LIABILITIES"],
    ["TOTAL_PARENT_EQUITY"],
  ],
  "financial.cashflow": [
    FINANCIAL_FLOW_FIELDS["financial.cashflow"].OCF,
    FINANCIAL_FLOW_FIELDS["financial.cashflow"].CAPEX,
  ],
};

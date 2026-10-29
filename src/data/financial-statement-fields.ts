import type { CollectionColumn } from "../contracts/collection.js";

interface StatementField {
  label: string;
  // Keys are F10 column names unless explicitly marked unavailable.
  eastmoney?: false;
  xueqiu?: string;
  xueqiuScale?: number;
}

// Source-specific totals and details remain separate; overlapping lines are not additive.
export const STATEMENT_FIELDS: Record<
  string,
  Record<string, StatementField>
> = {
  "financial.income": {
    TOTAL_OPERATE_INCOME: {
      label: "营业总收入",
      xueqiu: "total_revenue",
    },
    OPERATE_INCOME: {
      label: "营业收入",
      xueqiu: "revenue",
    },
    TOTAL_OPERATE_COST: {
      label: "营业总成本",
      xueqiu: "operating_costs",
    },
    OPERATE_COST: {
      label: "营业成本",
      xueqiu: "operating_cost",
    },
    OPERATE_TAX_ADD: {
      label: "税金及附加",
      xueqiu: "operating_taxes_and_surcharge",
    },
    SALE_EXPENSE: {
      label: "销售费用",
      xueqiu: "sales_fee",
    },
    MANAGE_EXPENSE: {
      label: "管理费用",
      xueqiu: "manage_fee",
    },
    RESEARCH_EXPENSE: {
      label: "研发费用",
      xueqiu: "rad_cost",
    },
    FINANCE_EXPENSE: {
      label: "财务费用",
      xueqiu: "financing_expenses",
    },
    FE_INTEREST_EXPENSE: {
      label: "财务费用中的利息费用",
      xueqiu: "finance_cost_interest_fee",
    },
    FE_INTEREST_INCOME: {
      label: "财务费用中的利息收入",
      xueqiu: "finance_cost_interest_income",
    },
    INVEST_INCOME: {
      label: "投资收益",
      xueqiu: "invest_income",
    },
    INVEST_JOINT_INCOME: {
      label: "联营合营企业投资收益",
      xueqiu: "invest_incomes_from_rr",
    },
    FAIRVALUE_CHANGE_INCOME: {
      label: "公允价值变动收益",
      xueqiu: "income_from_chg_in_fv",
    },
    ASSET_IMPAIRMENT_INCOME: {
      label: "资产减值收益",
      xueqiu: "asset_impairment_loss",
      xueqiuScale: -1,
    },
    CREDIT_IMPAIRMENT_INCOME: {
      label: "信用减值收益",
      xueqiu: "credit_impairment_loss",
      xueqiuScale: -1,
    },
    ASSET_DISPOSAL_INCOME: {
      label: "资产处置收益",
      xueqiu: "asset_disposal_income",
    },
    OTHER_INCOME: {
      label: "其他收益",
      xueqiu: "other_income",
    },
    EXCHANGE_INCOME: {
      label: "汇兑收益",
      xueqiu: "exchg_gain",
    },
    OPERATE_PROFIT: {
      label: "营业利润",
      xueqiu: "op",
    },
    NONBUSINESS_INCOME: {
      label: "营业外收入",
      xueqiu: "non_operating_income",
    },
    NONBUSINESS_EXPENSE: {
      label: "营业外支出",
      xueqiu: "non_operating_payout",
    },
    TOTAL_PROFIT: {
      label: "利润总额",
      xueqiu: "profit_total_amt",
    },
    INCOME_TAX: {
      label: "所得税费用",
      xueqiu: "income_tax_expenses",
    },
    NETPROFIT: {
      label: "净利润",
      xueqiu: "net_profit",
    },
    CONTINUED_NETPROFIT: {
      label: "持续经营净利润",
      xueqiu: "continous_operating_np",
    },
    PARENT_NETPROFIT: {
      label: "归母净利润",
      xueqiu: "net_profit_atsopc",
    },
    MINORITY_INTEREST: {
      label: "少数股东损益",
      xueqiu: "minority_gal",
    },
    DEDUCT_PARENT_NETPROFIT: {
      label: "扣非归母净利润",
      xueqiu: "net_profit_after_nrgal_atsolc",
    },
    OTHER_COMPRE_INCOME: {
      label: "其他综合收益",
      xueqiu: "othr_compre_income",
    },
    TOTAL_COMPRE_INCOME: {
      label: "综合收益总额",
      xueqiu: "total_compre_income",
    },
    PARENT_TCI: {
      label: "归母综合收益",
      xueqiu: "total_compre_income_atsopc",
    },
    MINORITY_TCI: {
      label: "少数股东综合收益",
      xueqiu: "total_compre_income_atms",
    },
  },
  "financial.balance": {
    TOTAL_ASSETS: {
      label: "总资产",
      xueqiu: "total_assets",
    },
    TOTAL_LIABILITIES: {
      label: "总负债",
      xueqiu: "total_liab",
    },
    TOTAL_EQUITY: {
      label: "所有者权益合计",
      xueqiu: "total_holders_equity",
    },
    TOTAL_LIAB_EQUITY: {
      label: "负债及所有者权益总计",
      xueqiu: "total_liab_and_holders_equity",
    },
    TOTAL_CURRENT_ASSETS: {
      label: "流动资产合计",
      xueqiu: "total_current_assets",
    },
    TOTAL_NONCURRENT_ASSETS: {
      label: "非流动资产合计",
      xueqiu: "total_noncurrent_assets",
    },
    TOTAL_CURRENT_LIAB: {
      label: "流动负债合计",
      xueqiu: "total_current_liab",
    },
    TOTAL_NONCURRENT_LIAB: {
      label: "非流动负债合计",
      xueqiu: "total_noncurrent_liab",
    },
    MONETARYFUNDS: {
      label: "货币资金",
      xueqiu: "currency_funds",
    },
    TRADE_FINASSET: {
      label: "交易性金融资产（原口径）",
    },
    TRADE_FINASSET_NOTFVTPL: {
      label: "交易性金融资产",
      xueqiu: "tradable_fnncl_assets",
    },
    NOTE_RECE: {
      label: "应收票据",
      xueqiu: "bills_receivable",
    },
    ACCOUNTS_RECE: {
      label: "应收账款",
      xueqiu: "account_receivable",
    },
    NOTE_ACCOUNTS_RECE: {
      label: "应收票据及账款合计",
      xueqiu: "ar_and_br",
    },
    FINANCE_RECE: { label: "应收款项融资" },
    PREPAYMENT: {
      label: "预付款项",
      xueqiu: "pre_payment",
    },
    OTHER_RECE: { label: "其他应收款明细", xueqiu: "othr_receivables" },
    TOTAL_OTHER_RECE: {
      label: "其他应收款合计",
    },
    INVENTORY: { label: "存货", xueqiu: "inventory" },
    CONTRACT_ASSET: {
      label: "合同资产",
      xueqiu: "contractual_assets",
    },
    NONCURRENT_ASSET_1YEAR: {
      label: "一年内到期非流动资产",
      xueqiu: "nca_due_within_one_year",
    },
    OTHER_CURRENT_ASSET: {
      label: "其他流动资产",
      xueqiu: "othr_current_assets",
    },
    LONG_RECE: {
      label: "长期应收款",
      xueqiu: "lt_receivable",
    },
    LONG_EQUITY_INVEST: {
      label: "长期股权投资",
      xueqiu: "lt_equity_invest",
    },
    OTHER_EQUITY_INVEST: {
      label: "其他权益工具投资",
      xueqiu: "other_eq_ins_invest",
    },
    OTHER_NONCURRENT_FINASSET: {
      label: "其他非流动金融资产",
      xueqiu: "other_illiquid_fnncl_assets",
    },
    INVEST_REALESTATE: {
      label: "投资性房地产",
      xueqiu: "invest_property",
    },
    FIXED_ASSET: {
      label: "固定资产合计",
      xueqiu: "fixed_asset_sum",
    },
    FIXED_ASSET_DETAIL: {
      label: "固定资产明细",
      eastmoney: false,
      xueqiu: "fixed_asset",
    },
    CIP: {
      label: "在建工程合计",
      xueqiu: "construction_in_process_sum",
    },
    CIP_DETAIL: {
      label: "在建工程明细",
      eastmoney: false,
      xueqiu: "construction_in_process",
    },
    USERIGHT_ASSET: { label: "使用权资产" },
    INTANGIBLE_ASSET: {
      label: "无形资产",
      xueqiu: "intangible_assets",
    },
    DEVELOP_EXPENSE: {
      label: "开发支出",
      xueqiu: "dev_expenditure",
    },
    GOODWILL: { label: "商誉", xueqiu: "goodwill" },
    LONG_PREPAID_EXPENSE: {
      label: "长期待摊费用",
      xueqiu: "lt_deferred_expense",
    },
    DEFER_TAX_ASSET: {
      label: "递延所得税资产",
      xueqiu: "dt_assets",
    },
    OTHER_NONCURRENT_ASSET: {
      label: "其他非流动资产",
      xueqiu: "othr_noncurrent_assets",
    },
    SHORT_LOAN: {
      label: "短期借款",
      xueqiu: "st_loan",
    },
    LONG_LOAN: { label: "长期借款", xueqiu: "lt_loan" },
    NONCURRENT_LIAB_1YEAR: {
      label: "一年内到期非流动负债",
      xueqiu: "noncurrent_liab_due_in1y",
    },
    BOND_PAYABLE: {
      label: "应付债券",
      xueqiu: "bond_payable",
    },
    LEASE_LIAB: { label: "租赁负债" },
    NOTE_PAYABLE: {
      label: "应付票据",
      xueqiu: "bill_payable",
    },
    ACCOUNTS_PAYABLE: {
      label: "应付账款",
      xueqiu: "accounts_payable",
    },
    NOTE_ACCOUNTS_PAYABLE: {
      label: "应付票据及账款合计",
      xueqiu: "bp_and_ap",
    },
    ADVANCE_RECEIVABLES: {
      label: "预收款项",
      xueqiu: "pre_receivable",
    },
    CONTRACT_LIAB: {
      label: "合同负债",
      xueqiu: "contract_liabilities",
    },
    STAFF_SALARY_PAYABLE: {
      label: "应付职工薪酬",
      xueqiu: "payroll_payable",
    },
    TAX_PAYABLE: {
      label: "应交税费",
      xueqiu: "tax_payable",
    },
    OTHER_PAYABLE: { label: "其他应付款明细" },
    TOTAL_OTHER_PAYABLE: {
      label: "其他应付款合计",
      xueqiu: "othr_payables",
    },
    OTHER_CURRENT_LIAB: {
      label: "其他流动负债",
      xueqiu: "othr_current_liab",
    },
    LONG_PAYABLE: {
      label: "长期应付款明细",
      xueqiu: "lt_payable",
    },
    LONG_PAYABLE_TOTAL: {
      label: "长期应付款合计",
      eastmoney: false,
      xueqiu: "lt_payable_sum",
    },
    PREDICT_LIAB: {
      label: "预计负债",
      xueqiu: "estimated_liab",
    },
    DEFER_INCOME: {
      label: "递延收益",
      xueqiu: "noncurrent_liab_di",
    },
    DEFER_TAX_LIAB: {
      label: "递延所得税负债",
      xueqiu: "dt_liab",
    },
    OTHER_NONCURRENT_LIAB: {
      label: "其他非流动负债",
      xueqiu: "othr_non_current_liab",
    },
    TOTAL_PARENT_EQUITY: {
      label: "归母股东权益",
      xueqiu: "total_quity_atsopc",
    },
    MINORITY_EQUITY: {
      label: "少数股东权益",
      xueqiu: "minority_equity",
    },
    SHARE_CAPITAL: {
      label: "股本",
      xueqiu: "shares",
    },
    CAPITAL_RESERVE: {
      label: "资本公积",
      xueqiu: "capital_reserve",
    },
    SURPLUS_RESERVE: {
      label: "盈余公积",
      xueqiu: "earned_surplus",
    },
    UNASSIGN_RPOFIT: {
      label: "未分配利润",
      xueqiu: "undstrbtd_profit",
    },
    OTHER_COMPRE_INCOME: {
      label: "其他综合收益余额",
      xueqiu: "othr_compre_income",
    },
    TREASURY_SHARES: {
      label: "库存股",
      xueqiu: "treasury_stock",
    },
    DEBT_ASSET_RATIO: {
      label: "资产负债率",
      eastmoney: false,
      xueqiu: "asset_liab_ratio",
      xueqiuScale: 100,
    },
  },
  "financial.cashflow": {
    NETCASH_OPERATE: {
      label: "经营活动现金流量净额",
      xueqiu: "ncf_from_oa",
    },
    NETCASH_INVEST: {
      label: "投资活动现金流量净额",
      xueqiu: "ncf_from_ia",
    },
    NETCASH_FINANCE: {
      label: "筹资活动现金流量净额",
      xueqiu: "ncf_from_fa",
    },
    SALES_SERVICES: {
      label: "销售商品提供劳务收到现金",
      xueqiu: "cash_received_of_sales_service",
    },
    RECEIVE_TAX_REFUND: {
      label: "收到税费返还",
      xueqiu: "refund_of_tax_and_levies",
    },
    RECEIVE_OTHER_OPERATE: {
      label: "收到其他经营现金",
      xueqiu: "cash_received_of_othr_oa",
    },
    TOTAL_OPERATE_INFLOW: {
      label: "经营现金流入合计",
      xueqiu: "sub_total_of_ci_from_oa",
    },
    BUY_SERVICES: {
      label: "购买商品接受劳务支付现金",
      xueqiu: "goods_buy_and_service_cash_pay",
    },
    PAY_STAFF_CASH: {
      label: "支付职工现金",
      xueqiu: "cash_paid_to_employee_etc",
    },
    PAY_ALL_TAX: {
      label: "支付各项税费",
      xueqiu: "payments_of_all_taxes",
    },
    PAY_OTHER_OPERATE: {
      label: "支付其他经营现金",
      xueqiu: "othrcash_paid_relating_to_oa",
    },
    TOTAL_OPERATE_OUTFLOW: {
      label: "经营现金流出合计",
      xueqiu: "sub_total_of_cos_from_oa",
    },
    WITHDRAW_INVEST: {
      label: "收回投资收到现金",
      xueqiu: "cash_received_of_dspsl_invest",
    },
    RECEIVE_INVEST_INCOME: {
      label: "取得投资收益收到现金",
      xueqiu: "invest_income_cash_received",
    },
    DISPOSAL_LONG_ASSET: {
      label: "处置长期资产收到现金净额",
      xueqiu: "net_cash_of_disposal_assets",
    },
    DISPOSAL_SUBSIDIARY_OTHER: {
      label: "处置子公司收到现金净额",
      xueqiu: "net_cash_of_disposal_branch",
    },
    RECEIVE_OTHER_INVEST: {
      label: "收到其他投资现金",
      xueqiu: "cash_received_of_othr_ia",
    },
    TOTAL_INVEST_INFLOW: {
      label: "投资现金流入合计",
      xueqiu: "sub_total_of_ci_from_ia",
    },
    CONSTRUCT_LONG_ASSET: {
      label: "购建长期资产支付现金",
      xueqiu: "cash_paid_for_assets",
    },
    INVEST_PAY_CASH: {
      label: "投资支付现金",
      xueqiu: "invest_paid_cash",
    },
    OBTAIN_SUBSIDIARY_OTHER: {
      label: "取得子公司支付现金净额",
      xueqiu: "net_cash_amt_from_branch",
    },
    PAY_OTHER_INVEST: {
      label: "支付其他投资现金",
      xueqiu: "othrcash_paid_relating_to_ia",
    },
    TOTAL_INVEST_OUTFLOW: {
      label: "投资现金流出合计",
      xueqiu: "sub_total_of_cos_from_ia",
    },
    ACCEPT_INVEST_CASH: {
      label: "吸收投资收到现金",
      xueqiu: "cash_received_of_absorb_invest",
    },
    SUBSIDIARY_ACCEPT_INVEST: {
      label: "子公司吸收少数股东投资收到现金",
      xueqiu: "cash_received_from_investor",
    },
    RECEIVE_LOAN_CASH: {
      label: "取得借款收到现金",
      xueqiu: "cash_received_of_borrowing",
    },
    ISSUE_BOND: {
      label: "发行债券收到现金",
      xueqiu: "cash_received_from_bond_issue",
    },
    RECEIVE_OTHER_FINANCE: {
      label: "收到其他筹资现金",
      xueqiu: "cash_received_of_othr_fa",
    },
    TOTAL_FINANCE_INFLOW: {
      label: "筹资现金流入合计",
      xueqiu: "sub_total_of_ci_from_fa",
    },
    PAY_DEBT_CASH: {
      label: "偿还债务支付现金",
      xueqiu: "cash_pay_for_debt",
    },
    ASSIGN_DIVIDEND_PORFIT: {
      label: "分配股利利润或偿付利息支付现金",
      xueqiu: "cash_paid_of_distribution",
    },
    SUBSIDIARY_PAY_DIVIDEND: {
      label: "子公司支付少数股东股利利润",
      xueqiu: "branch_paid_to_minority_holder",
    },
    PAY_OTHER_FINANCE: {
      label: "支付其他筹资现金",
      xueqiu: "othrcash_paid_relating_to_fa",
    },
    TOTAL_FINANCE_OUTFLOW: {
      label: "筹资现金流出合计",
      xueqiu: "sub_total_of_cos_from_fa",
    },
    RATE_CHANGE_EFFECT: {
      label: "汇率变动对现金等价物影响",
      xueqiu: "effect_of_exchange_chg_on_cce",
    },
    CCE_ADD: {
      label: "现金及现金等价物净增加额",
      xueqiu: "net_increase_in_cce",
    },
    BEGIN_CCE: {
      label: "期初现金及现金等价物余额",
      xueqiu: "initial_balance_of_cce",
    },
    END_CCE: {
      label: "期末现金及现金等价物余额",
      xueqiu: "final_balance_of_cce",
    },
    NETPROFIT: { label: "补充法净利润" },
    ASSET_IMPAIRMENT: {
      label: "补充法资产减值准备",
    },
    FA_IR_DEPR: {
      label: "固定资产、油气、生物资产及投资性房地产折旧合计",
    },
    OILGAS_BIOLOGY_DEPR: {
      label: "其中：固定资产、油气及生物资产折旧",
    },
    IR_DEPR: { label: "其中：投资性房地产折旧" },
    IA_AMORTIZE: { label: "无形资产摊销" },
    LPE_AMORTIZE: { label: "长期待摊费用摊销" },
    USERIGHT_ASSET_AMORTIZE: {
      label: "使用权资产折旧摊销",
    },
    DISPOSAL_LONGASSET_LOSS: {
      label: "补充法处置长期资产损失",
    },
    FA_SCRAP_LOSS: { label: "固定资产报废损失" },
    FAIRVALUE_CHANGE_LOSS: {
      label: "补充法公允价值变动损失",
    },
    FINANCE_EXPENSE: { label: "补充法财务费用" },
    INVEST_LOSS: { label: "补充法投资损失" },
    DT_ASSET_REDUCE: {
      label: "递延所得税资产减少",
    },
    DT_LIAB_ADD: { label: "递延所得税负债增加" },
    INVENTORY_REDUCE: { label: "存货减少" },
    OPERATE_RECE_REDUCE: {
      label: "经营性应收项目减少",
    },
    OPERATE_PAYABLE_ADD: {
      label: "经营性应付项目增加",
    },
    NETCASH_OPERATENOTE: {
      label: "补充法经营现金流量净额",
    },
    END_CASH: { label: "期末现金余额" },
    BEGIN_CASH: { label: "期初现金余额" },
    END_CASH_EQUIVALENTS: {
      label: "期末现金等价物余额",
    },
    BEGIN_CASH_EQUIVALENTS: {
      label: "期初现金等价物余额",
    },
  },
};

export function statementColumns(id: string): Record<string, CollectionColumn> {
  return Object.fromEntries(
    Object.entries(STATEMENT_FIELDS[id]!).map(([key, field]) => [
      key,
      {
        label: field.label,
        unit: key === "DEBT_ASSET_RATIO" ? "percent" : "CNY",
      },
    ]),
  );
}

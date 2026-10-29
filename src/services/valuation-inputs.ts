import {
  validateJsonSchemaValue,
  type JsonSchemaNode,
} from "@deepseek-ai/dsh-tools";
import {
  AMOUNT_SCALES,
  type ValuationMethodId,
  type ValuationRequest,
} from "../contracts/valuation.js";
import { ResearchError } from "../contracts/errors.js";
const stringSchema = { type: "string" } as const;
function objectSchema(
  properties: Record<string, JsonSchemaNode>,
): JsonSchemaNode {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const number = { type: "number" } as const;
const array = (items: JsonSchemaNode): JsonSchemaNode => ({
  type: "array",
  items,
});
const date = {
  type: "string",
  description: "严格YYYY-MM-DD真实日期；估值代码按ACT/365F处理日期。",
} as const;
const flow = {
  type: "number",
  description:
    "整个预测期间的总额，非估值日后的剩余额；代码按天数裁切；Gordon以末期流量除以整期ACT/365F年数年化。",
} as const;
const balance = {
  type: "number",
  description: "期间末余额，代码根据前期余额计算变动。",
} as const;
const forecastStartDate = {
  ...date,
  description:
    "首个期间起点，不晚于估值日；每期起点为前一期endDate，期间流量均匀发生。",
};
const openingBalance = {
  type: "number",
  description: "forecastStartDate时点的期初余额。",
} as const;
const ratio = {
  type: "number",
  description: "比例使用小数，如13%填写0.13；Agent明确预测假设。",
} as const;
const bridge = objectSchema({
  excessCash: {
    type: "number",
    description: "独立列示超额现金，不含在其他非经营资产中；与债务分别桥接。",
  },
  nonOperatingAssets: {
    type: "number",
    description: "超额现金以外的非经营资产。",
  },
  debt: number,
  preferredEquity: number,
  minorityInterest: number,
  otherClaims: number,
});
const operating = objectSchema({
  endDate: date,
  revenue: flow,
  operatingMargin: {
    ...ratio,
    description:
      "息税前经营利润率(EBIT/收入)，不直接等同中国报表营业利润率；以小数填写有依据的预测。",
  },
  taxRate: ratio,
  depreciation: flow,
  capex: flow,
  workingCapital: balance,
});
const equity = objectSchema({
  endDate: date,
  netIncome: flow,
  depreciation: flow,
  capex: flow,
  workingCapital: balance,
  newDebt: flow,
  debtRepaid: flow,
});
const terminal = (
  parameters: Record<string, JsonSchemaNode> = {},
): JsonSchemaNode => ({
  oneOf: [
    objectSchema({
      kind: { type: "string", const: "finite" },
      recovery: {
        type: "number",
        description:
          "最后预测日实际回收总额；RI代码扣除已纳入价值的期末账面权益。",
      },
    }),
    objectSchema({
      kind: { type: "string", const: "gordon" },
      growthRate: ratio,
      ...parameters,
    }),
  ],
});
const capm = objectSchema({
  kind: { type: "string", const: "capm" },
  riskFreeRate: ratio,
  equityRiskPremium: ratio,
  beta: number,
  countryRiskPremium: ratio,
});
const equityCost: JsonSchemaNode = { oneOf: [number, capm] };
const boundedRatio = { ...ratio, minimum: 0, maximum: 1 };
const discountRate: JsonSchemaNode = {
  oneOf: [
    number,
    capm,
    objectSchema({
      kind: { type: "string", const: "wacc" },
      costOfEquity: equityCost,
      preTaxCostOfDebt: ratio,
      taxRate: boundedRatio,
      debtWeight: boundedRatio,
    }),
  ],
  description:
    "直接估计数值或明确CAPM/WACC分量；代码合成折现率，不填默认市场参数。",
};
const operatingInputs = {
  forecastStartDate,
  openingWorkingCapital: openingBalance,
  periods: array(operating),
};
export const VALUATION_INPUT_SCHEMAS: Record<
  ValuationMethodId,
  JsonSchemaNode
> = {
  fcff_dcf: objectSchema({
    ...operatingInputs,
    discountRate,
    terminal: terminal({ returnOnCapital: ratio }),
    bridge,
  }),
  fcfe_dcf: objectSchema({
    forecastStartDate,
    openingWorkingCapital: openingBalance,
    periods: array(equity),
    discountRate,
    terminal: terminal({ returnOnEquity: ratio }),
  }),
  dividend_discount: objectSchema({
    forecastStartDate,
    periods: array(objectSchema({ endDate: date, dividend: flow })),
    discountRate,
    terminal: terminal(),
  }),
  regulatory_capital_fcfe: objectSchema({
    forecastStartDate,
    openingRequiredCapital: openingBalance,
    periods: array(
      objectSchema({
        endDate: date,
        netIncome: flow,
        requiredCapital: balance,
      }),
    ),
    discountRate,
    terminal: terminal(),
  }),
  residual_income: objectSchema({
    forecastStartDate,
    openingBookEquity: openingBalance,
    periods: array(
      objectSchema({
        endDate: date,
        netIncome: flow,
        payoutRatio: ratio,
        netIssuance: flow,
        otherEquityChanges: {
          ...flow,
          description:
            "非股东OCI等综合收益调整，同时计入综合收益与账面权益；不含净发行。",
        },
      }),
    ),
    discountRate,
    terminal: terminal({ returnOnEquity: ratio }),
  }),
  adjusted_present_value: objectSchema({
    ...operatingInputs,
    unleveredRate: discountRate,
    terminal: terminal({ returnOnCapital: ratio }),
    financingEffects: array(
      objectSchema({
        taxShield: flow,
        financingCost: flow,
        distressCost: flow,
        discountRate,
      }),
    ),
    terminalFinancing: {
      oneOf: [
        objectSchema({
          kind: { type: "string", const: "finite" },
          amount: {
            type: "number",
            description: "最后预测日发生的净融资金额，可为负数；代码折现。",
          },
          discountRate,
        }),
        objectSchema({
          kind: { type: "string", const: "gordon" },
          nextCashFlow: {
            type: "number",
            description:
              "最后预测日之后下一完整年度融资净现金流，可为负数；代码计算终值和现值。",
          },
          growthRate: ratio,
          discountRate,
        }),
      ],
    },
    bridge,
  }),
  comparable_multiples: {
    oneOf: [
      ...(
        [
          ["pe", "netIncome"],
          ["pb", "bookEquity"],
          ["ps", "revenue"],
          ["pcf", "operatingCashFlow"],
        ] as const
      ).map(([kind, metric]) =>
        objectSchema({
          multipleType: { type: "string", const: kind },
          [metric]: number,
          multiples: array(number),
        }),
      ),
      ...(
        [
          ["ev_ebitda", "ebitda"],
          ["ev_revenue", "revenue"],
        ] as const
      ).map(([kind, metric]) =>
        objectSchema({
          multipleType: { type: "string", const: kind },
          [metric]: number,
          multiples: array(number),
          bridge,
        }),
      ),
    ],
  },
  adjusted_net_assets: objectSchema({
    assets: array(
      objectSchema({
        label: stringSchema,
        fairValue: number,
        ownership: number,
      }),
    ),
    liabilities: number,
    priorityClaims: number,
    disposalCosts: number,
  }),
  scenario_dcf_rnpv: {
    oneOf: [
      objectSchema({
        kind: { type: "string", const: "scenarios" },
        scenarios: array(
          objectSchema({
            label: stringSchema,
            probability: number,
            calculationId: stringSchema,
          }),
        ),
      }),
      objectSchema({
        kind: { type: "string", const: "project" },
        initialCashFlow: {
          type: "number",
          description: "forecastStartDate时点现金流，后续估值日将其排除。",
        },
        forecastStartDate: date,
        periods: array(
          objectSchema({ endDate: date, cashFlow: flow, probability: number }),
        ),
        discountRate,
        bridge,
      }),
    ],
  },
  sum_of_parts: objectSchema({
    parts: array(
      objectSchema({
        label: stringSchema,
        ownership: number,
        calculationId: stringSchema,
      }),
    ),
    groupAssets: number,
    groupLiabilities: number,
    headOffice: {
      oneOf: [
        objectSchema({ kind: { type: "string", const: "none" } }),
        objectSchema({
          kind: { type: "string", const: "forecast" },
          forecastStartDate,
          periods: array(objectSchema({ endDate: date, cost: flow })),
          discountRate,
          terminal: terminal({}),
        }),
      ],
      description: "明确无总部费用，或提供原始费用预测由代码计算现值。",
    },
  }),
  real_options: objectSchema({
    rootNode: stringSchema,
    probabilityMeasure: {
      type: "string",
      enum: ["risk_neutral", "risk_adjusted"],
    },
    nodes: array(
      objectSchema({
        id: stringSchema,
        year: number,
        exerciseValue: { oneOf: [number, { type: "null" }] },
        abandonmentValue: { oneOf: [number, { type: "null" }] },
        continuationCost: number,
        discountRate,
        transitions: array(
          objectSchema({ nodeId: stringSchema, probability: number }),
        ),
      }),
    ),
    bridge,
  }),
};
const fields = {
  methodId: {
    type: "string",
    enum: Object.keys(VALUATION_INPUT_SCHEMAS),
  } as JsonSchemaNode,
  purpose: {
    type: "string",
    enum: ["valuation", "target_price"],
    description:
      "valuation计算研究日价值，target_price计算六个月目标日期价值；日期由运行确定。",
  } as JsonSchemaNode,
  amountUnit: {
    type: "string",
    enum: Object.keys(AMOUNT_SCALES),
    description:
      "所有金额输入的数量级：unit=1、thousand=千、million=百万、hundred_million=亿；币种继承运行，计算结果统一为基础货币单位。",
  } as JsonSchemaNode,
  shares: objectSchema({
    value: number,
    unit: {
      type: "string",
      enum: Object.keys(AMOUNT_SCALES),
      description: "股数独立声明数量级，与金额单位无关。",
    },
  }),
  inputs: { oneOf: Object.values(VALUATION_INPUT_SCHEMAS) } as JsonSchemaNode,
  assumptions: array({
    type: "string",
    description:
      "适用条件及预测假设，包括终值、资本需要、目标日分红/融资/股数和定价情景的依据；目录不提供默认参数。",
  }),
  provenance: array(
    objectSchema({
      path: {
        type: "string",
        description:
          "以/inputs或/shares开头的JSON Pointer；可指向一组同源输入，如/inputs/periods。",
      },
      kind: { type: "string", enum: ["observed", "normalized", "assumed"] },
      basis: {
        type: "string",
        description: "快照表/字段/日期、原报告定位，或正常化和预测的推导依据。",
      },
    }),
  ),
  sensitivities: array(
    objectSchema({
      label: stringSchema,
      path: {
        type: "string",
        description:
          "替换一个现有数值参数的JSON Pointer，以/inputs或/shares开头。",
      },
      value: number,
      basis: stringSchema,
    }),
  ),
};
export const valuationCalculationParameters = objectSchema(fields);

function invalid(message: string): never {
  throw new ResearchError("INVALID_INPUT", `valuation: ${message}`);
}
export function valuationInputAt(value: unknown, path: string): unknown {
  if (!/^\/(inputs|shares)(?:\/|$)/.test(path))
    invalid(`Invalid input path ${path}.`);
  let current = value;
  for (const key of path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      invalid(`Unknown input path ${path}.`);
    current = Reflect.get(current, key);
  }
  return current;
}
function validateLeaves(
  value: unknown,
  path: string,
  numericPaths: string[],
): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must be finite.`);
    numericPaths.push(path);
  } else if (typeof value === "string") {
    if (!value.trim()) invalid(`${path} requires nonempty text.`);
  } else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      validateLeaves(item, `${path}/${key}`, numericPaths);
}
export function parseValuationRequest(value: unknown): ValuationRequest {
  const methodId =
    value !== null && typeof value === "object"
      ? (Reflect.get(value, "methodId") as unknown)
      : undefined;
  if (
    typeof methodId !== "string" ||
    !Object.hasOwn(VALUATION_INPUT_SCHEMAS, methodId)
  )
    invalid("Select a supported methodId.");
  const errors = validateJsonSchemaValue(
    objectSchema({
      ...fields,
      methodId: { type: "string", const: methodId },
      inputs: VALUATION_INPUT_SCHEMAS[methodId as ValuationMethodId]!,
    }),
    value,
    "valuation",
  );
  if (errors.length) invalid(errors.join("\n"));
  const paths: string[] = [];
  validateLeaves(value, "", paths);
  const request = value as ValuationRequest;
  if (request.assumptions.length === 0)
    invalid("Record the model assumptions explicitly.");
  for (const item of request.provenance) valuationInputAt(request, item.path);
  for (const path of paths.filter((path) => /^\/(inputs|shares)\//.test(path)))
    if (
      !request.provenance.some(
        (entry) => path === entry.path || path.startsWith(`${entry.path}/`),
      )
    )
      invalid(`Missing input provenance for ${path}.`);
  for (const scenario of request.sensitivities)
    if (typeof valuationInputAt(request, scenario.path) !== "number")
      invalid(
        `Sensitivity ${scenario.path} must select an existing numeric input.`,
      );
  return structuredClone(request);
}
export function sensitivityRequest(
  request: ValuationRequest,
  path: string,
  value: number,
): ValuationRequest {
  const result = structuredClone(request);
  const keys = path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target: object = result;
  for (const key of keys.slice(0, -1))
    target = Reflect.get(target, key) as object;
  Reflect.set(target, keys.at(-1)!, value);
  return parseValuationRequest(result);
}

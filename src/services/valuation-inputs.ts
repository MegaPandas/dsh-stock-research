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
  description:
    "Valid calendar date in YYYY-MM-DD format; calculations use ACT/365F.",
} as const;
const flow = {
  type: "number",
  description:
    "Full forecast-period total. Code prorates the remaining portion by days; Gordon annualizes the final flow by dividing by the full period's ACT/365F years.",
} as const;
const balance = {
  type: "number",
  description:
    "Period-end balance; code computes changes from the previous balance.",
} as const;
const forecastStartDate = {
  ...date,
  description:
    "Start of the first period, on or before the valuation date. Each later period starts at the previous endDate; flows accrue uniformly within periods.",
};
const openingBalance = {
  type: "number",
  description: "Opening balance at forecastStartDate.",
} as const;
const ratio = {
  type: "number",
  description:
    "Decimal ratio, e.g. 0.13 for 13%; state the forecast assumption.",
} as const;
const bridge = objectSchema({
  excessCash: {
    type: "number",
    description:
      "Excess cash, excluded from other non-operating assets and bridged separately from debt.",
  },
  nonOperatingAssets: {
    type: "number",
    description: "Non-operating assets excluding excess cash.",
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
      "EBIT/revenue, which can differ from operating profit margin in Chinese statements. Provide a supported forecast as a decimal.",
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
          "Total recovery at the final forecast date; residual-income calculations subtract closing book equity already included in value.",
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
    "Explicit estimate or CAPM/WACC components from which code computes the rate. Supply supported market inputs.",
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
            "Non-owner comprehensive-income adjustments such as OCI, included in both comprehensive income and book equity; exclude net issuance.",
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
            description:
              "Net financing amount at the final forecast date, possibly negative; code discounts it.",
          },
          discountRate,
        }),
        objectSchema({
          kind: { type: "string", const: "gordon" },
          nextCashFlow: {
            type: "number",
            description:
              "Net financing cash flow for the full year after the final forecast date, possibly negative; code computes terminal and present values.",
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
          description:
            "Cash flow at forecastStartDate; excluded when valuing at a later date.",
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
      description:
        "Declare no head-office costs, or supply cost forecasts for code to discount.",
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
      "valuation computes research-date value; target_price computes value at the six-month target date. Dates come from the run.",
  } as JsonSchemaNode,
  amountUnit: {
    type: "string",
    enum: Object.keys(AMOUNT_SCALES),
    description:
      "Scale for all monetary inputs: unit=1, thousand=1000, million=1000000, hundred_million=100000000. Currency comes from the run; results use base currency units.",
  } as JsonSchemaNode,
  shares: objectSchema({
    value: number,
    unit: {
      type: "string",
      enum: Object.keys(AMOUNT_SCALES),
      description: "Share-count scale, independent of the monetary scale.",
    },
  }),
  inputs: {
    type: "object",
    additionalProperties: true,
    description:
      "Inputs matching methodId. Read calculationInputSchema with stock_read_valuation_method for the method's required fields.",
  } as JsonSchemaNode,
  assumptions: array({
    type: "string",
    description:
      "Applicability and forecast assumptions, including rationale for terminal value, capital needs, target-date dividends, financing, share count and pricing scenarios.",
  }),
  provenance: array(
    objectSchema({
      path: {
        type: "string",
        description:
          "JSON Pointer starting with /inputs or /shares; may address inputs sharing a source, e.g. /inputs/periods.",
      },
      kind: { type: "string", enum: ["observed", "normalized", "assumed"] },
      basis: {
        type: "string",
        description:
          "Snapshot table/field/date, original report location, or derivation for normalized values and forecasts.",
      },
    }),
  ),
  sensitivities: array(
    objectSchema({
      label: stringSchema,
      path: {
        type: "string",
        description:
          "JSON Pointer to an existing numeric parameter to replace, starting with /inputs or /shares.",
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

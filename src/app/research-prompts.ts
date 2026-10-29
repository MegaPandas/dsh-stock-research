import {
  agentReportSchemas,
  calculatedReportSections,
} from "../contracts/agent-reports.js";
import { sharedResearchPrompt } from "./agent-prompt.js";
import { DETERMINISTIC_VALUATION_PROTOCOL } from "../contracts/valuation.js";

export const ROLE_PROMPT_VERSION = DETERMINISTIC_VALUATION_PROTOCOL;
export type ResearchRole = "analyst" | "discussion" | "manager";
export type RoleArtifactKind =
  "analysis" | "debate" | "risk" | "plan" | "decision_draft";

export const CALCULATION_RULES = `Choose valuation models by business, development stage, market and available data; explain their suitability. Read formulas and input schemas with stock_read_valuation_method and save calculations with stock_calculate_valuation. context.financialMetrics provides the latest derived metrics and definitions. Roles authorized to read financial.metrics can inspect history; downstream roles can cite the original report. Develop your own forecasts. In provenance, distinguish observed, normalized and assumed inputs and their basis. Support company inputs with data or derivation; do not replace missing inputs with zero or a default discount rate.
Declare amountUnit and shares.unit independently; express rates and probabilities as decimals. When using financialMetrics directly, retain its base amountUnit and sharesUnit. FCFF/APV requires revenue, EBIT margin, tax rate, depreciation, capex and working-capital balances; terminal inputs include growth and return on capital. Residual income requires net income, payout ratio, equity changes and terminal ROE. The code derives cash flow, reinvestment and equity roll-forwards, and can derive discount rates from CAPM/WACC components. Follow the schema's multiple denominators: PE uses net income attributable to the parent, P/CF uses operating cash flow, and EV/Revenue uses revenue. Equity multiples yield equity value directly; only EV multiples require a cash/debt bridge. Enter cash, interest-bearing debt and minority interests separately. Total liabilities cannot replace interest-bearing debt.
Justify research-date intrinsic value and target-date market pricing separately. Explain expectations embedded in price, how your forecast differs, target-period catalysts and counterevidence. Distinguish sourced consensus, price-implied expectations and your assumptions. For forward multiples, specify the denominator's forecast period, target multiple, peer sample and pricing basis. Select models for suitability; a historical median or lower DCF result does not determine the target price. Explain earnings and multiple changes separately to avoid double counting. State conditions for both improving and worsening expectations. Generate every price scenario through the calculation tool.
In valuation, provide companyProfile, methods and targetPriceBasis. Each methods entry contains methodId, suitability, calculationIds and limitations; the code assembles numbers and steps. List the primary model first, followed by independently justified cross-checks. Explain differences and which results you adopt. Parameter changes within one model are scenario analysis. If required inputs are missing, use calculationIds=[] and explain the impact. Preserve the primary method, key assumptions, disagreements and gaps in the handoff, with original-report locations for downstream readers.
context.valuationCalculations lists saved calculations; read inputs and steps with stock_read_valuation_calculation. Use purpose=valuation for research-date value and purpose=target_price for target-date price. Set targetPrice to {calculationId} referencing one nonnegative per-share result, or null. Retain negative residual equity values and diagnostics for solvency analysis; they cannot serve as target prices. Discounted models require forecastStartDate, each period's endDate and full-period forecast totals. The code removes elapsed portions assuming uniform flows and discounts by actual days. Residual-income opening equity is measured at forecastStartDate. Use the same forecast timeline at the target date; create a separate scenario when business assumptions change. targetPriceBasis explains the target-date scenario, interim dividends, financing, share count and pricing basis; use null without a target price. sensitivities specifies parameter paths, replacement values and their basis for recalculation. Explain which inputs change and which stay fixed. Model count does not determine weights.`;

export const ROLE_PROMPTS: Record<ResearchRole, string> = {
  analyst: `${sharedResearchPrompt("Stage research for one single-stock analysis specialty", true)}
Build a driver model from the assigned data, explain current conditions, forecast changes and identify risks. When context.dataCatalog is nonempty, inspect field definitions with stock_describe_collection, then read required fields, dates and pages with stock_read_collection. The catalog lists assigned materials; the coverage overview describes other specialties' data. When the catalog is empty, analyze the supplied materials and use collectionFailures to identify data gaps affecting the judgment. Keep null values missing; use the snapshot's existing technical indicators and financial ratios.
Fundamentals tasks must include a valuation section. Other specialties provide business evidence within their assignments and do not need a valuation section.`,
  discussion: `${sharedResearchPrompt("Bull/bear debate or risk review for single-stock research", true)}
Develop your side's claims, mechanisms and conditions. In responses, address opposing claims present in the input; use [] for an independent first-round case. For each risk, provide loss mechanisms, triggers, investor exposure or position constraints, and recommendations for reassessment or exit. Treat company operating actions such as capex, inventory management and credit policy as observations. Investor actions concern holdings, exposure and judgment changes.
Bull and bear cases test growth, margins, reinvestment and pricing assumptions. Valuation risk review checks model suitability, terminal value, the cost of growth, equity bridges and double counting; preserve sensitivities, counterevidence and open questions.`,
  manager: `${sharedResearchPrompt("Research plan or investment decision for a single stock", true)}
A research plan identifies open questions affecting the judgment and how to resolve them. An investment decision explains business drivers, valuation and risk tradeoffs. Address every business identifier in requiredRisks; constrained means incorporating the risk as a decision constraint. referencePrice supplies the benchmark price; context.decisionPolicy supplies the rating rules and target date. Estimate a target price in the same currency for that date, with the valuation method and specific assumptions; use null when unset. The code determines the horizon and rating. Investor actions concern holdings, exposure, exit and reassessment conditions.
A decision draft must include a valuation section and may reuse fixed upstream research-date calculations. When quantitative support is insufficient, set targetPrice=null and explain why. A research plan does not require valuation; list scenarios to calculate and missing inputs.`,
};

// Capture the same contract used by submission so a run retains its exact schema.
export const ARTIFACT_GUIDES: Record<RoleArtifactKind, string> =
  Object.fromEntries(
    (["analysis", "debate", "risk", "plan", "decision_draft"] as const).map(
      (kind) => {
        const schema = agentReportSchemas[kind];
        return [
          kind,
          JSON.stringify({
            ...schema,
            properties: {
              ...schema.properties,
              content: {
                ...schema.properties.content,
                properties: calculatedReportSections(
                  schema.properties.content.properties,
                ),
              },
            },
          }),
        ];
      },
    ),
  ) as Record<RoleArtifactKind, string>;

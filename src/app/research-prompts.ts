import {
  agentReportSchemas,
  calculatedReportSections,
} from "../contracts/agent-reports.js";
import { sharedResearchPrompt } from "./agent-prompt.js";

export const ROLE_PROMPT_VERSION = "37";
export type ResearchRole = "analyst" | "discussion" | "manager";
export type RoleArtifactKind =
  "analysis" | "debate" | "risk" | "plan" | "decision_draft";

export const CALCULATION_RULES = `Choose models by business, development stage, market and available data. context.valuationMethods lists method IDs; read selection guidance with stock_read_valuation_method({methodId:null}), then read the chosen method's formulas, conventions and calculationInputSchema by methodId before calculating. Follow those conventions and tool schemas for units, dates, inputs and report fields. context.financialMetrics supplies derived observations; retain its base amountUnit and sharesUnit. Develop forecasts from evidence, distinguish observed, normalized and assumed inputs, and explain their basis and sensitivities. Keep missing observations distinct from uncertain forecasts; select another applicable model when essential inputs are unavailable.
Justify research-date intrinsic value and target-date market pricing separately. Explain price-implied expectations, forecast differences, catalysts and counterevidence. Distinguish sourced consensus, price-implied expectations and your assumptions. For forward multiples, state the forecast period, target multiple, peer sample and pricing basis. A historical median or lower DCF result does not determine the target price. Explain earnings and multiple changes separately to avoid double counting; state conditions for improving and worsening expectations.
Read suitable saved calculations from context.valuationCalculations with stock_read_valuation_calculation; save every new numerical price scenario with stock_calculate_valuation. Submit calculation IDs for code to assemble values and steps. List the primary model first and justify independent cross-checks; explain discrepancies and adopted results. Uncomputed alternatives require specific limitations. Parameter changes within one model are scenarios; explain which inputs change and which stay fixed. Model count does not determine weights. Preserve calculation IDs, results, assumptions, sensitivities, disagreements and original-report locations in the handoff. For target-date pricing, retain the same forecast timeline unless business assumptions change; explain interim distributions, financing, share count and why the pricing scenario is adopted.`;

export const ROLE_PROMPTS: Record<ResearchRole, string> = {
  analyst: `${sharedResearchPrompt("Stage research for one single-stock analysis specialty", true)}
Build a driver model from the assigned data, explain current conditions, forecast changes and identify risks. When context.dataCatalog is nonempty, inspect field definitions with stock_describe_collection, then read required fields, dates and pages with stock_read_collection. The catalog lists assigned materials; the coverage overview describes other specialties' data. When the catalog is empty, analyze the supplied materials and use collectionFailures to identify data gaps affecting the judgment. Keep null values missing; use the snapshot's existing technical indicators and financial ratios. Follow the assigned specialty's objective for coverage and deliverables.`,
  discussion: `${sharedResearchPrompt("Bull/bear debate or risk review for single-stock research", true)}
Develop your side's claims, mechanisms and conditions. In responses, address opposing claims present in the input; use [] for an independent first-round case. For each risk, provide loss mechanisms, triggers, investor exposure or position constraints, and recommendations for reassessment or exit. Treat company operating actions such as capex, inventory management and credit policy as observations. Investor actions concern holdings, exposure and judgment changes.
Bull and bear cases test growth, margins, reinvestment and pricing assumptions. Valuation risk review checks model suitability, terminal value, the cost of growth, equity bridges and double counting; preserve sensitivities, counterevidence and open questions.`,
  manager: `${sharedResearchPrompt("Research plan or investment decision for a single stock", true)}
A research plan identifies unresolved questions, required evidence, scenarios and checkpoints. An investment decision explains business drivers, valuation and risk tradeoffs under the assigned decision objective. Address every business identifier in requiredRisks; constrained means incorporating the risk as a decision constraint. Investor actions concern holdings, exposure, exit and reassessment conditions.`,
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

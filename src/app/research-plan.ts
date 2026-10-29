import { createRequire } from "node:module";
import type { OpenRunInput, RunVersions } from "../contracts/runs.js";
import type { RunDefinition, TaskDefinition } from "../contracts/workflow.js";
import type { SourceDescription } from "../services/query-sources.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import { DIGEST_PROMPT_VERSION } from "../host/digest-model.js";
import type { SourceCodeVersions } from "../data/versions.js";
import {
  APPLICATION_INPUT_NAME,
  captureApplicationInput,
} from "./research-input.js";
import { ROLE_PROMPT_VERSION } from "./research-prompts.js";
import { VALUATION_ENGINE_VERSION } from "../contracts/valuation.js";
import {
  VALUATION_METHODS,
  VALUATION_METHODS_INPUT,
} from "./valuation-methods.js";
import {
  PUBLIC_ANALYST_PROMPT,
  PUBLIC_RESEARCH_BRIEF,
  PUBLIC_RESEARCH_PROMPT_INPUT,
  PUBLIC_RESEARCH_TASK,
  PUBLIC_SEARCH_LIMITS,
} from "./public-research.js";
import {
  COORDINATOR_PROMPT,
  COORDINATOR_PROMPT_VERSION,
} from "./coordinator-prompt.js";
import {
  captureQuickSnapshots,
  QUICK_SNAPSHOTS_INPUT,
  type QuickQuerySnapshot,
} from "./quick-snapshots.js";

const PLUGIN_VERSION = (
  createRequire(import.meta.url)(
    "@megapandas/dsh-stock-research/package.json",
  ) as {
    version: string;
  }
).version;

export const DIGEST_RISK_RULE =
  "riskSummaries must cover each issueId in context.requiredRisks exactly once; return [] when that list is empty. Analyst-stage risks have no risk-review issueId; do not invent identifiers. Preserve their meaning, handoff questions and upstream attribution in keyPoints or openQuestions.";

export const SHARED_BRIEFS = {
  "analysis.public": PUBLIC_RESEARCH_BRIEF,
  "analysis.market":
    "Produce a market-analysis stage memo from fixed snapshots. Read the latest 60 daily, 52 weekly and 36 monthly stock bars and source-provided moving averages from the collection catalog. Explain trends, price/volume and relative strength using source-provided bars and indicators. For A-shares, compare matching daily/weekly/monthly series for the Shanghai Composite, Shenzhen Component, CSI 300 and ChiNext. Use price structure and volume to define base and alternative paths over an explicit horizon, with confirmation/counterevidence signals and price, volume and relative-strength conditions. Explain possible changes in market expectations and alternative interpretations; price/volume inferences are not observed consensus. Fundamentals and public-information specialties supply business drivers; macro supplies rate, FX, gold and dollar-index transmission. For US stocks, use cataloged data. Use close from the latest completed daily bar; explain prices by period completion and adjustment basis.",
  "analysis.fundamentals":
    "Produce a fundamentals stage memo from fixed snapshots. For A-shares, read key financial metrics, single-quarter data and three-statement summaries for the latest 12 reporting periods, plus source-provided historical PE, PB and other metrics. Explain how revenue, costs, expenses, profit, working capital and capex affect cash flow and financial capacity. Build earnings and cash-flow driver models with product, regional or expense-mix assumptions. Forecast operations, earnings, cash flow and valuation for subsequent reporting periods; identify questions about durability, operating leverage and financial risk. Explain long-term intrinsic value and target-date market pricing separately, including forecast differences from available market expectations and the basis for earnings realization and multiple changes. Use historical valuations as references without assuming mean reversion. Public-information research supplies product and competitive events. Distinguish consolidated/parent-attributable figures, cumulative/single-quarter figures and announcement dates. Use source-provided financial ratios and historical valuations for matching periods. For US stocks, use cataloged data.",
  "analysis.macro":
    "Produce a macro stage memo from fixed snapshots. For A-shares, use China's GDP, CPI/PPI, manufacturing and nonmanufacturing PMI, M0/M1/M2, total social financing, LPR, industrial output, retail sales, investment, imports and exports. Explain conditions and changes using source-defined monthly, quarterly and cumulative bases. Describe growth, inflation, credit, rates and FX, then transmission to the company through demand, costs, financing and currency conversion, with necessary conditions. Distinguish aggregate observations, industry transmission and company variables. Give base and alternative paths over an explicit horizon, risks and watch signals for downstream business and valuation analysis. Read fixed daily/weekly/monthly snapshots of XAU/USD, DXY, USD/CNY, USD/CNH, EUR/USD and USD/JPY, plus the latest 60 source-provided daily observations of Chinese and US 10-year sovereign yields. Use spot FX and retain quote direction. Yield units are percent; keep missing country values null. For US macro, use cataloged data. Retain each series' units and latest observation period.",
  "debate.1.bull":
    "Independently build a bull case from the analysis digest: supporting claims, mechanisms, counterevidence and conditions, identifying variables that determine upside. Test whether favorable factors are priced in. Explain underpriced improvements in expectations, catalysts and their effects on earnings or valuation multiples. Read original reports through the catalog for detail; submit your claims and responses.",
  "debate.1.bear":
    "Independently build a bear case from the same analysis digest: opposing claims, mechanisms and invalidation conditions, identifying variables that determine downside. Test whether adverse factors are priced in. Explain underpriced deterioration in expectations and its effects on earnings or valuation multiples, and conditions under which recovering expectations invalidate the bear case. Read original reports through the catalog for detail; submit your claims and responses.",
  "manager.decision":
    "Draft the investment decision from the risk digest, explaining business drivers, valuation, risk tradeoffs and conditions that change the judgment. Estimate a target price for context.decisionPolicy's target date with method and assumptions. The code determines the benchmark price, horizon and rating. Integrate priced-in expectations, forecast differences and target-period catalysts. Explain the chosen market-pricing scenario, its relation to intrinsic value and why it is adopted; do not mechanically choose the lowest valuation. Address every risk issueId and specify investor holding, exposure, exit and reassessment conditions. Correct reported field errors before resubmitting.",
  finalize:
    "Publish decision and report as a pair under the fixed business contract, preserving the validated manager draft's business content, fixed references and risk responses.",
} as const;

export function researchTask(
  id: string,
  executor: TaskDefinition["executor"],
  dependsOn: string[],
  outputKinds: TaskDefinition["outputKinds"],
): TaskDefinition {
  return {
    id,
    executor,
    dependsOn: [...dependsOn],
    inputTasks: [...dependsOn],
    outputKinds: [...outputKinds],
    dataRequirements:
      id === "analysis.market"
        ? [{ dataset: "market", fields: ["close"], requiredForDecision: true }]
        : [],
    instructionVersion: id.startsWith("digest.") ? 3 : 2,
  };
}

export function researchVersions(
  modeVersion: string,
  sources: Readonly<Record<string, SourceCodeVersions>>,
): RunVersions {
  const adapters: Record<string, string> = {};
  const normalization: Record<string, string> = {};
  for (const [key, source] of Object.entries(sources)) {
    adapters[key] = source.adapterVersion;
    normalization[key] = source.normalizationVersion;
  }
  return {
    plugin: PLUGIN_VERSION,
    mode: modeVersion,
    prompts: {
      roles: ROLE_PROMPT_VERSION,
      digest: DIGEST_PROMPT_VERSION,
      coordinator: COORDINATOR_PROMPT_VERSION,
      valuationMethods: VALUATION_METHODS.version,
      valuationEngine: VALUATION_ENGINE_VERSION,
    },
    skills: {},
    adapters,
    normalization,
  };
}

/** Both static plans capture the same application, source and prompt contracts. */
export function captureResearchInput(
  definition: RunDefinition,
  modeVersion: string,
  briefs: Readonly<Record<string, string>>,
  policy: QueryToolPolicy,
  sources: readonly SourceDescription[],
  snapshots: readonly QuickQuerySnapshot[],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): OpenRunInput {
  const versions: Record<string, SourceCodeVersions> = {};
  for (const source of sources)
    if (source.capability !== null)
      versions[`${source.dataset}/${source.provider}`] = source.capability;
  return {
    definition: structuredClone(definition),
    versions: researchVersions(modeVersion, versions),
    inputs: [
      {
        name: APPLICATION_INPUT_NAME,
        content: captureApplicationInput(policy, sources, publicSearchLimit),
      },
      { name: "prompt:coordinator", content: COORDINATOR_PROMPT },
      {
        name: VALUATION_METHODS_INPUT,
        content: structuredClone(VALUATION_METHODS),
      },
      ...(definition.tasks.some(({ id }) => id === PUBLIC_RESEARCH_TASK)
        ? [
            {
              name: PUBLIC_RESEARCH_PROMPT_INPUT,
              content: PUBLIC_ANALYST_PROMPT,
            },
          ]
        : []),
      ...(snapshots.length === 0
        ? []
        : [
            {
              name: QUICK_SNAPSHOTS_INPUT,
              content: captureQuickSnapshots(snapshots),
            },
          ]),
    ],
    instructions: definition.tasks.map(({ id }) => ({
      taskId: id,
      instruction: briefs[id]!,
    })),
  };
}

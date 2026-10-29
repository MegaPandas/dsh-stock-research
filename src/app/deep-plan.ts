import type { ResearchScope } from "../contracts/data.js";
import type { OpenRunInput } from "../contracts/runs.js";
import type { StageDefinition, TaskDefinition } from "../contracts/workflow.js";
import type { SourceDescription } from "../services/query-sources.js";
import type { QueryToolPolicy } from "../tools/query-inputs.js";
import type { QuickQuerySnapshot } from "./quick-snapshots.js";
import { PUBLIC_SEARCH_LIMITS } from "./public-research.js";
import {
  captureResearchInput,
  DIGEST_RISK_RULE,
  researchTask as task,
  SHARED_BRIEFS,
} from "./research-plan.js";

export const DEEP_MODE_VERSION = "deep/8";
const ANALYSTS = [
  "analysis.market",
  "analysis.fundamentals",
  "analysis.macro",
  "analysis.business",
  "analysis.geopolitics",
  "analysis.sentiment",
  "analysis.public",
];
const RISKS = ["risk.finance", "risk.valuation", "risk.events"];
export const DEEP_RESEARCH_STAGES: readonly StageDefinition[] = [
  { id: "analysis", taskIds: [...ANALYSTS], beforeTasks: ["digest.analysis"] },
  ...[1, 2].map((round): StageDefinition => ({
    id: `debate.${round}`,
    taskIds: [`debate.${round}.bull`, `debate.${round}.bear`],
    beforeTasks: [`digest.debate.${round}`],
    dispatch: "together",
  })),
  {
    id: "manager.research",
    taskIds: ["manager.research"],
    beforeTasks: ["digest.plan"],
  },
  { id: "risk", taskIds: [...RISKS], beforeTasks: ["digest.risk"] },
  {
    id: "manager.decision",
    taskIds: ["manager.decision"],
    beforeTasks: ["finalize"],
  },
];
const BRIEFS = {
  ...SHARED_BRIEFS,
  "analysis.business":
    "Build a business-driver model from fixed snapshots and artifacts in this run. Explain relationships among products, revenue mix, costs, scale and competitive conditions. Describe the business model, sources of advantage, growth paths and necessary conditions. Fundamentals integrates financial forecasts and valuation; public-information research supplies product and competitive events.",
  "analysis.geopolitics":
    "Analyze trade, policy and external economic conditions from fixed macro snapshots and artifacts in this run. Explain transmission to the company through demand, costs, FX and financing, with necessary conditions and event milestones. Macro research supplies aggregate context; public-information research supplies company product, capacity and competitive events.",
  "analysis.sentiment":
    "Analyze trading behavior, participation and relative strength reflected in fixed price/volume snapshots. Explain participant behavior, necessary conditions and watch signals. Market analysis supplies price structure and trends; sentiment analysis explains participant behavior behind those observations and alternative interpretations.",
  "digest.analysis": `Combine the seven analyses' core judgments, drivers, outlooks and key disagreements. Identify specific questions affecting the debate; preserve factual periods and business definitions. ${DIGEST_RISK_RULE}`,
  "digest.debate.1": `Combine the original analysis digest and this round's bull/bear claims. Identify each side's evidence, counterevidence and disagreements that determine the judgment. ${DIGEST_RISK_RULE}`,
  "debate.2.bull":
    "Continue the bull case from the first-round debate digest. Address existing counterevidence and bear-case invalidation conditions; identify remaining disagreements and variables determining upside. Read original reports as needed; submit your claims and responses.",
  "debate.2.bear":
    "Continue the bear case from the same first-round debate digest. Address the bull side's evidence, constraints and invalidation conditions; identify remaining disagreements and variables determining downside. Read original reports as needed; submit your claims and responses.",
  "digest.debate.2": `Combine the prior digest and both sides' second-round responses. Identify supporting evidence, counterevidence and unresolved key disagreements for the research manager's plan. Repeated claims are not independent evidence. ${DIGEST_RISK_RULE}`,
  "manager.research":
    "Build a research plan from the second-round debate digest. Specify research questions, analysis paths, key assumptions, required data, risks and checkpoints. Tie each data requirement to a specific research question; output plan.",
  "digest.plan": `Combine the final debate digest and research plan for the risk-review specialties. Preserve key assumptions, required data, checkpoints, unresolved disagreements and inherited risks. ${DIGEST_RISK_RULE}`,
  "risk.finance":
    "Review financial quality, solvency and liquidity risks against the fixed plan. Provide loss mechanisms, triggers, investor exposure or position constraints, and recommendations for reassessment or exit. Treat company capex, inventory and credit actions as observations. Read original reports as needed.",
  "risk.valuation":
    "Review valuation assumptions, price bases and drawdown scenarios against the fixed plan. Provide risk impact, triggers, investor portfolio-exposure constraints, and recommendations for reassessment or exit. Read original reports as needed.",
  "risk.events":
    "Review event, policy, timeline and trading-execution risks against the fixed plan. Provide event milestones, loss mechanisms, triggers, and recommendations for investor monitoring, exposure changes or exit. Read original reports as needed.",
  "digest.risk": `Combine the plan digest and three risk reviews to identify risks and open questions affecting the decision. Summarize each risk's key impact, trigger or action constraint in one entry; retain full detail in the original report. Supply fixed inputs for the portfolio manager's itemized responses. ${DIGEST_RISK_RULE}`,
} as const;

export function createDeepInput(
  scope: ResearchScope,
  policy: QueryToolPolicy,
  sources: readonly SourceDescription[],
  snapshots: readonly QuickQuerySnapshot[] = [],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): OpenRunInput {
  const tasks: TaskDefinition[] = ANALYSTS.map((id) => ({
    ...task(
      id,
      {
        kind: "role",
        role: "analyst",
        specialty: id.slice("analysis.".length),
      },
      [],
      ["analysis"],
    ),
    ...(id === "analysis.fundamentals"
      ? { valuation: "research" as const }
      : {}),
  }));
  tasks.push(
    task("digest.analysis", { kind: "service", service: "digest" }, ANALYSTS, [
      "digest",
    ]),
  );
  for (const round of [1, 2]) {
    const upstream = round === 1 ? "digest.analysis" : "digest.debate.1";
    for (const side of ["bull", "bear"])
      tasks.push(
        task(
          `debate.${round}.${side}`,
          { kind: "role", role: "discussion", specialty: side },
          [upstream],
          ["debate"],
        ),
      );
    tasks.push(
      task(
        `digest.debate.${round}`,
        { kind: "service", service: "digest" },
        [upstream, `debate.${round}.bull`, `debate.${round}.bear`],
        ["digest"],
      ),
    );
  }
  tasks.push(
    task(
      "manager.research",
      { kind: "role", role: "manager", specialty: "research" },
      ["digest.debate.2"],
      ["plan"],
    ),
    task(
      "digest.plan",
      { kind: "service", service: "digest" },
      ["digest.debate.2", "manager.research"],
      ["digest"],
    ),
  );
  for (const id of RISKS)
    tasks.push(
      task(
        id,
        { kind: "role", role: "discussion", specialty: id },
        ["digest.plan"],
        ["risk"],
      ),
    );
  tasks.push(
    task(
      "digest.risk",
      { kind: "service", service: "digest" },
      ["digest.plan", ...RISKS],
      ["digest"],
    ),
    {
      ...task(
        "manager.decision",
        { kind: "role", role: "manager", specialty: "decision" },
        ["digest.risk"],
        ["decision_draft"],
      ),
      valuation: "decision",
    },
    task(
      "finalize",
      { kind: "service", service: "finalize" },
      ["digest.risk", "manager.decision"],
      ["decision", "report"],
    ),
  );
  return captureResearchInput(
    { scope, mode: "deep", tasks },
    DEEP_MODE_VERSION,
    BRIEFS,
    policy,
    sources,
    snapshots,
    publicSearchLimit,
  );
}

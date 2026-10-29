import type { ResearchScope } from "../contracts/data.js";
import type { OpenRunInput } from "../contracts/runs.js";
import type { TaskDefinition } from "../contracts/workflow.js";
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

export const QUICK_MODE_VERSION = "quick/9";
const BRIEFS = {
  ...SHARED_BRIEFS,
  "digest.analysis": `Combine the four analyses' core judgments, drivers, outlooks and key disagreements. Identify specific questions affecting the debate; preserve factual periods and business definitions. ${DIGEST_RISK_RULE}`,
  "digest.debate.1": `Combine the original analysis digest and this round's bull/bear claims. Identify each side's evidence, counterevidence and disagreements that determine the judgment. ${DIGEST_RISK_RULE}`,
  "risk.main":
    "Review financial, liquidity, valuation, event and execution risks from the fixed debate digest. For each, explain loss mechanisms, impact, triggers, investor exposure or position constraints, and recommendations for reassessment or exit. Treat company operating actions such as capex, inventory management and credit policy as observations. Read original reports through the catalog for detail.",
  "digest.risk": `Combine the debate digest and risk review to identify risks and open questions affecting the decision. Summarize each risk's key impact, trigger or action constraint in one entry; retain full detail in the original report. Supply fixed inputs for the manager's itemized responses. ${DIGEST_RISK_RULE}`,
} as const;

export function createQuickInput(
  scope: ResearchScope,
  policy: QueryToolPolicy,
  sources: readonly SourceDescription[],
  snapshots: readonly QuickQuerySnapshot[] = [],
  publicSearchLimit: number = PUBLIC_SEARCH_LIMITS.maxSearches,
): OpenRunInput {
  const analysts = [
    "analysis.market",
    "analysis.fundamentals",
    "analysis.macro",
    "analysis.public",
  ] as const;
  const tasks: TaskDefinition[] = analysts.map((id) =>
    task(
      id,
      {
        kind: "role",
        role: "analyst",
        specialty: id.slice("analysis.".length),
      },
      [],
      ["analysis"],
    ),
  );
  tasks.push(
    task(
      "digest.analysis",
      { kind: "service", service: "digest" },
      [...analysts],
      ["digest"],
    ),
    task(
      "debate.1.bull",
      { kind: "role", role: "discussion", specialty: "bull" },
      ["digest.analysis"],
      ["debate"],
    ),
    task(
      "debate.1.bear",
      { kind: "role", role: "discussion", specialty: "bear" },
      ["digest.analysis"],
      ["debate"],
    ),
    task(
      "digest.debate.1",
      { kind: "service", service: "digest" },
      ["digest.analysis", "debate.1.bull", "debate.1.bear"],
      ["digest"],
    ),
    task(
      "risk.main",
      { kind: "role", role: "discussion", specialty: "risk" },
      ["digest.debate.1"],
      ["risk"],
    ),
    task(
      "digest.risk",
      { kind: "service", service: "digest" },
      ["digest.debate.1", "risk.main"],
      ["digest"],
    ),
    task(
      "manager.decision",
      { kind: "role", role: "manager", specialty: "decision" },
      ["digest.risk"],
      ["decision_draft"],
    ),
    task(
      "finalize",
      { kind: "service", service: "finalize" },
      ["digest.risk", "manager.decision"],
      ["decision", "report"],
    ),
  );
  return captureResearchInput(
    { scope, mode: "quick", tasks },
    QUICK_MODE_VERSION,
    BRIEFS,
    policy,
    sources,
    snapshots,
    publicSearchLimit,
  );
}

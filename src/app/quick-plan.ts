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

export const QUICK_MODE_VERSION = "quick/7";
const BRIEFS = {
  ...SHARED_BRIEFS,
  "digest.analysis": `汇总四份分析的核心判断、驱动机制、展望与关键分歧，提炼影响后续讨论的具体问题，保留事实的期间与业务口径。${DIGEST_RISK_RULE}`,
  "digest.debate.1": `汇总原分析摘要与本轮多空论点，提炼双方依据、反证和决定判断的分歧。${DIGEST_RISK_RULE}`,
  "risk.main":
    "基于固定辩论摘要检查财务、流动性、估值、事件和执行风险，逐项说明损失机制、影响、触发条件、投资者的暴露或仓位约束及重估或退出建议。资本开支、库存管理和授信等公司经营动作作为观察事项。需要展开细节时按目录读取原始报告。",
  "digest.risk": `合并辩论摘要与风控意见，提炼影响决策的风险和未决问题。每项风险以一条综述保留关键影响、触发或处置约束，完整细节保存在原报告中，为经理逐项回应提供固定输入。${DIGEST_RISK_RULE}`,
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

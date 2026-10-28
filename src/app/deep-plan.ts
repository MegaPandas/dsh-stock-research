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

export const DEEP_MODE_VERSION = "deep/5";
const BRIEFS = {
  ...SHARED_BRIEFS,
  "analysis.business":
    "依据固定快照与同运行产物建立经营驱动模型，解释产品、收入结构、成本、规模与竞争条件的作用关系。交付经营模式、优势来源、增长路径和成立条件；财务预测与估值由基本面方向整合，产品与竞争事件由公开信息方向提供。",
  "analysis.geopolitics":
    "依据固定宏观快照与同运行产物分析贸易、政策及外部经济条件，交付需求、成本、汇率和融资向公司的传导路径、成立条件与事件节点。宏观总量背景由宏观方向提供，公司产品、产能与竞争事件由公开信息方向提供。",
  "analysis.sentiment":
    "依据固定行情快照分析量价表现所反映的交易特征、参与度与相对强弱，交付交易行为解释、成立条件和观察信号。行情方向提供价格结构与趋势，情绪方向解释这些观察对应的参与者行为及替代解释。",
  "digest.analysis": `汇总七份分析的核心判断、驱动机制、展望与关键分歧，提炼影响后续讨论的具体问题，保留事实的期间与业务口径。${DIGEST_RISK_RULE}`,
  "digest.debate.1": `汇总原分析摘要与本轮多空论点，提炼双方依据、反证和决定判断的分歧。${DIGEST_RISK_RULE}`,
  "debate.2.bull":
    "基于第一轮辩论摘要继续多方讨论，回应已有反证与空方失效条件，明确剩余争议及决定上行判断的变量。按需读取原始报告，提交本方论点与回应。",
  "debate.2.bear":
    "基于同一第一轮辩论摘要继续空方讨论，回应多方的依据、约束与失效条件，明确剩余争议及决定下行风险的变量。按需读取原始报告，提交本方论点与回应。",
  "digest.debate.2": `汇总前轮摘要和第二轮双方回应，提炼支持、反证及仍未解决的关键争议，供研究经理制定计划；不把重复观点当作独立证据。${DIGEST_RISK_RULE}`,
  "manager.research":
    "依据第二轮辩论摘要形成研究计划，说明研究问题、分析路径、关键假设、必要数据需求、风险与检查点。每项数据需求对应具体研究问题，输出plan。",
  "digest.plan": `合并最终辩论摘要与研究计划，保留关键假设、必要数据需求、检查点、未决分歧和继承风险，交给各风控分工。${DIGEST_RISK_RULE}`,
  "risk.finance":
    "依据固定计划检查财务质量、偿付能力和流动性风险，交付损失机制、触发条件、投资者的暴露或仓位约束及重估或退出建议；公司资本开支、库存和授信动作作为观察事项。按需读取原始报告。",
  "risk.valuation":
    "依据固定计划检查估值假设、价格口径和回撤情景，交付风险影响、触发条件、投资者的组合暴露约束及重估或退出建议。按需读取原始报告。",
  "risk.events":
    "依据固定计划检查事件、政策、时间线和交易执行风险，交付事件节点、损失机制、触发条件及投资者的观察、暴露调整或退出建议。按需读取原始报告。",
  "digest.risk": `合并计划摘要与三份风控，提炼影响决策的风险和未决问题。每项风险以一条综述保留关键影响、触发或处置约束，完整细节保存在原报告中，为组合经理逐项回应提供固定输入。${DIGEST_RISK_RULE}`,
} as const;

export function createDeepInput(
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
    "analysis.business",
    "analysis.geopolitics",
    "analysis.sentiment",
    "analysis.public",
  ];
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
    task("digest.analysis", { kind: "service", service: "digest" }, analysts, [
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
  const risks = ["risk.finance", "risk.valuation", "risk.events"];
  for (const id of risks)
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
      ["digest.plan", ...risks],
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
    { scope, mode: "deep", tasks },
    DEEP_MODE_VERSION,
    BRIEFS,
    policy,
    sources,
    snapshots,
    publicSearchLimit,
  );
}

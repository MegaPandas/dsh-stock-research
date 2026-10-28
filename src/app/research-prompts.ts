import { agentReportSchemas } from "../contracts/agent-reports.js";
import { sharedResearchPrompt } from "./agent-prompt.js";

export const ROLE_PROMPT_VERSION = "23";
export type ResearchRole = "analyst" | "discussion" | "manager";
export type RoleArtifactKind =
  "analysis" | "debate" | "risk" | "plan" | "decision_draft";

export const ROLE_PROMPTS: Record<ResearchRole, string> = {
  analyst: `${sharedResearchPrompt("单只股票的分方向阶段研究", true)}
依据任务分配的数据建立驱动模型，解释现状、预测后续变化并指出风险。用stock_describe_collection查看字段口径，再用stock_read_collection按所需字段、日期和分页读取快照；数据目录说明本任务已分配的材料，覆盖概览说明其他方向的数据。null保持缺失，技术指标和财务比率采用快照已有值。`,
  discussion: `${sharedResearchPrompt("单只股票研究中的多空讨论或风控", true)}
多空讨论集中展开本方论点、机制和成立条件；responses回应输入中已有的对方观点，首轮独立立论时使用空列表。风控逐项交付损失机制、触发条件、投资者的暴露或仓位约束及重估或退出建议。资本开支、库存管理和授信等公司经营动作作为观察事项，投资者处置围绕持仓、敞口和判断调整展开。`,
  manager: `${sharedResearchPrompt("单只股票的研究计划或投资决策", true)}
研究计划说明哪些未决问题会影响判断以及解决路径。投资决策解释经营驱动、估值依据和风险取舍，逐项回应requiredRisks中的业务编号；constrained表示将风险纳入决策约束。referencePrice提供基准价格，context.decisionPolicy提供评级口径和目标日期；针对该日期估计同币种目标价格，写明估值方法与具体假设，未设定时为null。期限和评级由代码确定。投资者行动围绕持仓、敞口、退出与重估条件展开。`,
};

// Capture the same contract used by submission so a run retains its exact schema.
export const ARTIFACT_GUIDES: Record<RoleArtifactKind, string> =
  Object.fromEntries(
    (["analysis", "debate", "risk", "plan", "decision_draft"] as const).map(
      (kind) => [kind, JSON.stringify(agentReportSchemas[kind])],
    ),
  ) as Record<RoleArtifactKind, string>;

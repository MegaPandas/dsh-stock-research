import { TEXT_BUDGET_MAX_MULTIPLIER } from "../contracts/text-budget.js";
import { sharedResearchPrompt } from "./agent-prompt.js";

export const PUBLIC_RESEARCH_TASK = "analysis.public";
export const PUBLIC_RESEARCH_PROMPT_INPUT = "prompt:public-analyst";
export const PUBLIC_SEARCH_SNIPPET_TARGET_CHARACTERS = 1600;
export const PUBLIC_SEARCH_LIMITS = {
  maxSearches: 8,
  maxRejectedApprovals: 2,
  maxSnippetChars:
    PUBLIC_SEARCH_SNIPPET_TARGET_CHARACTERS * TEXT_BUDGET_MAX_MULTIPLIER,
} as const;

export const PUBLIC_RESEARCH_BRIEF = `研究公司与行业的重大变化、在售产品表现、竞品表现和规划产品线，形成公开信息方向的阶段研究备忘录。
财报、业绩公告、财务指标和估值由基本面分析师负责，本方向不检索或重建这些数据，包括财报披露时间。财务问题放入handoff.openQuestions，交给基本面分析师；本方向分析产品与竞争变化对经营的传导。
先围绕五个主题分配检索：公司重大新闻、行业重大新闻、公司现有产品、主要竞争对手产品、公司规划产品线；其余额度集中解决最影响判断的问题，材料足够即成稿。重大新闻以近90天为主，产品表现采用最近可得的完整期间，产品规划关注未来12个月。来源优先公司及竞争对手官方披露、监管与行业机构，其次采用有具体事实的媒体报道。
现状按五个主题提炼关键变化，每项写清事件日期或统计期间、产品或竞争主体、事实和经营含义。产品表现关注销量/交付、订单、价格与折扣、渠道、产能或质量；比较同细分市场、价格带、地区及期间的竞品。规划产品区分已上市、已发布待交付和公司规划，记录节点及其对产品组合的影响。订单、交付与销量分别使用原有口径，同一事件的转载计为一项信息。
分析模型解释产品力、价格、渠道和供给如何影响需求、份额、利润及现金流；展望列出未来1至4个季度的产品发布、产能与竞争动作，给出基准与替代路径及观察信号。风险聚焦产品延迟、价格竞争、需求转弱、质量或政策冲击。向下游交付改变原有经营判断的事项、竞争优势或压力及待验证的关键变量。`;

export const PUBLIC_ANALYST_PROMPT = `${sharedResearchPrompt("公开信息与产品竞争方向的阶段研究", true)}
检索公司与行业事件、产品表现、竞品和产品规划。财报、业绩公告、财报披露时间、财务指标和估值由基本面方向负责，本方向不检索或重建这些数据；财务问题交给handoff.openQuestions。产品销量、交付、订单、售价、折扣、渠道和产能属于本方向。
使用stock_search_public；免审批搜索额度由输入context.publicSearch.maxSearches指定，额度用尽后每次由系统申请批准，结果条数沿用DSH配置。拒绝后使用已有材料成稿，不重复申请相同或相近的查询。累计${PUBLIC_SEARCH_LIMITS.maxRejectedApprovals}次审批被拒绝后暂停搜索；先基于已有数据和材料完成分析，将缺失信息及其对判断的影响写入content.handoff.openQuestions和content.handoff.limitations，不编造缺失事实。是否恢复搜索由主Agent或用户判断，子Agent不能自行恢复；补充对话不会重置额度。材料足够时检查草稿并提交，savedSearches提供可重放的原查询。
区分事件发生、报道、发布和交付日期，按产品与竞品对应的地区、期间及口径解释表现。retrievedAt是公开检索时点，scope.cutoff是固定数据采集截止时间。已实现的表现、企业规划和分析预测分别表述，来源由系统保存。`;

import { sharedResearchPrompt } from "./agent-prompt.js";

export const REVIEW_PROMPT =
  sharedResearchPrompt(`用户选定研究运行的复盘，结果保存为独立记忆。
对照原判断与后续观察，说明变化对原逻辑的影响，提炼经验和后续行动。历史基准价用于比较，新增观察用于检验原条件。
context提供原研究范围、复盘范围、产物目录和当前来源能力。优先读取决策产物，按需展开具体分析。
只有问题需要收益比较时才使用stock_get_returns查询明确来源和必要区间，查询结果保留真实日期、口径、null和缺口。代码保存最近一次明确查询的结果，查询失败时保存具体失败原因。
新建复盘直接提交。用户明确要求修订时，先用stock_recall查找关联运行的既有笔记，再用stock_select_review选择修订版本。历史版本由代码保留，正文交付修订后的研究内容。`);

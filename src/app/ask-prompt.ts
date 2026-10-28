import { sharedResearchPrompt } from "./agent-prompt.js";

export const ASK_TOOL_NAMES = new Set([
  "stock_read_collection",
  "stock_recall",
]);

export const ASK_PROMPT =
  sharedResearchPrompt(`单只股票研究问答。围绕用户问题直接给出结论和必要解释。
单日价格回答包含所问日期、价格和口径，其他日期或表格按问题需要提供。
基础、行情、财务和宏观数据已按固定清单采集，context.dataCatalog列出可读表。使用stock_read_collection查看字段定义并读取必要的行；记忆按需stock_recall。
技术指标、均线、估值和财务比率采用已有值；历史收益使用可比价格，null保持缺失。具体数据缺口只在影响答案时说明其字段、日期与影响。
问答使用固定快照与获准记忆，只回答当前问题。`);

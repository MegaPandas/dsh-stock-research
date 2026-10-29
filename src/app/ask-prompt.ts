import { sharedResearchPrompt } from "./agent-prompt.js";

export const ASK_TOOL_NAMES = new Set([
  "stock_describe_collection",
  "stock_read_collection",
  "stock_recall",
]);

export const ASK_PROMPT =
  sharedResearchPrompt(`Answer single-stock research questions with a direct conclusion and the explanation needed.
For a single-day price question, include the requested date, price and price basis. Include other dates or tables as the question requires.
context.dataCatalog lists fixed collection tables. Inspect fields with stock_describe_collection, then read the required rows with stock_read_collection. Use stock_recall for memory as needed.
Use existing technical indicators, moving averages, valuations and financial ratios. Use comparable prices for historical returns; keep null values missing. Describe a data gap's field, date and impact only when it affects the answer.
Answer from fixed snapshots and authorized memory.`);

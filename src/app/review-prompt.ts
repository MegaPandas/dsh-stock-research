import { sharedResearchPrompt } from "./agent-prompt.js";

export const REVIEW_PROMPT =
  sharedResearchPrompt(`Review the research run selected by the user and save the result as separate memory.
Compare the original judgment with later observations, test the original forecast conditions, and identify lessons and follow-up actions.
context supplies the original scope, review scope, artifact catalog and current source capabilities. Read the decision artifact first; open supporting analysis as needed.
When comparing returns, query the specified source and interval with stock_get_returns. Preserve dates, measurement bases and missing values. The code saves the latest query result or failure reason.
Submit a new review directly. When the user requests a revision, find related notes with stock_recall, select a version with stock_select_review, then submit the revised body. The code retains version history.`);

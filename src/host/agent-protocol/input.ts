import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ResearchScope } from "../../contracts/data.js";

export function agentInput(input: {
  scope: ResearchScope;
  task: { role: string; objective: string; id?: string };
  context: Record<string, unknown>;
}): ContentBlock[] {
  return [
    {
      type: "text",
      text: JSON.stringify({
        ...input,
        context: {
          materials: [],
          dataCatalog: [],
          reportCatalog: [],
          requiredRisks: [],
          referencePrice: null,
          ...input.context,
        },
      }),
    },
  ];
}

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { draftFileTools } from "../tools/draft-file.js";
import {
  objectSchema,
  resultOutput,
  stringSchema,
} from "../tools/parameters.js";
import type { DraftFile } from "./draft-file.js";

export function parseBusinessJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new ResearchError(
      "INVALID_INPUT",
      `Invalid business JSON syntax: ${(cause as SyntaxError).message.split(', "')[0]}`,
      { cause },
    );
  }
}

export function businessDraftTools(file: DraftFile): ToolDefinition[] {
  return draftFileTools(file).map((tool) => ({
    ...tool,
    description:
      tool.name === "stock_read_draft"
        ? "Read this task's fixed business JSON draft. No path parameter; reading is unnecessary before the first write."
        : tool.name === "stock_write_draft"
          ? "Write this task's complete business JSON using only the specified business fields, without Markdown fences or extra prose. No path parameter."
          : "Replace a uniquely matching fragment in this task's JSON draft. No path parameter.",
    output: resultOutput(
      tool.name === "stock_read_draft"
        ? objectSchema({ content: stringSchema })
        : objectSchema({ status: { type: "string", const: "saved" } }),
    ),
    async execute(value, exec) {
      const result = await tool.execute(value, exec);
      return tool.name === "stock_read_draft"
        ? { content: (result as { content: string }).content }
        : { status: "saved" };
    },
  }));
}

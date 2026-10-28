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
        ? "读取本任务固定业务JSON草稿；没有路径参数。首次尚未写稿时无需读取。"
        : tool.name === "stock_write_draft"
          ? "写入本任务完整业务JSON，只含给定业务字段，不使用Markdown围栏或额外正文；没有路径参数。"
          : "替换本任务JSON草稿中唯一匹配的片段；没有路径参数。",
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

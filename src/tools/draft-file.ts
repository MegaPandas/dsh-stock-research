import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { DraftFile } from "../host/draft-file.js";
import { researchTool } from "./errors.js";
import {
  invalid,
  object,
  objectSchema,
  resultOutput,
  stringSchema,
} from "./parameters.js";

function string(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} requires a string.`);
  return value;
}

export function draftFileTools(file: DraftFile): ToolDefinition[] {
  const pathOutput = resultOutput(objectSchema({ path: stringSchema }));
  return [
    researchTool({
      name: "stock_read_draft",
      description:
        "读取服务端固定草稿文件。文件以 JSON 元数据代码围栏开头，其后全部为 Markdown 正文；无路径参数。",
      parameters: objectSchema({}),
      output: resultOutput(
        objectSchema({ path: stringSchema, content: stringSchema }),
      ),
      async execute(value, exec) {
        object(value, []);
        return { path: file.path, content: await file.read(exec.signal) };
      },
    }),
    researchTool({
      name: "stock_write_draft",
      description:
        "写入服务端固定草稿文件的完整内容。使用开头 JSON 元数据围栏和其后的 Markdown 正文；无路径参数，提交时验证内容。",
      parameters: objectSchema({ content: stringSchema }),
      output: pathOutput,
      async execute(value, exec) {
        const item = object(value, ["content"]);
        await file.write(string(item.content, "content"), exec.signal);
        return { path: file.path };
      },
    }),
    researchTool({
      name: "stock_edit_draft",
      description:
        "在服务端固定草稿文件中原子替换唯一匹配的 oldText。文件使用 JSON 元数据围栏和 Markdown 正文；oldText 非空，newText 可为空以删除，无路径参数。",
      parameters: objectSchema({
        oldText: {
          ...stringSchema,
          description: "非空且在当前文件中唯一匹配的原文。",
        },
        newText: stringSchema,
      }),
      output: pathOutput,
      async execute(value, exec) {
        const item = object(value, ["oldText", "newText"]);
        const oldText = string(item.oldText, "oldText");
        if (oldText === "") invalid("oldText requires nonempty text.");
        await file.edit(oldText, string(item.newText, "newText"), exec.signal);
        return { path: file.path };
      },
    }),
  ];
}

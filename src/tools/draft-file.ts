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
        "Read the fixed server-side draft file: a leading JSON metadata code fence followed by the Markdown body. No path parameter.",
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
        "Write the complete fixed server-side draft: a leading JSON metadata code fence followed by the Markdown body. No path parameter; content is validated on submission.",
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
        "Atomically replace the unique oldText match in the fixed server-side draft, which contains a JSON metadata fence and Markdown body. oldText must be nonempty; empty newText deletes it. No path parameter.",
      parameters: objectSchema({
        oldText: {
          ...stringSchema,
          description:
            "Nonempty original text matching exactly once in the current file.",
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

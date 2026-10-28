import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { OpenRunInput } from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import type { ResearchRuntime } from "../host/runtime.js";
import { researchTool } from "../tools/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";
import type { ResearchInput } from "./ask-input.js";

/** This command authorizes one selection; the model only chooses its request ID. */
export function openResearchTool(
  runtime: ResearchRuntime,
  selection: ResearchInput,
  input: OpenRunInput,
  opened: (runId: string) => void,
): ToolDefinition {
  const expected = {
    kind: "fresh",
    security: selection.security,
    date: selection.scope.date,
    mode: input.definition.mode,
  } as const;
  let runId: string | undefined;
  let openedRequest: string | undefined;
  return researchTool({
    name: "stock_open_run",
    description:
      "为本次用户已选标的、日期与模式开立正式研究；同一命令只开立一个运行，不请求数据。返回状态和任务清单。",
    parameters: objectSchema({
      requestId: stringSchema,
      kind: { type: "string", const: expected.kind },
      security: { type: "string", const: expected.security },
      date: { type: "string", const: expected.date },
      mode: { type: "string", const: expected.mode },
    }),
    output: resultOutput(opaqueObjectSchema),
    async execute(value, exec) {
      exec.signal.throwIfAborted();
      const item = object(value, ["requestId", ...Object.keys(expected)]);
      const requestId = text(item.requestId, "requestId");
      for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        const actual = text(item[key], key);
        if (actual !== expected[key])
          throw new ResearchError(
            "ACCESS_DENIED",
            "The open request differs from the user's selection.",
          );
      }
      // A new request ID cannot create another run during the same command.
      if (runId !== undefined && requestId !== openedRequest)
        throw new ResearchError(
          "REQUEST_CONFLICT",
          "This command already opened its run.",
        );
      const view = runtime.openRun(exec.agent, input, requestId);
      runId = view.runId;
      openedRequest = requestId;
      opened(runId);
      return view;
    },
  });
}

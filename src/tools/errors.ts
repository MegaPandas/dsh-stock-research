import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../contracts/errors.js";
import { ArtifactNumberError } from "../services/artifacts.js";

/** DSH preserves structured error identity only for its HarnessError base class. */
export function researchTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(value, exec) {
      try {
        if (typeof value === "string") {
          let detail = "Expected a JSON argument object, received text.";
          try {
            JSON.parse(value);
          } catch (cause) {
            detail += ` Parsing that text as JSON failed: ${(cause as SyntaxError).message}`;
          }
          // pi-ai also discards malformed arguments when replaying assistant history.
          throw new ResearchError(
            "INVALID_INPUT",
            `${detail}\nReceived text:\n${value}`,
          );
        }
        return await tool.execute(value, exec);
      } catch (cause) {
        if (!(cause instanceof ResearchError)) throw cause;
        const message =
          cause instanceof ArtifactNumberError
            ? JSON.stringify({
                code: cause.code,
                message: cause.message,
                checks: cause.checks,
              })
            : `${cause.code}: ${cause.message}`;
        const error = new HarnessError(message, cause.code, { cause });
        error.name = cause.name;
        throw error;
      }
    },
  };
}

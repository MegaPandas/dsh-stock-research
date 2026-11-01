import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  agentReportSchemas,
  type AgentReport,
  type AgentReportKind,
} from "../../contracts/agent-reports.js";
import { ResearchError } from "../../contracts/errors.js";
import { parseAgentReport } from "../../artifacts/agent-reports.js";
import { researchTool } from "../tool-protocol/errors.js";
import { objectSchema, resultOutput } from "../tool-protocol/parameters.js";

/** All research roles complete through a validated, successful business commit. */
export function createSubmissionSession<Kind extends AgentReportKind, Result>(
  kind: Kind,
  accept: (
    report: AgentReport<Kind>,
    exec: ToolRunContext,
  ) => Result | Promise<Result>,
): {
  submit(
    value: unknown,
    exec: ToolRunContext,
  ): Promise<{ status: "submitted" }>;
  result(): Result;
} {
  let accepted: { value: Result } | undefined;
  let rejected: unknown;
  let failure: unknown;
  return {
    async submit(value, exec) {
      exec.signal.throwIfAborted();
      if (accepted !== undefined) {
        exec.concludeTurn();
        return { status: "submitted" };
      }
      try {
        const report = parseAgentReport(kind, value);
        const result = await accept(report, exec);
        accepted = { value: result };
        exec.concludeTurn();
        return { status: "submitted" };
      } catch (cause) {
        rejected = cause;
        const recoverable =
          (cause instanceof ResearchError || cause instanceof HarnessError) &&
          ["INVALID_INPUT", "INVALID_ARTIFACT", "NUMBER_MISMATCH"].includes(
            cause.code,
          );
        if (!recoverable) {
          failure = cause;
          exec.agent?.cancel({ kind: "user" });
        }
        throw cause;
      }
    },
    result() {
      if (accepted !== undefined) return accepted.value;
      if (failure !== undefined) throw failure;
      throw (
        rejected ??
        new ResearchError(
          "INVALID_ARTIFACT",
          "Agent ended without submitting its business result.",
        )
      );
    },
  };
}

export function createSubmission<Kind extends AgentReportKind, Result>(
  kind: Kind,
  accept: (
    report: AgentReport<Kind>,
    exec: ToolRunContext,
  ) => Result | Promise<Result>,
): { tool: ToolDefinition; result(): Result } {
  const session = createSubmissionSession(kind, accept);
  return {
    tool: researchTool({
      name: "stock_submit",
      description:
        "Submit this role's business JSON. Correct reported field errors in this session; successful submission ends execution.",
      parameters: agentReportSchemas[kind],
      output: resultOutput(
        objectSchema({ status: { type: "string", const: "submitted" } }),
      ),
      execute: session.submit,
    }),
    result: session.result,
  };
}

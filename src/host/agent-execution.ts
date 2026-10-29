import { HarnessError, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  agentReportSchemas,
  type AgentReport,
  type AgentReportKind,
} from "../contracts/agent-reports.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { parseAgentReport } from "../services/agent-reports.js";
import { researchTool } from "../tools/errors.js";
import { objectSchema, resultOutput } from "../tools/parameters.js";
import { preserveToolArguments } from "./tool-arguments.js";

export function setupResearchTools(
  ctx: Context,
  agent: Agent,
  tools: readonly ToolDefinition[],
): () => void {
  preserveToolArguments(agent);
  const approved = new Map(tools.map((tool) => [tool.name, tool]));
  ctx.tools.presentAs("native");
  // SDK restrictions filter inherited tools; local definitions are registered below.
  ctx.tools.restrict({
    allow: ctx.tools
      .schemas(agent)
      .filter(({ name }) => approved.has(name))
      .map(({ name }) => name),
  });
  for (const tool of tools) ctx.tools.register(tool);
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembly = await next();
    return {
      ...assembly,
      tools: assembly.tools.filter(({ name }) => approved.has(name)),
    };
  });
  ctx.tools.guard((exec) => {
    const definition = approved.get(exec.name);
    if (
      definition === undefined ||
      ctx.tools.get(exec.name, exec.agent) !== definition
    )
      return "The tool is outside this research Agent's capabilities.";
  });
  return () => {
    // Host presets can add their own tools to this scope; execution remains gated above.
    for (const [name, definition] of approved)
      if (ctx.tools.get(name, agent) !== definition)
        throw new ResearchError(
          "ACCESS_DENIED",
          `The research Agent's approved tool "${name}" is unavailable or replaced.`,
        );
  };
}

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

/** All research roles complete through a validated, successful business commit. */
export function createSubmission<Kind extends AgentReportKind, Result>(
  kind: Kind,
  accept: (
    report: AgentReport<Kind>,
    exec: ToolRunContext,
  ) => Result | Promise<Result>,
): { tool: ToolDefinition; result(): Result } {
  let accepted: { value: Result } | undefined;
  let rejected: unknown;
  let failure: unknown;
  return {
    tool: researchTool({
      name: "stock_submit",
      description:
        "Submit this role's business JSON. Correct reported field errors in this session; successful submission ends execution.",
      parameters: agentReportSchemas[kind],
      output: resultOutput(
        objectSchema({ status: { type: "string", const: "submitted" } }),
      ),
      async execute(value, exec) {
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
    }),
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

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ResearchError } from "../../contracts/errors.js";
import { preserveToolArguments } from "./tool-arguments.js";

export async function setupResearchTools(
  ctx: Context,
  agent: Agent,
  tools: readonly ToolDefinition[],
): Promise<() => void> {
  preserveToolArguments(agent);
  const approved = new Map(tools.map((tool) => [tool.name, tool]));
  const legacyTools = ctx.tools as typeof ctx.tools & {
    presentAs?: (mode: "native") => () => void;
  };
  if (typeof legacyTools.presentAs === "function") {
    legacyTools.presentAs("native");
    ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembly = (await next()) as PromptAssembly;
      return {
        ...assembly,
        tools: assembly.tools.filter(({ name }) => approved.has(name)),
      };
    });
  } else {
    // DSH 0.2.2 presents tools through a scoped executor, outside prompt transforms.
    const { NativeToolExecutor } =
      await import("@deepseek-ai/dsh-tool-executor-native");
    const executor = new NativeToolExecutor(ctx);
    ctx.tools.setExecutor({
      describe: (definitions) =>
        executor.describe(definitions.filter(({ name }) => approved.has(name))),
      execute: (input) => executor.execute(input),
    });
  }
  // SDK restrictions filter inherited tools; local definitions are registered below.
  ctx.tools.restrict({
    allow: ctx.tools
      .schemas(agent)
      .filter(({ name }) => approved.has(name))
      .map(({ name }) => name),
  });
  for (const tool of tools) ctx.tools.register(tool);
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

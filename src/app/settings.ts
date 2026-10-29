import type { Context } from "@deepseek-ai/cordis";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import type { ModelConfig } from "./model-config.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { withActivity } from "./activity.js";

export interface ResearchSettings {
  readonly model: ModelConfig | undefined;
  readonly publicSearchLimit: number;
  runTool(
    name: string,
    value: unknown,
    exec: ToolRunContext,
    run: () => Promise<unknown>,
  ): Promise<unknown>;
  runCommand(
    name: string,
    invocation: CommandInvocation,
    run: () => Promise<CommandResult>,
  ): Promise<CommandResult>;
}

export function runApplicationTool(
  ctx: Context,
  name: string,
  value: unknown,
  exec: ToolRunContext,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const settings = ctx.get("stockResearchSettings");
  return settings === undefined
    ? withActivity(ctx.stockResearch, run)
    : settings.runTool(name, value, exec, run);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    stockResearchSettings: ResearchSettings;
  }
}

export function runApplicationCommand(
  ctx: Context,
  name: string,
  invocation: CommandInvocation,
  run: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const settings = ctx.get("stockResearchSettings");
  return settings === undefined
    ? withActivity(ctx.stockResearch, run)
    : settings.runCommand(name, invocation, run);
}

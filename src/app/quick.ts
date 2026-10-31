import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { ModelConfigSchema } from "./model-config.js";
import type { ModelConfig } from "../contracts/settings.js";
import { COORDINATOR_PROMPT } from "./coordinator-prompt.js";
import { ResearchApplication } from "./research-application.js";
import { createResearchCommands } from "./research-commands.js";
import {
  applicationTool,
  createResearchTools,
  createResearchReviewTool,
} from "./research-tools.js";
import { createResearchReadTools } from "./research-read-tools.js";

export const Config = ModelConfigSchema.required(false);
export const name = "stock-quick";
export const inject = [
  "stockResearch",
  "commands",
  "systemPrompt",
  "jobs",
  "tools",
  "agents",
];
export function apply(ctx: Context, config?: ModelConfig): void {
  const runtime = ctx.stockResearch;
  const app = new ResearchApplication(ctx, structuredClone(config), {
    bind: (owner) => runtime.bindCoordinator(owner),
    register: (owner, actions, operations, retain) => {
      retain(owner.ctx.tools.register(createResearchReviewTool(ctx, actions)));
      for (const tool of createResearchReadTools(runtime.runs, runtime.tools))
        retain(owner.ctx.tools.register(tool));
      for (const tool of runtime.createCoordinatorTools(operations))
        retain(owner.ctx.tools.register(applicationTool(ctx, tool)));
    },
  });
  ctx.effect(function* () {
    yield () => app.close();
    yield ctx.jobs.attachController("stock-research");
    yield ctx.systemPrompt.section({
      name: "stock:research-workflow",
      order: 60,
      text: COORDINATOR_PROMPT,
      interpolate: false,
    });
    yield ctx.on("agent/disposed", ({ agent }) => {
      void app.disposeOwner(agent).catch((cause) => ctx.logger.error(cause));
    });
    yield ctx.on("agent/status", ({ agent, status }) => {
      if (status === "idle") app.idleOwner(agent);
    });
    for (const tool of createResearchTools(ctx, app))
      yield ctx.tools.register(tool);
    for (const command of createResearchCommands(ctx, app))
      yield ctx.commands.register(command);
  });
}

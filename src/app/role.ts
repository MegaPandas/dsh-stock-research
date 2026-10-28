import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-system-prompt";
import z from "@deepseek-ai/schemastery";
import { ResearchError } from "../contracts/errors.js";
import { ROLE_PROMPT_SECTION } from "../host/dispatch.js";
import { ROLE_PROMPTS, type ResearchRole } from "./research-prompts.js";

export interface RoleConfig {
  role: ResearchRole;
}
export const Config = z
  .transform(
    z
      .object({
        role: z
          .union([
            z.const("analyst"),
            z.const("discussion"),
            z.const("manager"),
          ])
          .required(),
      })
      .required(),
    (value): RoleConfig => {
      if (Object.keys(value).some((key) => key !== "role"))
        throw new ResearchError(
          "INVALID_INPUT",
          "Unknown research role configuration field.",
        );
      return { role: value.role! };
    },
  )
  .required();
export const name = "stock-research-role";
export const inject = ["systemPrompt"];
export function apply(ctx: Context, config: RoleConfig): void {
  ctx.systemPrompt.section({
    name: ROLE_PROMPT_SECTION,
    order: 0,
    text: ROLE_PROMPTS[config.role],
    complete: true,
    interpolate: false,
  });
}

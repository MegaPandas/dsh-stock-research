import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { SettingsPage } from "./SettingsPage.js";
import type { ModelCatalog } from "./settings-types.js";
import type { ApplicationConfig } from "../contracts/settings.js";
import { registerResearchJobs } from "./research-jobs.js";

export const inject = [
  "slots",
  "configForms",
  "remote",
  "remote.session",
  "uiConversation",
  "jobs",
];

export function apply(ctx: Context): void {
  registerResearchJobs(ctx);
  const form = ctx.configForms.get<ApplicationConfig>("stock-research");
  const loadCatalog = async (): Promise<ModelCatalog> => {
    const result = await ctx.remote.session.modelCatalog();
    if (!result.ok) throw result.error;
    return result.value;
  };
  ctx.effect(() =>
    ctx.configForms.whileServed(["stock-research"], () =>
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "stock-research",
            order: 60,
            label: () => "股票研究",
            inject: () => ({ form, loadCatalog }),
          },
          SettingsPage,
        ),
      ),
    ),
  );
}

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { SettingsPage } from "./SettingsPage.js";
import type { ModelCatalog, SettingsValue } from "./settings-types.js";
import { registerResearchJobs } from "./research-jobs.js";

export const inject = [
  "slots",
  "configForms",
  "remote",
  "remote.session",
  "remote.commands",
  "uiConversation",
  "jobs",
];

export function apply(ctx: Context): void {
  registerResearchJobs(ctx);
  const form = ctx.configForms.get<SettingsValue>("stock-research");
  const loadCatalog = async (): Promise<ModelCatalog> => {
    const remote = ctx.remote as unknown as {
      session: { modelCatalog(): Promise<RemoteResult<ModelCatalog>> };
    };
    const result = await remote.session.modelCatalog();
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

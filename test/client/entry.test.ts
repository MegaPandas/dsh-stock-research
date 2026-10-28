import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { Context, Service } from "@deepseek-ai/cordis";
import {
  applyEntryPatches,
  entryListSchema,
} from "@deepseek-ai/cordis-plugin-include";
import ClientModules from "@deepseek-ai/dsh-client-modules";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeHost } from "../fixtures/runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("packaged DSH settings client", () => {
  it("is discovered from the shipped patch, delivered by the native boot graph, and registers a removable settings page", async () => {
    const h = await runtimeHost();
    cleanups.push(h.close);
    await h.ctx.plugin(CommandRuntime);
    await h.ctx.plugin(ClientModules);
    const yaml = createRequire(
      import.meta.resolve("@deepseek-ai/cordis-plugin-include"),
    )("js-yaml");
    const patches = yaml.load(
      readFileSync(new URL("../../cordis.patch.yml", import.meta.url), "utf8"),
      { schema: entryListSchema },
    );
    const entries = applyEntryPatches([], patches, (message) => {
      throw new Error(message);
    });
    expect(entries[0]!.name).toBe("dsh-stock-research");
    entries[0]!.config = { runtime: h.config({ enabledSources: [] }) };
    await h.ctx.loader.root.update(entries);
    await h.ctx.loader.await();
    const graph = h.ctx.clientModules.graph();
    const row = graph.entries.find(({ id }) => id === "dsh-stock-research");
    expect(row).toMatchObject({
      inject: [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-api-job-controller",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-chat",
      ],
    });
    const batch = graph.batches.find(({ entries }) =>
      entries.includes("dsh-stock-research"),
    )!;
    expect(batch).toBeDefined();
    const response = await h.ctx.clientModules.fetchBundle(
      new Request(new URL(batch.url, "http://fixture/")),
    );
    expect(response.status).toBe(200);
    const load = vi.fn();
    vm.runInNewContext(await response.text(), {
      window: { __ModuleLoader__: { load } },
    });
    expect(load).toHaveBeenCalledOnce();
    const entry = load.mock.calls[0]![0] as {
      id: string;
      factory: (require: ReturnType<typeof createRequire>) => {
        inject: string[];
        apply(ctx: Context): void;
      };
    };
    expect(entry.id).toBe("dsh-stock-research");
    const client = entry.factory(createRequire(import.meta.url));
    const form = {};
    const catalog = { groups: [] };
    const modelCatalog = vi.fn(async () => ({ ok: true, value: catalog }));
    const execute = vi.fn(async () => ({
      ok: true,
      value: { result: { kind: "success", text: "研究已取消" } },
    }));
    const unregister = vi.fn();
    const unregisterCard = vi.fn();
    const unregisterEvents = vi.fn();
    const registerEvents = vi.fn(() => unregisterEvents);
    const register = vi.fn<
      (options: unknown, component: unknown) => () => void
    >((options) =>
      (options as { name: string }).name === "settings.section"
        ? unregister
        : unregisterCard,
    );
    const configForms = {
      get: vi.fn(() => form),
      whileServed: vi.fn((_names: string[], callback: () => () => void) =>
        callback(),
      ),
    };
    const ctx = new Context();
    class FixtureSlots extends Service {
      constructor(services: Context) {
        super(services, "slots");
      }
      register = register;
      inject(_name: string, callback: () => () => void) {
        return this.ctx.effect(callback);
      }
    }
    cleanups.push(() => ctx.fiber.dispose());
    await ctx.plugin({
      apply(services: Context) {
        services.provide("remote", {
          session: { modelCatalog },
          commands: { execute },
        });
        services.provide("configForms", configForms);
        services.provide("jobs", {});
        services.provide("uiConversation", {
          events: { register: registerEvents },
        });
        new FixtureSlots(services);
      },
    });
    const clientFiber = ctx.plugin(client);
    await clientFiber;
    expect(register).not.toHaveBeenCalled();
    ctx.provide("remote.session", {});
    await clientFiber;
    expect(register).not.toHaveBeenCalled();
    ctx.provide("remote.commands", {});
    await clientFiber;
    expect(configForms.get).toHaveBeenCalledWith("stock-research");
    const registration = register.mock.calls.find(
      ([options]) => (options as { name: string }).name === "settings.section",
    )![0] as unknown as {
      name: string;
      id: string;
      inject(): { form: object; loadCatalog(): Promise<object> };
    };
    expect(registration).toMatchObject({
      name: "settings.section",
      id: "stock-research",
    });
    expect(registration.inject().form).toBe(form);
    expect(await registration.inject().loadCatalog()).toBe(catalog);
    expect(modelCatalog).toHaveBeenCalledOnce();
    expect(registerEvents).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stock-research-job", target: "chat" }),
    );
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "conversation.chat.node",
        key: "stock-research-job",
      }),
      expect.any(Function),
    );
    const renderer = register.mock.calls.find(
      ([options]) =>
        (options as { name: string }).name === "conversation.chat.node",
    )![1] as (props: unknown) => {
      props: { cancelRun(sessionId: SessionId, runId: string): Promise<void> };
    };
    const card = renderer({
      node: { data: {} },
      taskSessionId: SessionId("task-session"),
    });
    await card.props.cancelRun(SessionId("task-session"), "run-fixture");
    expect(execute).toHaveBeenCalledWith(
      "task-session",
      "/stock-cancel run-fixture",
      [],
    );
    execute.mockResolvedValueOnce({
      ok: true,
      value: { result: { kind: "error", text: "运行无法取消" } },
    });
    await expect(
      card.props.cancelRun(SessionId("task-session"), "run-fixture"),
    ).rejects.toThrow("运行无法取消");
    await clientFiber.dispose();
    expect(unregister).toHaveBeenCalledOnce();
    expect(unregisterEvents).toHaveBeenCalledOnce();
    expect(unregisterCard).toHaveBeenCalledOnce();
  });
});

import type { Context } from "@deepseek-ai/cordis";
import fs from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-settings";
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import z from "@deepseek-ai/schemastery";
import { ResearchError } from "./contracts/errors.js";
import { Config as RuntimeConfig, type ResearchConfig } from "./host/config.js";
import { createResearchPlugin } from "./host/runtime.js";
import * as Ask from "./app/ask.js";
import * as Quick from "./app/quick.js";
import * as Review from "./app/review.js";
import { ModelConfig } from "./app/model-config.js";
import { prepareResearchRole } from "./app/prepare-role.js";
import {
  beginCleanup,
  isApplicationBusy,
  withActivity,
} from "./app/activity.js";
import type { ResearchSettings } from "./app/settings.js";
import { DataRoot } from "./storage/data-root.js";
import { PUBLIC_SEARCH_LIMITS } from "./app/public-research.js";

export interface ApplicationConfig {
  runtime: ResearchConfig;
  model?: ModelConfig;
  publicSearchLimit?: number;
}
export const Configuration = z
  .transform(
    z
      .object({
        runtime: RuntimeConfig,
        model: ModelConfig.required(false),
        publicSearchLimit: z
          .natural()
          .max(Number.MAX_SAFE_INTEGER)
          .default(PUBLIC_SEARCH_LIMITS.maxSearches),
      })
      .required(),
    (value): ApplicationConfig => {
      if (
        Object.keys(value).some(
          (key) =>
            key !== "runtime" && key !== "model" && key !== "publicSearchLimit",
        )
      )
        throw new ResearchError(
          "INVALID_INPUT",
          "Unknown research application configuration field.",
        );
      return value as ApplicationConfig;
    },
  )
  .required();
// Browser forms validate the data shape; contextual checks run at the Host boundary.
function formSchema(schema: z): z {
  if (schema.type === "transform") {
    const inner = formSchema(schema.inner!);
    inner.meta = { ...inner.meta, ...schema.meta };
    if (!Object.hasOwn(schema.meta, "default")) delete inner.meta.default;
    return inner;
  }
  return new z({
    ...schema,
    meta: { ...schema.meta },
    ...(schema.dict
      ? {
          dict: Object.fromEntries(
            Object.entries(schema.dict).map(([key, child]) => [
              key,
              formSchema(child),
            ]),
          ),
        }
      : {}),
    ...(schema.inner ? { inner: formSchema(schema.inner) } : {}),
    ...(schema.sKey ? { sKey: formSchema(schema.sKey) } : {}),
    ...(schema.list ? { list: schema.list.map(formSchema) } : {}),
  });
}
export const Config = formSchema(Configuration).volatile();

export const name = "stock-research-application";
export const inject = [
  "tools",
  "agents",
  "llm",
  "subagents",
  "commands",
  "systemPrompt",
  "jobs",
];
export async function apply(
  ctx: Context,
  configuration: { get(): ApplicationConfig },
): Promise<void> {
  await ctx.effect(async function* () {
    let applied = Configuration(structuredClone(configuration.get()));
    let switching: Promise<void> | undefined;
    let closed = false;
    const createRuntime = (config: ApplicationConfig) => {
      const plugin = createResearchPlugin((context, parent) =>
        prepareResearchRole(runtime.ctx.stockResearch, context, parent),
      );
      if (config.runtime.enabledSources.includes("dsh-web"))
        plugin.inject.push("web");
      return ctx.plugin(plugin, config.runtime);
    };
    let runtime = createRuntime(applied);
    yield () => runtime.dispose();
    await runtime;
    let quick = ctx.plugin(Quick);
    yield () => quick.dispose();
    await quick;
    let ask = ctx.plugin(Ask);
    yield () => ask.dispose();
    await ask;
    let review = ctx.plugin(Review);
    yield () => review.dispose();
    await review;
    async function replaceResources(next: ApplicationConfig) {
      await review.dispose();
      await ask.dispose();
      await quick.dispose();
      await runtime.dispose();
      if (closed)
        throw new ResearchError(
          "ACCESS_DENIED",
          "Research application is closed.",
        );
      runtime = createRuntime(next);
      await runtime;
      quick = ctx.plugin(Quick);
      await quick;
      ask = ctx.plugin(Ask);
      await ask;
      review = ctx.plugin(Review);
      await review;
      applied = next;
    }
    async function reopen(next: ApplicationConfig) {
      const previous = applied;
      try {
        await replaceResources(next);
      } catch (error) {
        if (closed) throw error;
        try {
          await replaceResources(previous);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Research resource initialization failed, and the previous resources could not be restored.",
            { cause: recoveryError },
          );
        }
        throw error;
      }
    }
    async function prepare(
      invocation: Pick<CommandInvocation, "signal">,
    ): Promise<boolean> {
      invocation.signal.throwIfAborted();
      const next = structuredClone(configuration.get());
      if (
        switching === undefined &&
        isDeepStrictEqual(next.runtime, applied.runtime)
      )
        return false;
      if (switching === undefined) {
        if (isApplicationBusy(runtime.ctx.stockResearch))
          throw new ResearchError(
            "ACCESS_DENIED",
            "Research is running. Resource configuration cannot be applied until it finishes.",
          );
        switching = reopen(next).finally(() => {
          switching = undefined;
        });
      }
      await switching;
      invocation.signal.throwIfAborted();
      return true;
    }
    const settings: ResearchSettings = {
      get model() {
        return configuration.get().model;
      },
      get publicSearchLimit() {
        return (
          configuration.get().publicSearchLimit ??
          PUBLIC_SEARCH_LIMITS.maxSearches
        );
      },
      async runTool(name, value, exec, run) {
        if (await prepare(exec))
          return ctx.tools.get(name, exec.agent)!.execute(value, exec);
        return withActivity(runtime.ctx.stockResearch, run);
      },
      async runCommand(name, invocation, run) {
        if (await prepare(invocation))
          return ctx.commands.find(invocation.agent, name)!.handler(invocation);
        return withActivity(runtime.ctx.stockResearch, run);
      },
    };
    yield ctx.provide("stockResearchSettings", settings);
    yield ctx.on("internal/config", function (raw, next) {
      const value = next();
      if (this !== ctx.fiber) return value;
      const candidate = Configuration(interpolate(ctx, structuredClone(value)));
      if (
        !isDeepStrictEqual(candidate.runtime, configuration.get().runtime) &&
        (switching !== undefined ||
          isApplicationBusy(runtime.ctx.stockResearch))
      )
        throw new ResearchError(
          "ACCESS_DENIED",
          "Research is running. Finish the research before saving resource configuration.",
        );
      if (
        candidate.runtime.enabledSources.includes("dsh-web") &&
        ctx.get("web") === undefined
      )
        throw new ResearchError(
          "SOURCE_UNAVAILABLE",
          "Public search requires the host web service.",
        );
      return value;
    });
    const settingsFiber = ctx.inject(["settings"], (settingsCtx) => {
      settingsCtx.effect(() =>
        settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      );
    });
    yield () => settingsFiber.dispose();
    let cleaning = false;
    yield ctx.commands.register({
      name: "stock-gc",
      description: "清理全部股票研究缓存和数据。",
      input: { hint: "all" },
      handler: async (invocation) => {
        if (invocation.rawInput.trim() !== "all")
          throw new ResearchError("INVALID_INPUT", "Usage: /stock-gc all");
        invocation.signal.throwIfAborted();
        await prepare(invocation);
        if (cleaning)
          throw new ResearchError(
            "ACCESS_DENIED",
            "Stock research is being cleaned.",
          );
        beginCleanup(runtime.ctx.stockResearch);
        cleaning = true;
        try {
          await review.dispose();
          await ask.dispose();
          await quick.dispose();
          await runtime.dispose();
          try {
            const root = new DataRoot(applied.runtime.dataRoot);
            try {
              for (const name of [
                "cache.sqlite",
                "cache.sqlite-wal",
                "cache.sqlite-shm",
                "cache.sqlite-journal",
                "runs",
                "memory",
                "drafts",
                "reviews",
              ])
                fs.rmSync(join(root.path, name), {
                  recursive: true,
                  force: true,
                });
            } finally {
              root.close();
            }
          } finally {
            await reopen(structuredClone(configuration.get()));
          }
        } finally {
          cleaning = false;
        }
        return { kind: "success", text: "已清理全部股票研究缓存和数据。" };
      },
    });
    yield async () => {
      closed = true;
      await switching;
    };
  });
}

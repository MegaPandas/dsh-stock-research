import fs from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { WebSearchProvider } from "@deepseek-ai/dsh-web";
import { vi } from "vitest";
import * as Ask from "../../src/ask.js";
import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type { ResearchScope } from "../../src/contracts/data.js";
import type { CollectionService } from "../../src/services/collection.js";
import type { SourceId } from "../../src/runtime.js";
import { runtimeHost } from "./runtime-host.js";
import { toolCall } from "./quick-host.js";

/** Artificial source data used to isolate collection from the real ask application. */
export function askCollection(scope: ResearchScope): CollectionSnapshot {
  return {
    schemaVersion: 1,
    scope: structuredClone(scope),
    packets: [
      {
        id: "market.daily",
        envelope: {
          dataset: "market",
          data: {
            table: "market.daily",
            title: "人工日线固定样本",
            columns: {
              close: { label: "收盘价", unit: "CNY/share", price: true },
              volume: { label: "成交量", unit: "shares" },
            },
            currency: "CNY",
            adjustment: "unadjusted",
            interval: "1d",
            rows: [
              {
                date: "2024-01-02",
                asOf: "2024-01-02T07:30:00.000Z",
                availableAt: null,
                complete: true,
                values: { close: 81, volume: 1000 },
              },
              {
                date: "2024-01-03",
                asOf: "2024-01-03T07:30:00.000Z",
                availableAt: null,
                complete: true,
                values: { close: 82, volume: 2000 },
              },
            ],
          },
          source: {
            provider: "fixture",
            url: "https://example.com/fixture/byd-daily",
            adapterVersion: "1",
            normalizationVersion: "1",
          },
          asOf: "2024-01-03T07:30:00.000Z",
          availableAt: null,
          retrievedAt: "2024-01-03T07:31:00.000Z",
          cutoff: scope.cutoff,
          ageMs:
            Date.parse(scope.cutoff) - Date.parse("2024-01-03T07:30:00.000Z"),
          stale: false,
          historicalKnowledge: "unverified",
          gaps: [
            {
              code: "unverified_time",
              field: "/data/rows",
              detail:
                "Artificial source does not establish original publication times.",
            },
          ],
        },
      },
    ],
    failures: [
      {
        id: "macro.cpi",
        provider: "fixture",
        code: "SOURCE_UNAVAILABLE",
        detail: "Artificial macro source is unavailable.",
      },
    ],
  };
}

export async function askHost(
  options: {
    respond?: (request: GenerateOptions) => AsyncIterable<StreamChunk>;
    search?: WebSearchProvider["search"];
    enabledSources?: SourceId[];
    collect?: CollectionService["collect"] | "runtime";
  } = {},
) {
  const h = await runtimeHost(options);
  try {
    const mounted = await h.mount(
      h.config({
        enabledSources:
          options.enabledSources ??
          (options.search === undefined ? [] : ["dsh-web"]),
      }),
    );
    const collection = vi.spyOn(mounted.runtime.collection, "collect");
    if (options.collect !== "runtime")
      collection.mockImplementation(
        options.collect ?? (async (scope) => askCollection(scope)),
      );
    await h.ctx.plugin(CommandRuntime);
    h.ctx.commands.register({
      name: "host-ping",
      description: "Existing host command",
      handler: () => ({ kind: "success", text: "pong" }),
    });
    const created: Agent[] = [];
    h.ctx.on("agent/created", ({ agent }) => {
      created.push(agent);
      return undefined;
    });
    async function mountAsk() {
      const fiber = h.ctx.plugin(Ask, {
        provider: "runtime-fixture",
        model: "ask",
      });
      await fiber;
      return fiber;
    }
    const askFiber = await mountAsk();
    function execute(
      line = "/stock-ask SZ.002594 2024-01-03 请核实资料并说明时间限制",
      signal = new AbortController().signal,
    ) {
      return h.ctx.commands.execute(h.outside.agent, line, [], signal);
    }
    function researchState() {
      return {
        runs: fs
          .readdirSync(join(h.directory, "runs"), { recursive: true })
          .sort(),
        memory: fs.readFileSync(
          join(h.directory, "memory", "index.json"),
          "utf8",
        ),
      };
    }
    const adapter: { readonly requests: GenerateOptions[] } = h.adapter;
    return {
      ...h,
      adapter,
      runtime: mounted.runtime,
      runtimeFiber: mounted.fiber,
      askFiber,
      mountAsk,
      execute,
      created,
      researchState,
      collection,
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}

export function askAnswerResponse(summary: string): AsyncIterable<StreamChunk> {
  return toolCall("stock_submit", {
    summary,
    content: { explanation: [], limitations: [] },
  });
}

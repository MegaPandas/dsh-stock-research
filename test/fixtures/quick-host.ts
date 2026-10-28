import fs from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type {
  CommandExecution,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import * as Quick from "../../src/quick.js";
import { prepareResearchRole } from "../../src/app/prepare-role.js";
import { createResearchPlugin } from "../../src/runtime.js";
import { runtimeHost } from "./runtime-host.js";

export async function* toolCall(
  name: string,
  value: unknown,
  callId = name,
): AsyncIterable<StreamChunk> {
  const id = ToolCallId(callId);
  const args = JSON.stringify(value);
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: args };
  yield {
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id, name, arguments: args },
  };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
export function initialInput<T>(request: GenerateOptions): T {
  const message = request.messages.find((message) => message.role === "user")!;
  const block = message.content.find((block) => block.type === "text")!;
  if (block.type !== "text") throw new Error("Expected application input");
  return JSON.parse(block.text);
}
export function lastToolText(request: GenerateOptions): string {
  const message = request.messages
    .filter((message) => message.role === "tool")
    .at(-1)!;
  const block = message.content.find((block) => block.type === "text")!;
  if (block.type !== "text") throw new Error("Expected canonical tool result");
  return block.text;
}
export function lastToolResult<T>(request: GenerateOptions): T {
  return JSON.parse(lastToolText(request));
}

/** Keep command acknowledgement and background completion separate in fixtures. */
export function researchCommands(ctx: Context, agent: Agent) {
  const results: { runId?: string; result: CommandResult }[] = [];
  const activities: { runId?: string }[] = [];
  const failures: unknown[] = [];
  const toolFailures: string[] = [];
  const commands = new Map<
    string,
    {
      line: string;
      results: number;
      activities: number;
      failures: number;
      toolFailures: number;
    }
  >();
  ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    if (event.type === "tool/result" && event.data.message.isError)
      toolFailures.push(
        event.data.error?.reason ??
          event.data.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
      );
    if (event.type === "tool/result" && !event.data.message.isError)
      for (const block of event.data.message.content) {
        if (block.type !== "text") continue;
        let value: unknown;
        try {
          value = JSON.parse(block.text);
        } catch {
          continue;
        }
        if (
          typeof value === "object" &&
          value !== null &&
          "runId" in value &&
          typeof value.runId === "string"
        )
          activities.push({ runId: value.runId });
      }
    if (event.type === "stock-research/activity") activities.push(event.data);
    if (event.type === "stock-research/result")
      results.push({
        ...(event.data.runId === undefined ? {} : { runId: event.data.runId }),
        result: { kind: event.data.outcome, text: event.data.text },
      });
  });
  ctx.on("agent/error", ({ agent: subject, error }) => {
    if (subject === agent) failures.push(error);
  });
  async function execute(
    line = "/stock-quick SZ.002594 2024-01-03",
    signal = new AbortController().signal,
  ) {
    const offset = {
      line,
      results: results.length,
      activities: activities.length,
      failures: failures.length,
      toolFailures: toolFailures.length,
    };
    const execution = await ctx.commands.execute(agent, line, [], signal);
    if (execution !== undefined) commands.set(execution.commandId, offset);
    return execution;
  }
  async function waitForResearch(execution: CommandExecution | undefined) {
    if (execution === undefined) return undefined;
    if (execution.result.kind === "error") return execution;
    const offset = commands.get(execution.commandId)!;
    if (!/^\/stock-(quick|deep|resume|redo|replay)(?:\s|$)/.test(offset.line))
      return execution;
    await agent.whenIdle();
    const failure = failures.at(-1);
    if (failures.length > offset.failures)
      return {
        ...execution,
        result: {
          kind: "error" as const,
          text: failure instanceof Error ? failure.message : String(failure),
        },
      };
    const result = results.slice(offset.results).at(-1);
    const runId =
      result?.runId ??
      activities
        .slice(offset.activities)
        .findLast((activity) => activity.runId !== undefined)?.runId;
    if (runId === undefined)
      return {
        ...execution,
        result: result?.result ?? {
          kind: "error" as const,
          text:
            toolFailures.length > offset.toolFailures
              ? toolFailures.at(-1)!
              : "主Agent尚未创建正式研究运行。",
        },
      };
    const view = ctx.stockResearch.runs.view({ runId });
    if (view.status !== "completed")
      return {
        ...execution,
        result: {
          kind: "error" as const,
          text: [
            `运行 ${runId} 未完成。`,
            ...view.blockReasons.map(
              ({ id, code, message }) => `${id}: ${code}: ${message}`,
            ),
            ...view.tasks
              .filter(({ failure }) => failure !== null)
              .map(({ failure }) => `${failure!.code}: ${failure!.message}`),
          ].join("\n"),
        },
      };
    const report = view.tasks
      .find(({ taskId }) => taskId === "finalize")!
      .outputRefs.map((ref) => ctx.stockResearch.runs.readArtifact(ref).content)
      .find(({ kind }) => kind === "report")!;
    return {
      ...execution,
      result: {
        kind: "success" as const,
        text: `运行 ${runId} 已完成。\n\n${report.body}`,
      },
    };
  }
  async function executeAndWait(line?: string, signal?: AbortSignal) {
    return waitForResearch(await execute(line, signal));
  }
  return { execute, executeAndWait, waitForResearch };
}
export async function quickHost(
  respond: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  setupHost?: (host: Awaited<ReturnType<typeof runtimeHost>>) => Promise<void>,
) {
  const h = await runtimeHost({ respond });
  try {
    await setupHost?.(h);
    await h.ctx.plugin(
      createResearchPlugin((context, parent) =>
        prepareResearchRole(h.ctx.stockResearch, context, parent),
      ),
      h.config({
        enabledSources: ["tencent"],
        http: { ...h.config().http, minIntervalMs: 0 },
        policy: {
          freshness: { market: 86_400_000, fundamentals: 0, macro: 0 },
          secCiks: {},
        },
      }),
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
    const quickFiber = h.ctx.plugin(Quick, {
      provider: "runtime-fixture",
      model: "quick",
    });
    await quickFiber;
    const commands = researchCommands(h.ctx, h.outside.agent);
    function runFiles() {
      return fs
        .readdirSync(join(h.directory, "runs"), {
          recursive: true,
          encoding: "utf8",
        })
        .sort();
    }
    const adapter: { readonly requests: GenerateOptions[] } = h.adapter;
    return {
      directory: h.directory,
      ctx: h.ctx,
      outside: h.outside,
      runtime: h.ctx.stockResearch,
      adapter,
      quickFiber,
      created,
      ...commands,
      runFiles,
      agentOptions: h.agentOptions,
      close: h.close,
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}

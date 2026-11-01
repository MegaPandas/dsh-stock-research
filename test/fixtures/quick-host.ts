import fs from "node:fs";
import { join } from "node:path";
import { JobId } from "@deepseek-ai/dsh-jobs";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type { CommandExecution } from "@deepseek-ai/dsh-commands";
import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import * as Quick from "../../src/quick.js";
import { prepareResearchRole } from "../../src/app/role-preparation/index.js";
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
  const activities: { runId?: string; jobId?: string }[] = [];
  const notices: { runId?: string; jobId: string; notice: string }[] = [];
  let wake!: () => void;
  let changed!: Promise<void>;
  function resetWake() {
    changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  resetWake();
  const notify = () => {
    wake();
    resetWake();
  };
  ctx.effect(() => ctx.jobs.events.subscribe({ owner: agent.id }, notify));
  const failures: unknown[] = [];
  const toolFailures: string[] = [];
  const commands = new Map<
    string,
    {
      line: string;
      activities: number;
      notices: number;
      failures: number;
      toolFailures: number;
    }
  >();
  ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    notify();
    if (
      event.type === "job/registered" &&
      ["stock-research", "stock-research-step"].includes(event.data.kind)
    )
      activities.push({ jobId: event.data.jobId });
    if (
      event.type === "user/message" &&
      event.data.source?.kind === "stock-research"
    ) {
      const text = event.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const marker = "Research request: ";
      const notice = JSON.parse(
        text.slice(text.lastIndexOf(marker) + marker.length),
      ) as { runId?: string; jobId: string; notice: string };
      notice.notice = (event.data.source as { notice: string }).notice;
      notices.push(notice);
      activities.push(notice);
    }
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
        if (typeof value === "object" && value !== null) {
          const result = value as {
            runId?: string;
            jobId?: string;
            context?: { runId: string };
            view?: { runId: string };
            handle?: { jobId: string };
          };
          activities.push({
            runId: result.runId ?? result.context?.runId ?? result.view?.runId,
            jobId: result.jobId ?? result.handle?.jobId,
          });
        }
      }
  });
  ctx.on("agent/error", ({ agent: subject, error }) => {
    if (subject === agent) {
      failures.push(error);
      notify();
    }
  });
  async function execute(
    line = "/stock-quick SZ.002594 2024-01-03",
    signal = new AbortController().signal,
  ) {
    const offset = {
      line,
      activities: activities.length,
      notices: notices.length,
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
    return { ...execution, result: await waitForResearchCompletion(offset) };
  }
  async function waitForResearchCompletion(
    offset = { activities: 0, notices: 0, failures: 0, toolFailures: 0 },
  ) {
    let releaseRun: (() => void) | undefined;
    let observedRun: string | undefined;
    let observedJob: ReturnType<typeof ctx.jobs.get> | undefined;
    try {
      while (true) {
        const next = changed;
        await agent.whenIdle();
        const recent = activities.slice(offset.activities);
        const runId = recent.findLast(
          (activity) => activity.runId !== undefined,
        )?.runId;
        if (runId !== undefined && runId !== observedRun) {
          releaseRun?.();
          observedRun = runId;
          releaseRun = ctx.stockResearch.runs.subscribe(runId, notify);
        }
        const view =
          runId === undefined
            ? undefined
            : ctx.stockResearch.runs.view({ runId });
        const jobId = recent.find(
          (activity) => activity.jobId !== undefined,
        )?.jobId;
        const job =
          jobId === undefined
            ? undefined
            : ctx.jobs.get(JobId(jobId), agent.id);
        observedJob = job;
        const notice = notices
          .slice(offset.notices)
          .findLast(
            (notice) =>
              notice.jobId === jobId ||
              (runId !== undefined && notice.runId === runId),
          );
        const failedNotice =
          notice?.notice === "failed" || notice?.notice === "blocked";
        const waitingReview =
          notice?.notice === "review" &&
          view?.stages?.some(
            (stage) => stage.readyForReview && !stage.accepted,
          );
        const failed =
          view !== undefined &&
          ((view.status !== "active" && view.status !== "completed") ||
            view.tasks.some(({ status }) => status === "failed") ||
            view.blockReasons.length > 0);
        if (
          agent.status === "idle" &&
          (failures.length > offset.failures ||
            toolFailures.length > offset.toolFailures ||
            (failedNotice &&
              (failed ||
                job?.status === "failed" ||
                job?.status === "killed")) ||
            (view?.status === "completed" &&
              job?.status === "completed" &&
              notice?.notice === "completed") ||
            (view?.status === "cancelled" && job?.status === "killed") ||
            job?.status === "killed" ||
            job?.status === "failed" ||
            waitingReview)
        )
          break;
        if (job === undefined && agent.status === "idle") break;
        await next;
      }
    } finally {
      releaseRun?.();
    }
    const failure = failures.at(-1);
    if (failures.length > offset.failures)
      return {
        kind: "error" as const,
        text: failure instanceof Error ? failure.message : String(failure),
      };
    if (toolFailures.length > offset.toolFailures)
      return { kind: "error" as const, text: toolFailures.at(-1)! };
    const runId = activities
      .slice(offset.activities)
      .findLast((activity) => activity.runId !== undefined)?.runId;
    if (runId === undefined)
      return {
        kind: "error" as const,
        text: observedJob?.detail ?? "主Agent尚未创建正式研究运行。",
      };
    const view = ctx.stockResearch.runs.view({ runId });
    if (observedJob?.status === "failed")
      return {
        kind: "error" as const,
        text: observedJob.detail ?? "后台研究执行失败。",
      };
    if (view.status !== "completed")
      return {
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
      };
    const report = view.tasks
      .find(({ taskId }) => taskId === "finalize")!
      .outputRefs.map((ref) => ctx.stockResearch.runs.readArtifact(ref).content)
      .find(({ kind }) => kind === "report")!;
    return {
      kind: "success" as const,
      text: `运行 ${runId} 已完成。\n\n${report.body}`,
    };
  }
  async function executeAndWait(line?: string, signal?: AbortSignal) {
    return waitForResearch(await execute(line, signal));
  }
  return {
    execute,
    executeAndWait,
    waitForResearch,
    waitForResearchCompletion,
  };
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

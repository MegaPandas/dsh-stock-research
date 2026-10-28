import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  CommandInvocation,
  CommandResult,
} from "@deepseek-ai/dsh-commands";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { JobHandle, JobId, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { RunDefinition } from "../contracts/workflow.js";
import type { RunView } from "../contracts/runs.js";
import type { AgentReport } from "../contracts/agent-reports.js";
import { ResearchError } from "../contracts/errors.js";
import { serializeJson } from "../cache/json.js";
import { researchTool } from "../tools/errors.js";
import {
  artifactRef,
  artifactRefSchema,
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";
import {
  parseResearchInput,
  researchCutoff,
  securityFor,
  scopeAtDate,
} from "./ask-input.js";
import {
  attachCollection,
  requireCollectionData,
  readCollection,
} from "./collection-input.js";
import { COORDINATOR_PROMPT } from "./coordinator-prompt.js";
import { savedCoordinator } from "./coordinator-input.js";
import { createQuickInput } from "./quick-plan.js";
import { createDeepInput } from "./deep-plan.js";
import { attachResearchStages } from "./research-stages.js";
import {
  captureResearchModels,
  RESEARCH_MODELS_INPUT,
} from "./research-models.js";
import { ModelConfig } from "./model-config.js";
import { holdActivity, withActivity } from "./activity.js";
import { runApplicationCommand, runApplicationTool } from "./settings.js";
import {
  parseRunCommand,
  parseRunControl,
  runControlParameters,
  type RunCommand,
  type RunCommandKind,
  type ResearchControlKind,
} from "./run-command-input.js";
import { createReplayInput } from "./replay-input.js";
import { runStatus } from "./run-view.js";
import {
  collectionProgress,
  researchProgress,
  failureDetail,
} from "./research-progress.js";
import { PUBLIC_SEARCH_LIMITS } from "./public-research.js";
import {
  RESEARCH_JOB_KIND,
  RESEARCH_STEP_JOB_KIND,
  type ResearchActivity,
} from "./research-job.js";

const JOB_WAIT_MS = 60_000;
const MANAGED_TOOLS = new Set([
  "stock_dispatch_task",
  "stock_dispatch_stage",
  "stock_followup_task",
  "stock_make_digest",
  "stock_decide",
  "stock_redo_task",
]);
interface ResearchExecution {
  owner: Agent;
  job: JobHandle;
  completion: {
    promise: Promise<JobOutcome>;
    resolve(outcome: JobOutcome): void;
  };
  progress?: string;
  finishedAt?: number;
  runId?: string;
  preparationStatus: "preparing" | "failed" | "cancelled";
  release: () => void;
  resourcesReleased: boolean;
  operations: Map<
    JobId,
    { controller: AbortController; work: Promise<unknown> }
  >;
}

function researchCompletion(): ResearchExecution["completion"] {
  let resolve!: (outcome: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The receiving host Agent drives every transition through individual tools. */
class ResearchApplication {
  readonly #coordinators = new Map<Agent, (() => void)[]>();
  readonly #executions = new Set<ResearchExecution>();
  readonly #runs = new Map<string, ResearchExecution>();
  readonly #starts = new Map<
    string,
    { owner: Agent; request: string; work: Promise<unknown> }
  >();
  readonly #disposing = new Map<Agent, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  constructor(
    private readonly ctx: Context,
    private readonly model?: ModelConfig,
  ) {}

  #main(agent: Agent | undefined): Agent {
    if (this.#closed)
      throw new ResearchError("ACCESS_DENIED", "Stock research is closed.");
    if (agent === undefined || this.ctx.agents.get(agent.id) !== agent)
      throw new ResearchError(
        "ACCESS_DENIED",
        "A live host Agent is required.",
      );
    if (!this.#coordinators.has(agent)) {
      const releases = [this.ctx.stockResearch.bindCoordinator(agent)];
      this.#coordinators.set(agent, releases);
      for (const tool of this.ctx.stockResearch.tools) {
        if (tool.name === "stock_read_run") {
          releases.push(
            agent.ctx.tools.register({
              ...tool,
              output: resultOutput(opaqueObjectSchema),
              execute: async (value, exec) => {
                const result = (await tool.execute(value, exec)) as {
                  kind: string;
                  view?: RunView;
                };
                if (result.kind !== "run_view") return result;
                return {
                  ...result,
                  reportCatalog: result.view!.tasks.flatMap(({ outputRefs }) =>
                    outputRefs.map((ref) => {
                      const artifact =
                        this.ctx.stockResearch.runs.readArtifact(ref);
                      const report = artifact.content.payload.report as
                        AgentReport | undefined;
                      return {
                        ref,
                        taskId: artifact.taskId,
                        kind: artifact.content.kind,
                        title: artifact.content.title,
                        summary: report?.summary ?? null,
                      };
                    }),
                  ),
                };
              },
            }),
          );
          continue;
        }
        if (!MANAGED_TOOLS.has(tool.name)) continue;
        releases.push(
          agent.ctx.tools.register(
            researchTool({
              ...tool,
              execute: async (value, exec) => {
                const runId = text(
                  (value as Record<string, unknown>)?.runId,
                  "runId",
                );
                const research = this.#owned(exec.agent, runId);
                return runApplicationTool(
                  this.ctx,
                  tool.name,
                  value,
                  exec,
                  () =>
                    research.finishedAt !== undefined
                      ? tool.execute(value, exec)
                      : this.#perform(
                          agent,
                          research,
                          tool.name,
                          exec.signal,
                          (_research, _job, signal) =>
                            tool.execute(value, { ...exec, signal }),
                        ),
                );
              },
            }),
          ),
        );
      }
    }
    return agent;
  }

  #owned(agent: Agent | undefined, runId: string): ResearchExecution {
    this.#main(agent);
    const research = this.#runs.get(runId);
    if (research === undefined || research.owner !== agent)
      throw new ResearchError(
        "ACCESS_DENIED",
        "This research is not attached to the current chat. Use an explicit resume request.",
      );
    return research;
  }

  start(value: unknown, exec: ToolRunContext): Promise<unknown> {
    const item = object(value, ["security", "date", "mode", "requestId"]);
    const owner = this.#main(exec.agent);
    const security = securityFor(text(item.security, "security"));
    const now = new Date();
    const date =
      item.date === undefined
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: security.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(now)
        : text(item.date, "date");
    if (item.mode !== "quick" && item.mode !== "deep")
      throw new ResearchError("INVALID_INPUT", "mode must be quick or deep.");
    const mode = item.mode;
    const scope = scopeAtDate(security, date, now);
    const requestId = text(item.requestId, "requestId");
    const request = serializeJson({ security: security.id, date, mode });
    const key = JSON.stringify([owner.id, requestId]);
    const existing = this.#starts.get(key);
    if (existing !== undefined) {
      if (existing.request !== request)
        throw new ResearchError(
          "REQUEST_CONFLICT",
          "The research request ID was already used for another selection.",
        );
      return existing.work;
    }
    const settings = this.ctx.get("stockResearchSettings");
    const models = captureResearchModels(
      owner,
      this.model ?? settings?.model,
      settings?.digestFor(owner),
    );
    const publicSearchLimit =
      settings?.publicSearchLimit ?? PUBLIC_SEARCH_LIMITS.maxSearches;
    const runtime = this.ctx.stockResearch;
    const policy = runtime.policy;
    const sources = runtime.queries.health(scope).sources;
    const label = `${security.symbol} · ${mode === "quick" ? "快速研究" : "深度研究"} · ${date}`;
    const work = this.#perform(
      owner,
      undefined,
      label,
      exec.signal,
      async (research, job, signal) => {
        const collection = await runtime.collection.collect(
          scope,
          signal,
          (progress) => {
            const line = collectionProgress(progress);
            job.updateProgress(line);
            job.append(`${line}\n`, { channel: "log" });
            if (progress.recordPath !== undefined)
              job.append(`采集记录：${progress.recordPath}\n`, {
                channel: "log",
              });
            for (const failure of progress.failures ?? [])
              job.append(
                `${failure.id} · ${failure.provider} · ${failure.code}: ${failure.detail}\n`,
                { channel: "log" },
              );
          },
        );
        requireCollectionData(collection);
        signal.throwIfAborted();
        const fixedScope = {
          ...scope,
          cutoff: researchCutoff(scope, new Date()),
        };
        runtime.collection.finalizeScope(collection, fixedScope);
        const input = attachResearchStages(
          attachCollection(
            (mode === "quick" ? createQuickInput : createDeepInput)(
              fixedScope,
              policy,
              sources,
              [],
              publicSearchLimit,
            ),
            collection,
          ),
        );
        input.inputs = [
          ...(input.inputs ?? []),
          {
            name: RESEARCH_MODELS_INPUT,
            content: JSON.parse(serializeJson(models)),
          },
        ];
        const view = runtime.openRun(owner, input, requestId);
        research.runId = view.runId;
        this.#runs.set(view.runId, research);
        return this.#context(view.runId);
      },
    );
    this.#starts.set(key, { owner, request, work });
    return work;
  }

  review(value: unknown, exec: ToolRunContext): unknown {
    const item = object(value, [
      "runId",
      "stageId",
      "verdict",
      "feedback",
      "refs",
      "requestId",
    ]);
    const runId = text(item.runId, "runId");
    const research = this.#owned(exec.agent, runId);
    if (item.verdict !== "accepted" && item.verdict !== "rejected")
      throw new ResearchError(
        "INVALID_INPUT",
        "verdict must be accepted or rejected.",
      );
    if (!Array.isArray(item.refs))
      throw new ResearchError("INVALID_INPUT", "refs requires an array.");
    this.ctx.stockResearch.runs.reviewStage(
      { runId, identity: research.owner.id },
      {
        stageId: text(item.stageId, "stageId"),
        verdict: item.verdict,
        feedback: text(item.feedback, "feedback"),
        refs: item.refs.map(artifactRef),
      },
      text(item.requestId, "requestId"),
    );
    this.#publish(research);
    return this.ctx.stockResearch.runs.view({ runId });
  }

  #context(runId: string) {
    const runtime = this.ctx.stockResearch;
    const collection = readCollection(runtime.runs, runId);
    return {
      runId,
      view: runtime.runs.view({ runId }),
      tasks: runtime.runs
        .readDefinition(runId)
        .tasks.map(({ id, executor }) => ({ id, executor })),
      ...(collection === null
        ? {}
        : {
            collection: {
              cutoff: collection.scope.cutoff,
              tables: collection.packets.map(({ id, envelope }) => ({
                id,
                title: envelope.data.title,
                rows: envelope.data.rows.length,
              })),
              failures: collection.failures,
            },
          }),
    };
  }

  async #perform<T>(
    owner: Agent,
    previous: ResearchExecution | undefined,
    label: string,
    callerSignal: AbortSignal,
    action: (
      research: ResearchExecution,
      job: JobHandle,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    callerSignal.throwIfAborted();
    if (previous?.finishedAt !== undefined)
      throw new ResearchError("ACCESS_DENIED", "The research has ended.");
    const runtime = this.ctx.stockResearch;
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    let work!: Promise<T>;
    let research!: ResearchExecution;
    const id = this.ctx.jobs.start({
      kind: previous === undefined ? RESEARCH_JOB_KIND : RESEARCH_STEP_JOB_KIND,
      label,
      owner: owner.id,
      run: (job) => {
        research = previous ?? {
          owner,
          job,
          completion: researchCompletion(),
          preparationStatus: "preparing",
          release: holdActivity(runtime),
          resourcesReleased: false,
          operations: new Map(),
        };
        this.#executions.add(research);
        job.updateProgress(
          previous === undefined ? "准备采集数据" : "执行研究任务",
        );
        work = withActivity(runtime, () =>
          Promise.resolve().then(async () => {
            try {
              const pending = action(research, job, signal);
              this.#publish(research);
              return await pending;
            } catch (cause) {
              if (research.runId === undefined) {
                research.preparationStatus = signal.aborted
                  ? "cancelled"
                  : "failed";
                this.#finish(research);
              }
              job.append(`${failureDetail(cause)}\n`, { channel: "log" });
              throw cause;
            } finally {
              research.operations.delete(job.id);
              this.#publish(research);
            }
          }),
        );
        research.operations.set(job.id, { controller, work });
        this.#pending.add(work);
        void work.then(
          () => this.#pending.delete(work),
          () => this.#pending.delete(work),
        );
        return {
          cancel: (reason) => {
            controller.abort(
              new DOMException(reason ?? "调研操作已取消。", "AbortError"),
            );
            if (previous === undefined && research.finishedAt === undefined)
              void this.#cancel(research, "job-cancelled").catch((cause) =>
                research.completion.resolve({
                  status: "failed",
                  detail: failureDetail(cause),
                }),
              );
          },
          done:
            previous === undefined
              ? research.completion.promise
              : work.then(
                  (result) => ({
                    status: "completed" as const,
                    result: serializeJson(result),
                  }),
                  (cause) => ({
                    status: signal.aborted
                      ? ("killed" as const)
                      : ("failed" as const),
                    detail: failureDetail(cause),
                  }),
                ),
        };
      },
    });
    if (previous === undefined) return work;
    // The Agent tool, rather than the browser command request, owns this wait.
    let view = await this.ctx.jobs.wait(id, JOB_WAIT_MS, owner.id);
    while (view.status === "running" || view.status === "stopping")
      view = await this.ctx.jobs.wait(id, JOB_WAIT_MS, owner.id);
    return work;
  }

  #finish(research: ResearchExecution): void {
    if (research.finishedAt !== undefined) return;
    research.finishedAt = Date.now();
    if (research.runId !== undefined)
      this.ctx.stockResearch.dispatch.releaseRun(research.runId);
    const run =
      research.runId === undefined
        ? undefined
        : this.ctx.stockResearch.runs.view({ runId: research.runId });
    const outcome: JobOutcome =
      run?.status === "completed"
        ? {
            status: "completed",
            detail: "研究报告已定档，主 Agent 在聊天中交付结论。",
          }
        : run?.status === "cancelled" ||
            research.preparationStatus === "cancelled"
          ? { status: "killed", detail: "研究已取消，已提交内容保留。" }
          : {
              status: "failed",
              detail: "数据准备失败，请查看工具错误与日志。",
            };
    void Promise.allSettled(
      [...research.operations.values()].map(({ work }) => work),
    ).then(() => research.completion.resolve(outcome));
    if (
      this.#closed ||
      research.owner.status === "idle" ||
      this.ctx.agents.get(research.owner.id) !== research.owner
    )
      this.#release(research);
  }

  #release(research: ResearchExecution): void {
    if (research.resourcesReleased) return;
    research.resourcesReleased = true;
    research.release();
  }

  idleOwner(owner: Agent): void {
    for (const research of this.#executions)
      if (research.owner === owner && research.finishedAt !== undefined)
        this.#release(research);
  }

  #publish(research: ResearchExecution): void {
    let status: ResearchActivity["status"] = research.preparationStatus;
    let progress =
      status === "preparing"
        ? "采集固定数据"
        : status === "cancelled"
          ? "调研已取消"
          : "数据准备失败，请查看工具错误与日志";
    if (research.runId !== undefined) {
      const view = this.ctx.stockResearch.runs.view({ runId: research.runId });
      status =
        view.status === "cancelled"
          ? "cancelled"
          : view.status === "completed"
            ? "completed"
            : view.status === "blocked" ||
                view.tasks.some((task) => task.status === "failed")
              ? "blocked"
              : "active";
      const waiting = view.stages?.find(
        (stage) => stage.readyForReview && !stage.accepted,
      );
      if (waiting?.latestReview?.verdict === "rejected") status = "blocked";
      progress =
        waiting === undefined
          ? researchProgress(view)
          : `等待主 Agent 验收：${waiting.id}${waiting.latestReview?.verdict === "rejected" ? ` · ${waiting.latestReview.feedback}` : ""}`;
      if (status === "completed")
        progress = "研究报告已定档，主 Agent 将在聊天中交付结论";
      if (status === "cancelled") progress = "研究已取消，已提交产物保留";
      if (status === "completed" || status === "cancelled")
        this.#finish(research);
    }
    if (research.finishedAt === undefined && research.progress !== progress) {
      research.progress = progress;
      research.job.updateProgress(progress);
      research.job.append(`${progress}\n`, { channel: "log" });
    }
  }

  controlTool(kind: ResearchControlKind): ToolDefinition {
    const definitions = {
      resume: [
        "stock_resume_research",
        "恢复研究并修订待执行任务。input必须包含resolvedReasonIds和instructions，无变更时传空数组。返回任务计划，由当前主Agent继续推进。",
      ],
      cancel: [
        "stock_cancel_research",
        "取消指定研究，停止相关执行并保留已提交内容。",
      ],
      recover: [
        "stock_recover_research",
        "仅在用户明确确认旧执行丢失后登记指定中断尝试；不直接启动执行。",
      ],
      replay: [
        "stock_replay_research",
        "使用指定研究的固定输入建立派生运行，返回任务计划，由当前主Agent继续推进。",
      ],
    } as const;
    const [name, description] = definitions[kind];
    return researchTool({
      name,
      description,
      parameters: runControlParameters[kind],
      output: resultOutput(opaqueObjectSchema),
      execute: (value, exec) =>
        runApplicationTool(this.ctx, name, value, exec, () => {
          const { command, requestId } = parseRunControl(kind, value);
          if (exec.agent === undefined)
            throw new ResearchError(
              "ACCESS_DENIED",
              "A host Agent is required.",
            );
          return this.control(command, exec.agent, requestId, exec.signal);
        }),
    });
  }

  async control(
    input: RunCommand,
    owner: Agent,
    requestId: string,
    signal: AbortSignal,
  ) {
    this.#main(owner);
    signal.throwIfAborted();
    const runtime = this.ctx.stockResearch;
    const operation = { runId: input.runId, identity: owner.id };
    if (input.kind === "status")
      return {
        kind: "success" as const,
        text: runStatus(runtime.runs.view(operation)),
      };
    if (input.kind === "cancel") {
      const research = this.#runs.get(input.runId);
      if (research === undefined)
        await runtime.dispatch.cancel(operation, requestId);
      else await this.#cancel(research, requestId);
      return {
        kind: "success" as const,
        text: runStatus(runtime.runs.view(operation)),
      };
    }
    if (input.kind === "recover") {
      runtime.dispatch.recoverInterrupted(operation, input.attempts, requestId);
      return {
        kind: "success" as const,
        text: runStatus(runtime.runs.view(operation)),
      };
    }
    const attached = this.#runs.get(input.runId);
    if (
      input.kind !== "replay" &&
      attached !== undefined &&
      attached.owner !== owner
    )
      throw new ResearchError(
        "ACCESS_DENIED",
        "Continue this live research in its owning chat.",
      );
    if (input.kind === "resume" || input.kind === "redo")
      savedCoordinator(runtime.runs, input.runId);
    let runId = input.runId;
    if (input.kind === "replay")
      runId = runtime.runs.open(
        owner.id,
        createReplayInput(runtime.runs, input.runId),
        requestId,
      ).runId;
    else if (input.kind === "resume")
      runtime.runs.resume(operation, input.input, requestId);
    else
      await runtime.dispatch.redo(
        operation,
        input.taskId,
        requestId,
        input.reason,
      );
    runtime.authorizeCoordinatorRun(owner, runId);
    const existing = this.#runs.get(runId);
    if (existing !== undefined && existing.owner !== owner)
      throw new ResearchError(
        "ACCESS_DENIED",
        "Continue this live research in its owning chat.",
      );
    if (existing === undefined)
      await this.#perform(
        owner,
        undefined,
        `继续研究 ${runId}`,
        signal,
        async (research) => {
          research.runId = runId;
          this.#runs.set(runId, research);
          return this.#context(runId);
        },
      );
    else this.#publish(existing);
    return this.#context(runId);
  }

  async #cancel(research: ResearchExecution, requestId: string): Promise<void> {
    for (const operation of research.operations.values())
      operation.controller.abort(
        new DOMException("研究已取消。", "AbortError"),
      );
    const results = await Promise.allSettled([
      ...(research.runId === undefined
        ? []
        : [
            this.ctx.stockResearch.dispatch.cancel(
              { runId: research.runId, identity: research.owner.id },
              requestId,
            ),
          ]),
      ...[...research.operations.values()].map(({ work }) =>
        work.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]);
    research.preparationStatus = "cancelled";
    this.#finish(research);
    this.#publish(research);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "Could not cancel research.", {
        cause: failures[0],
      });
  }

  command(
    invocation: CommandInvocation,
    mode: RunDefinition["mode"],
  ): CommandResult {
    invocation.signal.throwIfAborted();
    const selection = parseResearchInput(invocation.rawInput, new Date(), mode);
    invocation.agent.followup(
      createUserMessage({
        content: [
          {
            type: "text",
            text: `请按${mode === "quick" ? "快速" : "深度"}研究流程调研 ${selection.security}，研究日期 ${selection.scope.date}。由你负责派工、阶段验收和最终回复。\n研究请求：${JSON.stringify({ kind: "fresh", security: selection.security, date: selection.scope.date, mode })}`,
          },
        ],
        source: { kind: "user" },
      }),
    );
    return { kind: "success", text: "研究请求已交给当前主 Agent。" };
  }

  async commandControl(
    invocation: CommandInvocation,
    kind: RunCommandKind,
  ): Promise<CommandResult> {
    const operationId = randomUUID();
    const result = await this.control(
      parseRunCommand(kind, invocation.rawInput),
      invocation.agent,
      operationId,
      invocation.signal,
    );
    if ("kind" in result) return result;
    if (result.view.status !== "active")
      return { kind: "error", text: runStatus(result.view) };
    invocation.agent.followup(
      createUserMessage({
        content: [
          {
            type: "text",
            text: `请继续推进这次研究，按真实状态派工和验收。\n研究请求：${JSON.stringify({ kind, operationId, ...result })}`,
          },
        ],
        source: { kind: "user" },
      }),
    );
    return {
      kind: "success",
      text: `运行 ${result.runId} 已交给当前主 Agent 继续。`,
    };
  }

  disposeOwner(owner: Agent): Promise<void> {
    const existing = this.#disposing.get(owner);
    if (existing !== undefined) return existing;
    const work = Promise.resolve()
      .then(async () => {
        const stopped = await Promise.allSettled(
          [...this.#executions]
            .filter(
              (research) =>
                research.owner === owner && research.finishedAt === undefined,
            )
            .map((research) => this.#cancel(research, "owner-disposed")),
        );
        const failures = stopped.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        for (const release of this.#coordinators.get(owner)?.reverse() ?? []) {
          try {
            release();
          } catch (cause) {
            failures.push(cause);
          }
        }
        this.#coordinators.delete(owner);
        for (const research of this.#executions) {
          if (research.owner !== owner) continue;
          this.#release(research);
          this.#executions.delete(research);
          if (research.runId !== undefined) this.#runs.delete(research.runId);
        }
        for (const [key, start] of this.#starts)
          if (start.owner === owner) this.#starts.delete(key);
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "Could not release research owner.",
            { cause: failures[0] },
          );
      })
      .finally(() => this.#disposing.delete(owner));
    this.#disposing.set(owner, work);
    return work;
  }
  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#coordinators.keys()].map((owner) => this.disposeOwner(owner)),
    );
    await Promise.allSettled([...this.#pending]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Could not release research executions.",
        { cause: failures[0] },
      );
  }
}

export const Config = ModelConfig.required(false);
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
  const app = new ResearchApplication(ctx, structuredClone(config));
  const tool = (definition: ToolDefinition): ToolDefinition =>
    researchTool({
      ...definition,
      execute: (value, exec) =>
        runApplicationTool(ctx, definition.name, value, exec, () =>
          definition.execute(value, exec),
        ),
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
    yield ctx.tools.register(
      tool({
        name: "stock_start_research",
        description:
          "开始用户明确提出的个股quick/deep研究。仅采集固定数据并建立计划，返回runId、任务和阶段验收要求；后续由当前主Agent逐步派工、验收和交付。省略date时采用标的市场当天。重试沿用requestId，新诉求使用新ID。",
        parameters: objectSchema(
          {
            security: stringSchema,
            date: stringSchema,
            mode: { type: "string", enum: ["quick", "deep"] },
            requestId: stringSchema,
          },
          ["security", "mode", "requestId"],
        ),
        output: resultOutput(opaqueObjectSchema),
        execute: (value, exec) => app.start(value, exec),
      }),
    );
    yield ctx.tools.register(
      tool({
        name: "stock_review_stage",
        description:
          "主Agent审阅本阶段产物后提交通过或返工意见。refs必须恰为当前阶段产物版本。通过后才能进入下游；拒绝后明确redo并补充修订说明。",
        parameters: objectSchema({
          runId: stringSchema,
          stageId: stringSchema,
          verdict: { type: "string", enum: ["accepted", "rejected"] },
          feedback: stringSchema,
          refs: { type: "array", items: artifactRefSchema },
          requestId: stringSchema,
        }),
        output: resultOutput(opaqueObjectSchema),
        execute: async (value, exec) => app.review(value, exec),
      }),
    );
    for (const kind of ["resume", "cancel", "recover", "replay"] as const)
      yield ctx.tools.register(app.controlTool(kind));
    for (const mode of ["quick", "deep"] as const)
      yield ctx.commands.register({
        name: `stock-${mode}`,
        description: `让当前主Agent按${mode}流程组织个股研究。`,
        input: { hint: "标的 YYYY-MM-DD" },
        handler: (invocation) =>
          runApplicationCommand(ctx, `stock-${mode}`, invocation, async () =>
            app.command(invocation, mode),
          ),
      });
    for (const kind of [
      "status",
      "resume",
      "redo",
      "cancel",
      "recover",
      "replay",
    ] as const)
      yield ctx.commands.register({
        name: `stock-${kind}`,
        description: `对用户选择的研究运行执行${kind}。`,
        input: {
          hint:
            kind === "resume"
              ? 'runId {"resolvedReasonIds":[],"instructions":[]}'
              : kind === "recover"
                ? 'runId [{"taskId":"...","attempt":1}]'
                : kind === "redo"
                  ? "runId taskId [reason]"
                  : "runId",
        },
        handler: (invocation) =>
          runApplicationCommand(ctx, `stock-${kind}`, invocation, () =>
            app.commandControl(invocation, kind),
          ),
      });
  });
}

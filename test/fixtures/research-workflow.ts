import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type {
  AgentReport,
  AgentReportKind,
} from "../../src/contracts/agent-reports.js";
import type { ArtifactRef, ResearchScope } from "../../src/contracts/data.js";
import type { RunView } from "../../src/contracts/runs.js";
import type { TaskDefinition } from "../../src/contracts/workflow.js";
import {
  initialInput,
  lastToolResult,
  lastToolText,
  toolCall,
} from "./quick-host.js";
import { gate, textResponse } from "./runtime-host.js";
import { agentAnalysisReport, reportSubmission } from "./analysis-report.js";
import { calculationRequest, valuationRecord } from "./valuation.js";

interface AgentContext {
  materials: unknown[];
  dataCatalog: { id: string }[];
  reportCatalog: { id: string; role: string; kind: string; title: string }[];
  requiredRisks: { issueId: string }[];
  referencePrice: { value: number; unit: string } | null;
}

type ResearchTaskInfo = Pick<TaskDefinition, "id" | "executor">;

export interface RoleInput {
  scope: ResearchScope;
  task: { id: string; role: string; objective: string };
  context: AgentContext;
}

export function isMainResearchRequest(request: GenerateOptions): boolean {
  return (
    request.tools?.some(({ name }) => name === "stock_start_research") === true
  );
}

export interface MainResearchRequest {
  kind: "fresh" | "resume" | "redo" | "replay";
  security?: string;
  date?: string;
  mode?: "quick" | "deep";
  runId?: string;
  view?: RunView;
  tasks?: ResearchTaskInfo[];
  operationId?: string;
}

export function mainResearchRequest(
  request: GenerateOptions,
): MainResearchRequest {
  const message = request.messages.findLast(
    (message) => message.role === "user" && message.source?.kind === "user",
  )!;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const marker = "研究请求：";
  if (text.includes(marker))
    return JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length));
  const security =
    /(?:SZ\.\d{6}|SH\.\d{6}|CN:\d{6}\.(?:SZ|SH)|(?:NASDAQ|NYSE):[A-Z][A-Z0-9-]*)/.exec(
      text,
    )?.[0];
  if (security === undefined)
    throw new Error(`Fixture cannot infer research security from ${text}`);
  const date = /\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
  return {
    kind: "fresh",
    security,
    ...(date === undefined ? {} : { date }),
    mode: /deep|深度/.test(text) ? "deep" : "quick",
  };
}

/** External model script only; the SDK, tools, DAG, adapters and finalizer are real. */
export function workflowModel(
  options: {
    pauseFundamentals?: ReturnType<typeof gate<GenerateOptions>>;
    repairManager?: boolean;
    rejectStage?: string;
  } = {},
) {
  const calls = new Map<string, number>();
  const calculations = new Map<string, string>();
  const state: {
    runId?: string;
    marketRef?: ArtifactRef;
    taskIds: string[];
    released: boolean;
    managerFeedback?: string;
    reviewedStages: string[];
    rejectedStages: string[];
  } = { taskIds: [], released: false, reviewedStages: [], rejectedStages: [] };
  const main = new Map<
    string,
    {
      prompt: number;
      view?: RunView;
      tasks: ResearchTaskInfo[];
      lastAction?: string;
      pendingRedo?: string;
      inspected: Set<string>;
      finalReport?: string;
    }
  >();

  async function* respond(
    request: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const session = String(request.sessionId);
    const call = (calls.get(session) ?? 0) + 1;
    calls.set(session, call);
    if (isMainResearchRequest(request)) {
      const prompt = request.messages.findLastIndex(
        (message) => message.role === "user" && message.source?.kind === "user",
      );
      let current = main.get(session);
      const invoke = (name: string, args: unknown) => {
        current!.lastAction = name;
        return toolCall(name, args, `${name}-${call}`);
      };
      if (current === undefined || current.prompt !== prompt) {
        const input = mainResearchRequest(request);
        current = {
          prompt,
          tasks: input.tasks ?? [],
          inspected: new Set(),
          ...(input.view === undefined ? {} : { view: input.view }),
        };
        main.set(session, current);
        if (input.kind === "fresh") {
          yield* invoke("stock_start_research", {
            security: input.security,
            ...(input.date === undefined ? {} : { date: input.date }),
            mode: input.mode,
            requestId: `open-${call}`,
          });
          return;
        }
        state.runId = input.runId!;
      } else {
        let feedback: {
          runId?: string;
          view?: RunView;
          tasks?: ResearchTaskInfo[];
          kind?: string;
          artifact?: {
            ref: ArtifactRef;
            content: { kind: string; body: string };
          };
          taskId?: string;
          refs?: ArtifactRef[];
          results?: { taskId: string; refs: ArtifactRef[] }[];
          readyTasks?: string[];
        };
        try {
          feedback = lastToolResult(request);
        } catch {
          yield* textResponse(lastToolText(request));
          return;
        }
        if (current.lastAction === "stock_start_research") {
          if (feedback.runId === undefined) {
            yield* textResponse(lastToolText(request));
            return;
          }
          state.runId = feedback.runId;
          current.tasks = feedback.tasks!;
          current.view = feedback.view!;
        } else if (
          current.lastAction === "stock_read_run" &&
          feedback.kind === "run_view"
        )
          current.view = feedback.view!;
        else if (current.lastAction === "stock_review_stage")
          current.view = feedback as unknown as RunView;
        else if (
          current.lastAction === "stock_read_artifact" &&
          feedback.artifact !== undefined
        ) {
          if (feedback.artifact.content.kind === "report")
            current.finalReport = feedback.artifact.content.body;
        } else {
          const market = feedback.results?.find(
            ({ taskId }) => taskId === "analysis.market",
          );
          if (market?.refs[0] !== undefined) state.marketRef = market.refs[0];
          if (
            feedback.taskId === "analysis.market" &&
            feedback.refs?.[0] !== undefined
          )
            state.marketRef = feedback.refs[0];
          yield* invoke("stock_read_run", { runId: state.runId });
          return;
        }
      }
      const view = current.view!;
      if (view.status === "completed") {
        if (current.finalReport === undefined) {
          const reportRef =
            view.tasks
              .find(({ taskId }) => taskId === "finalize")!
              .outputRefs.find((ref) => ref.artifactId.includes("report")) ??
            view.tasks
              .find(({ taskId }) => taskId === "finalize")!
              .outputRefs.at(-1)!;
          yield* invoke("stock_read_artifact", { ref: reportRef });
        } else
          yield* textResponse(
            `运行 ${view.runId} 已完成。\n\n${current.finalReport}`,
          );
        return;
      }
      if (
        view.status !== "active" ||
        view.tasks.some(({ status }) => status === "failed")
      ) {
        yield* textResponse(`运行 ${view.runId} 尚未完成，请检查具体失败。`);
        return;
      }
      if (current.pendingRedo !== undefined) {
        const taskId = current.pendingRedo;
        delete current.pendingRedo;
        yield* invoke("stock_redo_task", {
          runId: view.runId,
          taskId,
          reason: "补充阶段验收指出的问题。",
          requestId: `redo-${call}`,
        });
        return;
      }
      const stage = view.stages?.find(
        ({ readyForReview, accepted }) => readyForReview && !accepted,
      );
      if (stage !== undefined) {
        const unseen = stage.refs.find(
          (ref) => !current.inspected.has(JSON.stringify(ref)),
        );
        if (unseen !== undefined) {
          current.inspected.add(JSON.stringify(unseen));
          yield* invoke("stock_read_artifact", { ref: unseen });
          return;
        }
        const reject =
          options.rejectStage === stage.id &&
          !state.rejectedStages.includes(stage.id);
        if (reject) {
          state.rejectedStages.push(stage.id);
          current.pendingRedo = stage.taskIds[0]!;
        } else state.reviewedStages.push(stage.id);
        yield* invoke("stock_review_stage", {
          runId: view.runId,
          stageId: stage.id,
          verdict: reject ? "rejected" : "accepted",
          feedback: reject
            ? "需要补充分析依据。"
            : "已检查报告覆盖、依据与风险。",
          refs: stage.refs,
          requestId: `review-${call}`,
        });
        return;
      }
      const taskId = view.readyTasks[0];
      if (taskId === undefined) {
        yield* textResponse(`运行 ${view.runId} 当前没有可执行的任务。`);
        return;
      }
      const task = current.tasks.find(({ id }) => id === taskId)!;
      const parallelStage = view.stages?.find(
        (stage) =>
          stage.id.startsWith("debate.") &&
          stage.taskIds.includes(taskId) &&
          stage.taskIds.length > 1 &&
          stage.taskIds.every((id) => view.readyTasks.includes(id)),
      );
      if (task.executor.kind === "role" && parallelStage !== undefined) {
        state.taskIds.push(
          ...parallelStage.taskIds.filter((id) => view.readyTasks.includes(id)),
        );
        yield* invoke("stock_dispatch_stage", {
          runId: view.runId,
          stageId: parallelStage.id,
          requestId: `${parallelStage.id}-${call}`,
        });
        return;
      }
      state.taskIds.push(task.id);
      const name =
        task.executor.kind === "role"
          ? "stock_dispatch_task"
          : task.executor.service === "digest"
            ? "stock_make_digest"
            : "stock_decide";
      yield* invoke(name, {
        runId: view.runId,
        taskId,
        requestId: `${taskId}-${call}`,
      });
      return;
    }

    const role = initialInput<RoleInput>(request);
    if (role.task.role === "digest") {
      const report: AgentReport<"digest"> = {
        summary: "产品组合与终端价格共同决定盈利变化。",
        content: {
          keyPoints: ["固定研究输入"],
          disagreements: [],
          riskSummaries: role.context.requiredRisks.map((risk) => ({
            issueId: risk.issueId,
            text: `${risk.issueId}人工风险综述`,
          })),
          openQuestions: [],
        },
      };
      yield* toolCall("stock_submit", report);
      return;
    }
    if (
      role.task.id === "analysis.fundamentals" &&
      call === 1 &&
      options.pauseFundamentals !== undefined
    ) {
      const pause = options.pauseFundamentals;
      const aborted = () => pause.aborted.resolve();
      request.signal?.addEventListener("abort", aborted, { once: true });
      pause.started.resolve(request);
      try {
        await pause.released.promise;
        request.signal?.throwIfAborted();
      } finally {
        state.released = true;
        request.signal?.removeEventListener("abort", aborted);
      }
    }
    const repairManager =
      options.repairManager && role.task.id === "manager.decision";
    const calculates =
      request.tools?.some(({ name }) => name === "stock_calculate_valuation") &&
      ["analysis.fundamentals", "manager.decision"].includes(role.task.id);
    if (calculates && !calculations.has(session)) {
      if (call === 1) {
        yield* toolCall(
          "stock_calculate_valuation",
          calculationRequest(
            role.task.id === "manager.decision" ? "target_price" : "valuation",
          ),
          "calculate",
        );
        return;
      }
      calculations.set(
        session,
        lastToolResult<{ calculationId: string }>(request).calculationId,
      );
    }
    const reportCall = call - (calculates ? 1 : 0);
    if (repairManager && reportCall === 2)
      state.managerFeedback = lastToolText(request);
    if (reportCall > 1 && !(repairManager && reportCall === 2)) {
      yield* textResponse("产物已提交。");
      return;
    }
    if (role.task.id.startsWith("analysis.")) {
      const report = agentAnalysisReport();
      if (role.task.id === "analysis.fundamentals")
        report.content.valuation = valuationRecord(
          role.scope.date,
          role.scope.security.currency,
        );
      if (calculates)
        report.content.valuation!.methods[0]!.calculationIds = [
          calculations.get(session)!,
        ];
      if (request.tools?.some(({ name }) => name === "stock_write_report"))
        yield* reportSubmission(
          report,
          "submit-report",
          request.tools.some(({ name }) => name === "stock_write_handoff"),
        );
      else yield* toolCall("stock_submit", report);
      return;
    }

    let report: AgentReport<AgentReportKind>;
    if (role.task.id.startsWith("debate.")) {
      const analysis = agentAnalysisReport();
      report = {
        summary: "本方围绕产品组合及价格竞争展开判断。",
        content: {
          arguments: [
            {
              claim: "产品组合决定利润率的变化。",
              mechanism: "高价产品占比提高能够改善单车利润。",
              conditions: ["高价产品交付增长。"],
            },
          ],
          responses: [],
          outlook: analysis.content.outlook,
          risks: analysis.content.risks,
          openQuestions: analysis.content.handoff.openQuestions,
        },
      };
    } else if (role.task.id === "manager.research") {
      report = {
        summary: "围绕固定分析与两轮讨论确定研究问题。",
        content: {
          questions: [
            {
              question: "来源历史版本能否核实？",
              whyItMatters: "决定当时可知信息的比较范围。",
              nextStep: "核对原披露时间和对应版本。",
            },
          ],
          constraints: ["采用同一统计期间和价格口径。"],
        },
      };
    } else if (role.task.id.startsWith("risk.")) {
      report = {
        summary: "终端折扣变化影响利润兑现。",
        content: {
          issues:
            role.task.id === "risk.main"
              ? []
              : [
                  {
                    description: `${role.task.id}人工风险`,
                    impact: "折扣扩大压缩单车利润。",
                    trigger: "主销车型终端优惠提高。",
                    constraint: "估值纳入较低利润假设。",
                    recommendation: "跟踪主销产品终端价格。",
                  },
                ],
        },
      };
    } else if (role.task.id === "manager.decision") {
      report = {
        summary: "产品组合改善支持买入判断。",
        content: {
          thesis: ["产品组合改善带动盈利。"],
          valuation: valuationRecord(
            role.scope.date,
            role.scope.security.currency,
            true,
          ),
          targetPrice: {
            value: 230.4,
            ...(calculates
              ? { calculationId: calculations.get(session)! }
              : {}),
            method: "盈利增长情景估值。",
            assumptions: ["新产品组合改善支持目标市值。"],
          },
          risks: [],
          riskResponses: role.context.requiredRisks.map((risk) => ({
            issueId: risk.issueId,
            disposition: "unresolved",
            reason: "人工场景明确保留尚未解决的风险。",
          })),
          invalidationConditions: [],
          limitations: [],
        },
      };
      if (calculates) {
        const context = role.context as unknown as {
          valuationCalculations: { calculationId: string; purpose: string }[];
        };
        (
          report as AgentReport<"decision_draft">
        ).content.valuation!.methods[0]!.calculationIds = [
          context.valuationCalculations.find(
            ({ purpose }) => purpose === "valuation",
          )!.calculationId,
        ];
      }
    } else throw new Error(`Unexpected role task ${role.task.id}`);
    if (repairManager && reportCall === 1) {
      yield* toolCall("stock_write_report", {
        targetPrice: { calculationId: calculations.get(session), value: -1 },
      });
      return;
    }
    if (request.tools?.some(({ name }) => name === "stock_write_report"))
      yield* reportSubmission(
        report,
        `submit-${call}`,
        request.tools.some(({ name }) => name === "stock_write_handoff"),
      );
    else yield* toolCall("stock_submit", report, "submit");
  }
  return { state, respond };
}

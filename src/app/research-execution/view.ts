import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { CollectionProgress } from "../../contracts/collection.js";
import type { RunView } from "../../contracts/runs.js";
import type {
  CollectionCounts,
  ResearchIdentity,
  ResearchJobRecord,
  ResearchProgress,
  ResearchState,
} from "../../contracts/research-progress.js";
import { collectionProgress, researchProgress } from "./progress.js";

export type ResearchPreparationStatus = "preparing" | "failed" | "cancelled";

export function collectionJobRecords(
  progress: CollectionProgress,
): ResearchJobRecord[] {
  return [
    ...(progress.recordPath === undefined
      ? []
      : [
          {
            type: "research/collection-record" as const,
            path: progress.recordPath,
          },
        ]),
    ...(progress.failures ?? []).map((failure) => ({
      type: "research/diagnostic" as const,
      dataset: failure.id,
      source: failure.provider,
      code: failure.code,
      message: failure.detail,
    })),
  ];
}

export function researchJobView({
  preparationStatus,
  view,
  collection,
  identity,
  operationIds,
}: {
  preparationStatus: ResearchPreparationStatus;
  view: RunView | undefined;
  collection: CollectionCounts | undefined;
  identity: ResearchIdentity | undefined;
  operationIds: string[];
}): ResearchProgress {
  if (view === undefined)
    return {
      state: {
        status: preparationStatus,
        phase:
          preparationStatus !== "preparing"
            ? { kind: "ended" }
            : collection === undefined
              ? { kind: "preparing" }
              : { kind: "collection", counts: collection },
        ...(identity === undefined ? {} : { identity }),
        operationIds,
      },
      text:
        preparationStatus === "preparing"
          ? collection === undefined
            ? "采集固定数据"
            : collectionProgress(collection)
          : preparationStatus === "cancelled"
            ? "调研已取消"
            : "数据准备失败，请查看工具错误与日志",
    };
  const status: ResearchState["status"] =
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
  const blocked = waiting?.latestReview?.verdict === "rejected";
  let text =
    waiting === undefined
      ? researchProgress(view)
      : `等待主 Agent 验收：${waiting.id}${waiting.latestReview?.verdict === "rejected" ? ` · ${waiting.latestReview.feedback}` : ""}`;
  if (status === "completed")
    text = "研究报告已定档，主 Agent 将在聊天中交付结论";
  if (status === "cancelled") text = "研究已取消，已提交产物保留";
  const terminal = status === "completed" || status === "cancelled";
  const running = view.tasks.filter((task) => task.status === "running");
  return {
    state: {
      status: terminal ? status : blocked ? "blocked" : status,
      phase: terminal
        ? { kind: "ended" }
        : waiting === undefined
          ? {
              kind: "tasks",
              completed: view.tasks.filter(
                (task) => task.status === "succeeded",
              ).length,
              total: view.tasks.length,
              currentTaskIds:
                running.length > 0
                  ? running.map((task) => task.taskId)
                  : view.readyTasks.slice(0, 1),
            }
          : {
              kind: "review",
              stageId: waiting.id,
              feedback: blocked ? waiting.latestReview!.feedback : null,
            },
      runId: view.runId,
      identity: {
        symbol: view.scope.security.symbol,
        date: view.scope.date,
        mode: view.mode,
      },
      operationIds,
    },
    text,
  };
}

export function researchJobOutcome(
  preparationStatus: ResearchPreparationStatus,
  view: RunView | undefined,
): JobOutcome {
  return view?.status === "completed"
    ? {
        status: "completed",
        detail: "研究报告已定档，主 Agent 在聊天中交付结论。",
      }
    : view?.status === "cancelled" || preparationStatus === "cancelled"
      ? { status: "killed", detail: "研究已取消，已提交内容保留。" }
      : {
          status: "failed",
          detail: "数据准备失败，请查看工具错误与日志。",
        };
}

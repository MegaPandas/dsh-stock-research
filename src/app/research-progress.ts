import type { CollectionProgress } from "../contracts/collection.js";
import type { RunView } from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";

export function collectionProgress(progress: CollectionProgress): string {
  const current = progress.current;
  return [
    `采集数据 ${progress.completed}/${progress.total}`,
    `成功 ${progress.succeeded}，缺失 ${progress.failed}`,
    `缓存命中 ${progress.cacheHits}，未命中 ${progress.cacheMisses}`,
    ...(current === undefined ? [] : [`${current.provider} · ${current.id}`]),
  ].join(" · ");
}

function stage(taskId: string): string {
  if (taskId.startsWith("digest.")) return "整理摘要";
  if (taskId.startsWith("analysis.")) return "分析";
  if (taskId.startsWith("debate.")) return "多空讨论";
  if (taskId.startsWith("risk.")) return "风险评估";
  if (taskId === "manager.research") return "制定研究计划";
  if (taskId === "manager.decision") return "形成决策";
  return "生成报告";
}

export function researchProgress(view: RunView): string {
  const completed = view.tasks.filter(
    (task) => task.status === "succeeded",
  ).length;
  const running = view.tasks.filter((task) => task.status === "running");
  const current =
    running.length > 0
      ? [...new Set(running.map((task) => stage(task.taskId)))].join("、")
      : view.readyTasks.length > 0
        ? stage(view.readyTasks[0]!)
        : "协调研究";
  return `${current} · 已完成 ${completed}/${view.tasks.length} 个研究任务`;
}

export function failureDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const detail =
    cause instanceof AggregateError
      ? cause.errors.map(failureDetail)
      : cause.cause === undefined
        ? []
        : [failureDetail(cause.cause)];
  return [
    cause instanceof ResearchError
      ? `${cause.code}: ${cause.message}`
      : cause.message,
    ...detail,
  ].join("\n");
}

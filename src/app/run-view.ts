import type { RunView } from "../contracts/runs.js";

export function runStatus(view: RunView): string {
  const succeeded = view.tasks.filter(
    (task) => task.status === "succeeded",
  ).length;
  return [
    `运行 ${view.runId}：${view.status}`,
    `${view.scope.security.id} · ${view.scope.date} · ${view.mode}`,
    `已完成 ${succeeded}/${view.tasks.length} 个任务。`,
    ...view.tasks
      .filter((task) => task.status !== "succeeded")
      .map(
        (task) =>
          `${task.taskId} #${task.attempt}：${task.status}${task.failure === null ? "" : `；${task.failure.code}: ${task.failure.message}`}`,
      ),
    ...view.blockReasons.map(
      (reason) => `阻塞 ${reason.id}：${reason.code}: ${reason.message}`,
    ),
  ].join("\n");
}

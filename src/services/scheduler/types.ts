import type { RunChanges, RunReader } from "../../contracts/run-access.js";
import type { AttemptTarget, RunView } from "../../contracts/runs.js";
import type { TaskDefinition } from "../../contracts/workflow.js";

export type SchedulerExecution =
  | (AttemptTarget & {
      kind: "task";
      executor: TaskDefinition["executor"];
      requestId: string;
    })
  | {
      kind: "stage";
      stageId: string;
      tasks: readonly AttemptTarget[];
      requestId: string;
    };

export interface SchedulerPorts {
  runs: Pick<RunReader, "view" | "readDefinition"> & RunChanges;
  /** Own admission, canonical claims and execution release; normalize confirmed control interruptions. */
  execute(execution: SchedulerExecution, signal: AbortSignal): Promise<unknown>;
  onChange(view: RunView): void;
}

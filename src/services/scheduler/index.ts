import type { RunDefinition } from "../../contracts/workflow.js";
import { executionTasks, readyExecutions } from "./plan.js";
import type { SchedulerExecution, SchedulerPorts } from "./types.js";

export type { SchedulerExecution, SchedulerPorts } from "./types.js";

/** One owner per run; durable eligibility and state remain with the run service. */
export class RunScheduler {
  readonly #definition: RunDefinition;
  readonly #controller = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #reserved = new Map<string, number>();
  readonly #failures: unknown[] = [];
  #dirty = true;
  #wake: (() => void) | undefined;
  #closed = false;
  #work: Promise<void> | undefined;

  constructor(
    private readonly runId: string,
    private readonly ports: SchedulerPorts,
  ) {
    this.#definition = ports.runs.readDefinition(runId);
  }

  start(): Promise<void> {
    if (!this.#closed) this.#work ??= this.#run();
    return this.#work ?? Promise.resolve();
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#controller.abort(
      new DOMException("Scheduler stopped.", "AbortError"),
    );
    this.#notify();
    return this.#work ?? Promise.resolve();
  }

  #notify = (): void => {
    this.#dirty = true;
    this.#wake?.();
  };

  async #run(): Promise<void> {
    const release = this.ports.runs.subscribe(this.runId, this.#notify);
    try {
      while (true) {
        await (this.#dirty
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              this.#wake = resolve;
            }));
        this.#wake = undefined;
        if (this.#closed || this.#failures.length > 0) break;
        this.#dirty = false;
        const view = this.ports.runs.view({ runId: this.runId });
        this.ports.onChange(view);
        if (view.status === "completed" || view.status === "cancelled") {
          if (view.status === "cancelled")
            this.#controller.abort(
              new DOMException("Research cancelled.", "AbortError"),
            );
          break;
        }
        if (view.status === "active")
          for (const execution of readyExecutions(
            this.#definition,
            view,
            this.#reserved,
          )) {
            if (this.#closed || this.#failures.length > 0) break;
            this.#launch(execution);
          }
      }
    } catch (cause) {
      this.#failures.push(cause);
    } finally {
      release();
      await Promise.all(this.#active);
    }
    if (this.#failures.length === 1) throw this.#failures[0];
    if (this.#failures.length > 1)
      throw new AggregateError(
        this.#failures,
        "Research scheduling and execution failed.",
      );
  }

  #launch(execution: SchedulerExecution): void {
    const tasks = executionTasks(execution);
    for (const { taskId, attempt } of tasks)
      this.#reserved.set(taskId, attempt);
    let pending: Promise<unknown>;
    try {
      pending = this.ports.execute(execution, this.#controller.signal);
    } catch (cause) {
      this.#recordFailure(cause);
      this.#release(tasks);
      this.#notify();
      return;
    }
    const work = pending
      .then(
        () => undefined,
        (cause: unknown) => this.#recordFailure(cause),
      )
      .finally(() => {
        this.#release(tasks);
        this.#active.delete(work);
        this.#notify();
      });
    this.#active.add(work);
  }

  #release(tasks: ReturnType<typeof executionTasks>): void {
    for (const { taskId, attempt } of tasks)
      if (this.#reserved.get(taskId) === attempt) this.#reserved.delete(taskId);
  }

  #recordFailure(cause: unknown): void {
    if (
      !this.#controller.signal.aborted ||
      cause !== this.#controller.signal.reason
    )
      this.#failures.push(cause);
  }
}

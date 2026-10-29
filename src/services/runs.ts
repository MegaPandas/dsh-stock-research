import { isDeepStrictEqual } from "node:util";
import { valuationDependencyIds } from "../valuation/dependencies.js";
import type { ValuationCalculation } from "../contracts/valuation.js";
import type { ValuationCalculationRegistration } from "../contracts/runs.js";
import type {
  ArtifactInput,
  ArtifactVersion,
  DecisionDraftValidation,
} from "../contracts/artifacts.js";
import type {
  ArtifactRef,
  ISOTime,
  ResearchScope,
  SourceRef,
} from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { NumberContext } from "../contracts/numbers.js";
import type {
  ReplayEvidenceRequest,
  ReplayEvidenceSource,
  ReplayMemoryRequest,
  ReplayRunInput,
  ReplaySnapshot,
} from "../contracts/replay.js";
import type {
  ArtifactCommitResult,
  AttemptFailureResult,
  AttemptTarget,
  BlockReasonInput,
  BlockRunResult,
  CancelRunResult,
  ClaimResult,
  OpenRunInput,
  ReceiptAction,
  ResearchRun,
  RecoverAttemptsResult,
  RedoTaskResult,
  ResumeRunInput,
  ResumeRunResult,
  RunOperation,
  RunInputCatalog,
  RunReceipt,
  RunState,
  RunView,
  RunWriteResult,
  RoleDispatchContext,
  TaskAttempt,
  TaskFailure,
  TaskInstructionSnapshot,
  TaskOperation,
  TaskState,
  StageReviewInput,
  StageReviewResult,
  StageView,
} from "../contracts/runs.js";
import type {
  ContentRef,
  ContentWriter,
  ProjectionWrite,
} from "../contracts/storage.js";
import type { StageDefinition } from "../contracts/workflow.js";
import type {
  EvidenceCall,
  EvidenceInput,
  EvidenceQuery,
  MemoryInputCall,
  MemoryInputQuery,
  MemoryInputRegistration,
  MemoryInputSnapshot,
  MemorySnapshotEntry,
  RegisteredEvidenceRecord,
} from "../contracts/task-data.js";
import { renderArtifact } from "../report/render.js";
import type { RunStore } from "../runs/store.js";
import { validateRunDefinition } from "./definition.js";
import { assertStoredRun } from "./run-state.js";
import {
  blockRun,
  cancelRun,
  currentAttempt,
  latestInstruction,
  recoverAttempts,
  redoRun,
  resumeRun,
  taskState,
} from "./run-control.js";
import { artifactKey, assertFreshInputs } from "./run-dependencies.js";
import { persistEvidence, persistMemoryInput } from "./run-data.js";
import { prepareReplay, type PreparedReplay } from "./replay-inputs.js";
import {
  selectReplayEvidence,
  selectReplayMemory,
  type ReplayDataReader,
} from "./replay-data.js";

const FIXED_VIEWS = {
  plan: "plan.md",
  digest: "digest.md",
  decision_draft: "decision.draft.md",
  decision: "decision.json",
  report: "report.md",
} as const;

function controlScope(identity: string): string {
  return JSON.stringify([identity]);
}
function taskScope(operation: TaskOperation): string {
  return JSON.stringify([
    operation.identity,
    operation.taskId,
    operation.attempt,
  ]);
}
function ready(run: ResearchRun, task: TaskState): boolean {
  if (
    run.status !== "active" ||
    (task.status !== "pending" && task.status !== "failed")
  )
    return false;
  const definition = run.definition.tasks.find(
    (definition) => definition.id === task.taskId,
  )!;
  return (
    definition.dependsOn.every(
      (id) => taskState(run, id).status === "succeeded",
    ) &&
    (run.definition.stages ?? [])
      .filter((stage) => stage.beforeTasks.includes(task.taskId))
      .every((stage) => stageView(run, stage).accepted)
  );
}
function equalRefs(
  left: readonly ArtifactRef[],
  right: readonly ArtifactRef[],
): boolean {
  const keys = new Set(left.map(artifactKey));
  return (
    keys.size === left.length &&
    left.length === right.length &&
    right.every((ref) => keys.has(artifactKey(ref)))
  );
}
function stageView(run: ResearchRun, stage: StageDefinition): StageView {
  const tasks = stage.taskIds.map((id) => taskState(run, id));
  const refs = tasks.flatMap((task) => task.outputRefs);
  const complete = tasks.every((task) => task.status === "succeeded");
  const downstreamStarted = stage.beforeTasks.some((id) => {
    const status = taskState(run, id).status;
    return status === "running" || status === "succeeded";
  });
  const latestReview = run.stageReviews!.findLast(
    (review) => review.stageId === stage.id,
  );
  return {
    ...stage,
    refs,
    readyForReview:
      (run.status === "active" || run.status === "blocked") &&
      complete &&
      !downstreamStarted,
    accepted:
      complete &&
      latestReview?.verdict === "accepted" &&
      equalRefs(latestReview.refs, refs),
    ...(latestReview === undefined ? {} : { latestReview }),
  };
}
function findReceipt(
  run: ResearchRun,
  scope: string,
  action: ReceiptAction,
  requestId: string,
) {
  return run.receipts.find(
    (receipt) =>
      receipt.scope === scope &&
      receipt.action === action &&
      receipt.requestId === requestId,
  );
}

function evidenceReplayRequest(
  query: EvidenceQuery,
  source: ReplayEvidenceSource | null,
): ReplayEvidenceRequest {
  return {
    query,
    source:
      source === null
        ? null
        : { runId: source.runId, evidenceId: source.evidenceId },
  };
}

function freshData(run: ResearchRun): void {
  if (run.lineage !== null)
    throw new ResearchError(
      "INVALID_INPUT",
      "Replay inputs must be selected from the saved catalog.",
    );
}

function initialInstructions(input: OpenRunInput) {
  const tasks = new Map(input.definition.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  return (input.instructions ?? []).map((instruction) => {
    if (seen.has(instruction.taskId))
      throw new ResearchError(
        "INVALID_INPUT",
        `Duplicate initial instruction for ${instruction.taskId}.`,
      );
    seen.add(instruction.taskId);
    const task = tasks.get(instruction.taskId);
    if (task === undefined)
      throw new ResearchError(
        "INVALID_INPUT",
        `Unknown initial instruction task ${instruction.taskId}.`,
      );
    return { ...instruction, version: task.instructionVersion };
  });
}

export class RunService {
  readonly #opened = new Map<string, string>();
  readonly #restored = new Set<string>();

  constructor(
    private readonly store: RunStore<RunState>,
    private readonly now: () => ISOTime,
  ) {
    this.rebuildOpenIndex();
  }

  open(
    identity: string,
    input: OpenRunInput | ReplayRunInput,
    requestId: string,
  ): { runId: string } {
    const scope = controlScope(identity);
    const key = JSON.stringify([scope, requestId]);
    if (!this.#opened.has(key)) this.rebuildOpenIndex();
    const existing = this.#opened.get(key);
    if (existing !== undefined) {
      const run = this.read(existing);
      return this.replay(
        run,
        findReceipt(run, scope, "open", requestId)!,
        input,
      ) as { runId: string };
    }
    let prepared: OpenRunInput;
    let replay: PreparedReplay | null = null;
    if ("replay" in input) {
      const source = this.read(input.replay.runId);
      replay = prepareReplay(source, input.versions, <T>(ref: ContentRef) =>
        this.readInput<T>(source.runId, ref),
      );
      prepared = replay.input;
    } else {
      validateRunDefinition(input.definition);
      prepared = input;
    }
    const instructions =
      replay === null ? initialInstructions(prepared) : replay.instructions;
    const timestamp = this.now();
    const run = this.store.create(
      {
        date: prepared.definition.scope.date,
        securityId: prepared.definition.scope.security.id,
        mode: prepared.definition.mode,
      },
      (runId, writer) => {
        const definitionRef = writer.input(() => prepared.definition);
        const inputs: RunState["inputs"] = prepared.inputs.map((item) => ({
          name: item.name,
          ref: writer.input(() => item.content),
        }));
        for (const instruction of instructions) {
          const ref = writer.input((): TaskInstructionSnapshot => ({
            ...instruction,
            previous: null,
            baseDefinition: definitionRef,
            recordedAt: timestamp,
          }));
          inputs.push({
            name: `instruction:${instruction.taskId}`,
            ref,
            instruction: {
              taskId: instruction.taskId,
              version: instruction.version,
            },
          });
        }
        const lineage =
          replay === null
            ? null
            : {
                sourceRunId: replay.snapshot.sourceRunId,
                sourceRevision: replay.snapshot.sourceRevision,
                snapshotRef: writer.input(() => replay.snapshot),
              };
        const request = writer.input(() => input);
        return {
          stateVersion: 3,
          lineage,
          scope: prepared.definition.scope,
          mode: prepared.definition.mode,
          definition: prepared.definition,
          definitionRef,
          inputs,
          status: "active",
          tasks: prepared.definition.tasks.map((task) => ({
            taskId: task.id,
            status: "pending",
            attempts: [],
            outputRefs: [],
          })),
          artifacts: [],
          evidence: [],
          receipts: [
            { scope, action: "open", requestId, request, result: { runId } },
          ],
          versions: prepared.versions,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          blockReasons: [],
          ...(prepared.definition.stages === undefined
            ? {}
            : { stageReviews: [] }),
        };
      },
    );
    this.#opened.set(key, run.runId);
    this.#restored.add(run.runId);
    return { runId: run.runId };
  }

  view(operation: Pick<RunOperation, "runId">): RunView {
    const run = this.read(operation.runId);
    const currentRefs = new Set(
      run.tasks.flatMap((task) => task.outputRefs.map(artifactKey)),
    );
    const digest = run.artifacts.findLast(
      (artifact) =>
        artifact.kind === "digest" &&
        currentRefs.has(artifactKey(artifact.ref)),
    );
    return {
      runId: run.runId,
      lineage: run.lineage,
      scope: run.definition.scope,
      mode: run.definition.mode,
      status: run.status,
      readyTasks: run.tasks
        .filter((task) => ready(run, task))
        .map((task) => task.taskId),
      tasks: run.tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        attempt: task.attempts.length,
        outputRefs: task.outputRefs,
        failure: task.attempts.at(-1)?.failure ?? null,
      })),
      currentDigest: digest?.ref ?? null,
      blockReasons: run.blockReasons,
      ...(run.definition.stages === undefined
        ? {}
        : {
            stages: run.definition.stages.map((stage) => stageView(run, stage)),
            stageReviews: run.stageReviews!,
          }),
    };
  }

  reviewStage(
    operation: RunOperation,
    input: StageReviewInput,
    requestId: string,
  ): StageReviewResult {
    return this.mutate<StageReviewResult>(
      operation,
      controlScope(operation.identity),
      "review_stage",
      requestId,
      input,
      (run) => {
        if (run.status === "completed" || run.status === "cancelled")
          throw new ResearchError(
            "ACCESS_DENIED",
            `Run ${run.runId} is ${run.status}.`,
          );
        const stage = run.definition.stages?.find(
          (stage) => stage.id === input.stageId,
        );
        if (stage === undefined)
          throw new ResearchError(
            "INVALID_INPUT",
            `Unknown stage ${input.stageId}.`,
          );
        const view = stageView(run, stage);
        if (!view.readyForReview)
          throw new ResearchError(
            "TASK_NOT_READY",
            `Stage ${input.stageId} review requires complete outputs and no running or succeeded downstream task.`,
          );
        if (!equalRefs(input.refs, view.refs))
          throw new ResearchError(
            "STALE_ATTEMPT",
            `Stage ${input.stageId} review must reference exactly its current outputs.`,
          );
        if (input.verdict !== "accepted" && input.verdict !== "rejected")
          throw new ResearchError(
            "INVALID_INPUT",
            "Unknown stage review verdict.",
          );
        if (input.feedback.trim().length === 0)
          throw new ResearchError(
            "INVALID_INPUT",
            "A stage review requires feedback.",
          );
        const review = {
          ...structuredClone(input),
          identity: operation.identity,
          recordedAt: run.updatedAt,
          requestId,
        };
        run.stageReviews!.push(review);
        return { runId: run.runId, review };
      },
    );
  }

  claim(
    operation: RunOperation,
    taskId: string,
    requestId: string,
  ): ClaimResult {
    return this.mutate<ClaimResult>(
      operation,
      controlScope(operation.identity),
      "claim",
      requestId,
      { taskId },
      (run) => {
        const task = taskState(run, taskId);
        if (!ready(run, task))
          throw new ResearchError(
            "TASK_NOT_READY",
            `Task ${taskId} is not ready in run ${run.runId}.`,
          );
        const definition = run.definition.tasks.find(
          (definition) => definition.id === taskId,
        )!;
        const inputRefs = definition.inputTasks.flatMap(
          (id) => taskState(run, id).outputRefs,
        );
        const attempt = task.attempts.length + 1;
        const revised = latestInstruction(run, taskId);
        const instruction =
          revised === undefined ? {} : { instructionRef: revised.ref };
        task.status = "running";
        task.attempts.push({
          number: attempt,
          status: "running",
          inputRefs,
          outputRefs: [],
          instructionVersion: definition.instructionVersion,
          ...instruction,
          sessionId: null,
          startedAt: run.updatedAt,
          endedAt: null,
          failure: null,
        });
        return {
          runId: run.runId,
          taskId,
          attempt,
          inputRefs,
          instructionVersion: definition.instructionVersion,
          ...instruction,
        };
      },
    );
  }

  commitArtifact(
    operation: TaskOperation,
    contents: readonly ArtifactInput[],
    requestId: string,
    decisionValidation?: DecisionDraftValidation,
  ): ArtifactCommitResult {
    return this.submit(
      operation,
      contents,
      requestId,
      false,
      decisionValidation,
    );
  }

  artifactForCall(
    operation: TaskOperation,
    contents: unknown,
    requestId: string,
  ): ArtifactCommitResult | null {
    const run = this.read(operation.runId);
    const receipt = findReceipt(
      run,
      taskScope(operation),
      "commit_artifact",
      requestId,
    );
    if (receipt === undefined) return null;
    const result = this.replay(run, receipt, {
      contents,
    }) as ArtifactCommitResult;
    this.repairProjections(operation.runId);
    return result;
  }

  finalize(
    operation: TaskOperation,
    decision: ArtifactInput,
    report: ArtifactInput,
    requestId: string,
  ): ArtifactCommitResult {
    return this.submit(operation, [decision, report], requestId, true);
  }

  claimService(
    operation: RunOperation,
    taskId: string,
    service: "digest" | "finalize",
    requestId: string,
  ): ClaimResult {
    const definition = this.read(operation.runId).definition.tasks.find(
      (task) => task.id === taskId,
    );
    if (
      definition?.executor.kind !== "service" ||
      definition.executor.service !== service
    )
      throw new ResearchError(
        "INVALID_INPUT",
        `Task ${taskId} is not a ${service} service task.`,
      );
    return this.claim(operation, taskId, requestId);
  }

  claimServiceForCall(
    operation: RunOperation,
    taskId: string,
    service: "digest" | "finalize",
    requestId: string,
  ): { claim: ClaimResult; replayed: boolean } {
    const replayed =
      findReceipt(
        this.read(operation.runId),
        controlScope(operation.identity),
        "claim",
        requestId,
      ) !== undefined;
    return {
      claim: this.claimService(operation, taskId, service, requestId),
      replayed,
    };
  }

  hasClaimReceipt(operation: RunOperation, requestId: string): boolean {
    return (
      findReceipt(
        this.read(operation.runId),
        controlScope(operation.identity),
        "claim",
        requestId,
      ) !== undefined
    );
  }

  hasStageDispatchReceipt(
    operation: RunOperation,
    stageId: string,
    requestId: string,
  ): boolean {
    const run = this.read(operation.runId);
    const receipt = findReceipt(
      run,
      controlScope(operation.identity),
      "dispatch_stage",
      requestId,
    );
    if (receipt === undefined) return false;
    this.replay(run, receipt, { stageId });
    return true;
  }

  recordStageDispatch(
    operation: RunOperation,
    stageId: string,
    requestId: string,
  ): void {
    this.mutate(
      operation,
      controlScope(operation.identity),
      "dispatch_stage",
      requestId,
      { stageId },
      () => ({ runId: operation.runId }),
    );
  }

  dispatchForCall(
    operation: RunOperation,
    taskId: string,
    requestId: string,
  ): RoleDispatchContext {
    const run = this.read(operation.runId);
    const definition = run.definition.tasks.find((task) => task.id === taskId);
    if (definition?.executor.kind !== "role")
      throw new ResearchError(
        "INVALID_INPUT",
        `Task ${taskId} is not a role task.`,
      );
    const replayed =
      findReceipt(run, controlScope(operation.identity), "claim", requestId) !==
      undefined;
    const claim = this.claim(operation, taskId, requestId);
    return {
      claim,
      scope: run.scope,
      definition: {
        ...definition,
        executor: definition.executor,
        instructionVersion: claim.instructionVersion,
      },
      attempt: this.readAttempt(claim),
      replayed,
    };
  }

  /** Read the exact claimed attempt, including invalidated historical attempts. */
  readAttempt(
    operation: Pick<TaskOperation, "runId" | "taskId" | "attempt">,
  ): TaskAttempt {
    return taskState(this.read(operation.runId), operation.taskId).attempts[
      operation.attempt - 1
    ]!;
  }

  /** Associate an actual host child before its first input can execute. */
  bindTaskSession(operation: TaskOperation & { sessionId: string }): void {
    this.store.commit(operation.runId, (run) => {
      const { attempt } = currentAttempt(run, operation);
      attempt.sessionId = operation.sessionId;
      run.updatedAt = this.now();
      return run;
    });
  }

  serviceForCall(
    operation: TaskOperation,
    requestId: string,
    action: "commit_artifact" | "finalize",
  ): {
    result: ArtifactCommitResult | null;
    context: Pick<ResearchRun, "scope" | "definition" | "tasks">;
  } {
    const run = this.read(operation.runId);
    const context = {
      scope: run.scope,
      definition: run.definition,
      tasks: run.tasks,
    };
    const receipt = findReceipt(run, taskScope(operation), action, requestId);
    if (receipt !== undefined) {
      this.repairProjections(operation.runId);
      return { result: receipt.result as ArtifactCommitResult, context };
    }
    currentAttempt(run, operation);
    return { result: null, context };
  }

  failAttempt(
    operation: TaskOperation,
    failure: TaskFailure,
    requestId: string,
  ): AttemptFailureResult {
    return this.mutate<AttemptFailureResult>(
      operation,
      taskScope(operation),
      "fail_attempt",
      requestId,
      { failure },
      (run) => {
        const { task, attempt } = currentAttempt(run, operation);
        task.status = "failed";
        attempt.status = "failed";
        attempt.endedAt = run.updatedAt;
        attempt.sessionId = operation.sessionId;
        attempt.failure = failure;
        return {
          runId: run.runId,
          taskId: task.taskId,
          attempt: attempt.number,
        };
      },
    );
  }

  failServiceAttempt(
    operation: TaskOperation,
    failure: TaskFailure,
    requestId: string,
  ): AttemptFailureResult | null {
    const run = this.read(operation.runId);
    const attempt = taskState(run, operation.taskId).attempts.at(-1)!;
    if (
      (run.status !== "active" && run.status !== "blocked") ||
      attempt.number !== operation.attempt ||
      attempt.status !== "running"
    )
      return null;
    return this.failAttempt(operation, failure, requestId);
  }

  cancel(operation: RunOperation, requestId: string): CancelRunResult {
    return this.mutate<CancelRunResult>(
      operation,
      controlScope(operation.identity),
      "cancel",
      requestId,
      {},
      cancelRun,
    );
  }

  block(
    operation: RunOperation,
    reasons: readonly BlockReasonInput[],
    requestId: string,
  ): BlockRunResult {
    return this.mutate<BlockRunResult>(
      operation,
      controlScope(operation.identity),
      "block",
      requestId,
      { reasons },
      (run) => blockRun(run, reasons),
    );
  }

  resume(
    operation: RunOperation,
    input: ResumeRunInput,
    requestId: string,
  ): ResumeRunResult {
    return this.mutate<ResumeRunResult>(
      operation,
      controlScope(operation.identity),
      "resume",
      requestId,
      { input },
      (run, writer) => resumeRun(run, input, writer),
    );
  }

  redo(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    reason: string | null = null,
  ): RedoTaskResult {
    return this.mutate<RedoTaskResult>(
      operation,
      controlScope(operation.identity),
      "redo",
      requestId,
      { taskId, reason },
      (run) => redoRun(run, taskId, (ref) => this.readArtifact(ref)),
    );
  }

  recoverInterrupted(
    operation: RunOperation,
    targets: readonly AttemptTarget[],
    failure: TaskFailure,
    requestId: string,
  ): RecoverAttemptsResult {
    return this.mutate<RecoverAttemptsResult>(
      operation,
      controlScope(operation.identity),
      "recover_attempts",
      requestId,
      { targets, failure },
      (run) => recoverAttempts(run, targets, failure),
    );
  }

  evidenceForCall(
    operation: TaskOperation,
    query: EvidenceQuery,
    callId: string,
    source: ReplayEvidenceSource | null = null,
  ): EvidenceCall {
    const run = this.read(operation.runId);
    if (source !== null && run.lineage === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "An original evidence selection requires a replay run.",
      );
    const { scope, lineage, result } = this.taskDataCall<SourceRef>(
      run,
      operation,
      run.lineage === null ? "record_evidence" : "replay_evidence",
      run.lineage === null ? query : evidenceReplayRequest(query, source),
      callId,
    );
    return { scope, lineage, sourceRef: result };
  }

  memoryInputForCall(
    operation: TaskOperation,
    query: MemoryInputQuery,
    callId: string,
    source: MemoryInputRegistration | null = null,
  ): MemoryInputCall {
    const run = this.read(operation.runId);
    if (source !== null && run.lineage === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "An original memory selection requires a replay run.",
      );
    const { scope, lineage, result } =
      this.taskDataCall<MemoryInputRegistration>(
        run,
        operation,
        run.lineage === null ? "record_memory_input" : "replay_memory_input",
        run.lineage === null ? query : { query, source },
        callId,
      );
    return {
      scope,
      lineage,
      inputRef: result === null ? null : result.inputRef,
    };
  }

  recordEvidence<T>(
    operation: TaskOperation,
    query: EvidenceQuery,
    input: EvidenceInput<T>,
    callId: string,
  ): SourceRef {
    return this.mutate<SourceRef>(
      operation,
      taskScope(operation),
      "record_evidence",
      callId,
      query,
      (run, writer) => {
        freshData(run);
        return persistEvidence(run, writer, operation, query, input, callId);
      },
    );
  }

  recordMemoryInput<T>(
    operation: TaskOperation,
    query: MemoryInputQuery,
    entries: readonly MemorySnapshotEntry<T>[],
    callId: string,
  ): MemoryInputRegistration {
    return this.mutate<MemoryInputRegistration>(
      operation,
      taskScope(operation),
      "record_memory_input",
      callId,
      query,
      (run, writer) => {
        freshData(run);
        return persistMemoryInput(
          run,
          writer,
          operation,
          query,
          entries,
          callId,
        );
      },
    );
  }

  recordValuationCalculation(
    operation: TaskOperation,
    calculation: Omit<
      ValuationCalculation,
      "kind" | "calculationId" | "runId" | "taskId" | "attempt" | "createdAt"
    >,
    callId: string,
  ): ValuationCalculationRegistration {
    return this.mutate<ValuationCalculationRegistration>(
      operation,
      taskScope(operation),
      "record_valuation_calculation",
      callId,
      calculation,
      (run, writer) => {
        currentAttempt(run, operation);
        const ref = writer.input((calculationId): ValuationCalculation => ({
          ...calculation,
          kind: "valuation-calculation",
          calculationId,
          runId: run.runId,
          taskId: operation.taskId,
          attempt: operation.attempt,
          createdAt: run.updatedAt,
        }));
        run.inputs.push({
          name: "valuation-calculation",
          ref,
          calculation: {
            taskId: operation.taskId,
            attempt: operation.attempt,
            dependencies: valuationDependencyIds(calculation.request),
          },
        });
        return { runId: run.runId, calculationId: ref.id };
      },
    );
  }

  valuationCalculationForCall(
    operation: TaskOperation,
    request: ValuationCalculation["request"],
    callId: string,
  ): ValuationCalculation | null {
    const run = this.read(operation.runId);
    const receipt = findReceipt(
      run,
      taskScope(operation),
      "record_valuation_calculation",
      callId,
    );
    if (receipt === undefined) {
      currentAttempt(run, operation);
      return null;
    }
    const saved = this.store.readContent<{
      request: ValuationCalculation["request"];
    }>(operation.runId, receipt.request);
    if (!isDeepStrictEqual(saved.request, request))
      throw new ResearchError(
        "REQUEST_CONFLICT",
        `Request ${callId} has different content.`,
      );
    return this.store.readContent(operation.runId, {
      kind: "input",
      id: (receipt.result as ValuationCalculationRegistration).calculationId,
    });
  }

  replayEvidence(
    operation: TaskOperation,
    query: EvidenceQuery,
    callId: string,
    source: ReplayEvidenceSource | null = null,
  ): SourceRef {
    const prepared = this.evidenceForCall(operation, query, callId, source);
    if (prepared.lineage === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "Saved evidence replay requires a derived run.",
      );
    if (prepared.sourceRef !== null) return prepared.sourceRef;
    const selected = selectReplayEvidence(
      this.replaySnapshot(operation.runId)!,
      operation.taskId,
      prepared.scope,
      query,
      source,
      this.replayReads(),
    );
    const { candidateClaims, ...envelope } = selected.record.envelope;
    const candidates = candidateClaims.map(({ source, ...candidate }) => ({
      ...candidate,
      selector: source.selector,
    }));
    return this.mutate<SourceRef>(
      operation,
      taskScope(operation),
      "replay_evidence",
      callId,
      evidenceReplayRequest(query, source),
      (run, writer) =>
        persistEvidence(
          run,
          writer,
          operation,
          query,
          { envelope, candidates },
          callId,
          selected.source,
        ),
    );
  }

  replayMemoryInput(
    operation: TaskOperation,
    query: MemoryInputQuery,
    callId: string,
    source: MemoryInputRegistration | null = null,
  ): MemoryInputRegistration {
    const prepared = this.memoryInputForCall(operation, query, callId, source);
    if (prepared.lineage === null)
      throw new ResearchError(
        "INVALID_INPUT",
        "Saved memory replay requires a derived run.",
      );
    if (prepared.inputRef !== null)
      return { runId: operation.runId, inputRef: prepared.inputRef };
    const selected = selectReplayMemory(
      this.replaySnapshot(operation.runId)!,
      operation.taskId,
      prepared.scope,
      query,
      source,
      this.replayReads(),
    );
    return this.mutate<MemoryInputRegistration>(
      operation,
      taskScope(operation),
      "replay_memory_input",
      callId,
      { query, source },
      (run, writer) =>
        persistMemoryInput(
          run,
          writer,
          operation,
          query,
          selected.record.entries,
          callId,
          selected.source,
        ),
    );
  }

  readEvidence<T>(
    ref: Pick<SourceRef, "runId" | "evidenceId">,
  ): RegisteredEvidenceRecord<T> {
    return this.store.readContent(ref.runId, {
      kind: "evidence",
      id: ref.evidenceId,
    });
  }

  readInput<T>(runId: string, ref: ContentRef): T {
    return this.store.readContent(runId, ref);
  }

  inputCatalog(runId: string): RunInputCatalog {
    const { versions, inputs } = this.read(runId);
    return structuredClone({ versions, inputs });
  }

  readDefinition(runId: string): OpenRunInput["definition"] {
    return structuredClone(this.read(runId).definition);
  }

  replaySnapshot(runId: string): ReplaySnapshot | null {
    const lineage = this.read(runId).lineage;
    return lineage === null
      ? null
      : this.readInput<ReplaySnapshot>(runId, lineage.snapshotRef);
  }

  numberContext(runId: string): NumberContext {
    const run = this.read(runId);
    return {
      runId,
      scope: run.scope,
      tasks: run.tasks,
      evidence: run.evidence,
      artifacts: run.artifacts,
    };
  }

  readArtifact(ref: ArtifactRef): ArtifactVersion {
    return this.store.readContent(ref.runId, {
      kind: "artifact",
      id: ref.artifactId,
      revision: ref.revision,
    });
  }

  repairProjections(runId: string): void {
    const run = this.read(runId);
    const currentRefs = new Set(
      run.tasks.flatMap((task) => task.outputRefs.map(artifactKey)),
    );
    const fixed = new Map<string, ProjectionWrite>();
    const named = new Map<string, ProjectionWrite>();
    for (const artifact of run.artifacts) {
      if (!currentRefs.has(artifactKey(artifact.ref))) continue;
      const version = this.readArtifact(artifact.ref);
      const kind = artifact.kind;
      const content =
        kind === "decision"
          ? `${JSON.stringify(version.content.payload, null, 2)}\n`
          : renderArtifact(version.content);
      if (kind === "analysis" || kind === "debate" || kind === "risk") {
        const directory = kind === "analysis" ? "reports" : "debate";
        const key = `${directory}/${artifact.taskId}`;
        const existing = named.get(key);
        named.set(key, {
          target: { directory, name: artifact.taskId },
          content:
            existing === undefined
              ? content
              : `${existing.content}\n---\n\n${content}`,
        });
      } else {
        const filename = FIXED_VIEWS[kind];
        fixed.set(filename, { target: { filename }, content });
      }
    }
    this.store.syncProjections(runId, run.revision, [
      ...named.values(),
      ...fixed.values(),
    ]);
  }

  private submit(
    operation: TaskOperation,
    contents: readonly ArtifactInput[],
    requestId: string,
    finalize: boolean,
    decisionValidation?: DecisionDraftValidation,
  ): ArtifactCommitResult {
    const action = finalize ? "finalize" : "commit_artifact";
    return this.mutate<ArtifactCommitResult>(
      operation,
      taskScope(operation),
      action,
      requestId,
      { contents },
      (run, writer) => {
        const { task, attempt } = currentAttempt(run, operation);
        const definition = run.definition.tasks.find(
          (definition) => definition.id === task.taskId,
        )!;
        const finalTask =
          definition.executor.kind === "service" &&
          definition.executor.service === "finalize";
        if (finalTask !== finalize)
          throw new ResearchError(
            "INVALID_ARTIFACT",
            `Task ${task.taskId} requires the ${finalTask ? "finalize" : "artifact"} submission entry.`,
          );
        if (
          contents.length !== definition.outputKinds.length ||
          new Set(contents.map((content) => content.kind)).size !==
            contents.length ||
          contents.some(
            (content) => !definition.outputKinds.includes(content.kind),
          )
        )
          throw new ResearchError(
            "INVALID_ARTIFACT",
            `Task ${task.taskId} must publish its complete declared output set.`,
          );
        assertFreshInputs(run, task.taskId, attempt.number, contents);
        if (
          finalize &&
          (run.status !== "active" ||
            run.tasks.some(
              (other) => other !== task && other.status !== "succeeded",
            ))
        )
          throw new ResearchError(
            "DATA_INSUFFICIENT",
            "Finalization requires an active run and all other tasks succeeded.",
          );
        const refs = contents.map((content) => {
          const previous = run.artifacts.findLast(
            (artifact) =>
              artifact.taskId === task.taskId && artifact.kind === content.kind,
          );
          const stored = writer.artifact(
            previous === undefined
              ? null
              : {
                  kind: "artifact",
                  id: previous.ref.artifactId,
                  revision: previous.ref.revision,
                },
            (ref): ArtifactVersion => ({
              ref: {
                runId: run.runId,
                artifactId: ref.id,
                revision: ref.revision,
              },
              taskId: task.taskId,
              attempt: attempt.number,
              producerSessionId: operation.sessionId,
              createdAt: run.updatedAt,
              schemaVersion: 1,
              ...(content.kind === "decision_draft" &&
              decisionValidation !== undefined
                ? { decisionValidation }
                : {}),
              content,
            }),
          );
          const ref = {
            runId: run.runId,
            artifactId: stored.id,
            revision: stored.revision,
          };
          run.artifacts.push({
            ref,
            kind: content.kind,
            taskId: task.taskId,
            attempt: attempt.number,
            createdAt: run.updatedAt,
          });
          return ref;
        });
        task.status = "succeeded";
        task.outputRefs = refs;
        attempt.status = "succeeded";
        attempt.outputRefs = refs;
        attempt.endedAt = run.updatedAt;
        attempt.sessionId = operation.sessionId;
        if (finalize) {
          run.status = "completed";
          run.completedAt = run.updatedAt;
        }
        return {
          runId: run.runId,
          taskId: task.taskId,
          attempt: attempt.number,
          refs,
        };
      },
    );
  }

  private taskDataCall<Result extends SourceRef | MemoryInputRegistration>(
    run: ResearchRun,
    operation: TaskOperation,
    action:
      | "record_evidence"
      | "record_memory_input"
      | "replay_evidence"
      | "replay_memory_input",
    query:
      | EvidenceQuery
      | MemoryInputQuery
      | ReplayEvidenceRequest
      | ReplayMemoryRequest,
    callId: string,
  ): {
    scope: ResearchScope;
    lineage: RunState["lineage"];
    result: Result | null;
  } {
    const receipt = findReceipt(run, taskScope(operation), action, callId);
    if (receipt !== undefined)
      return {
        scope: run.scope,
        lineage: run.lineage,
        result: this.replay(run, receipt, query) as Result,
      };
    currentAttempt(run, operation);
    return { scope: run.scope, lineage: run.lineage, result: null };
  }

  private replayReads(): ReplayDataReader {
    const queries = <Q>(
      refs: readonly (ReplayEvidenceSource | MemoryInputRegistration)[],
    ): { scope: ResearchScope; query: Q }[] => {
      const groups = new Map<
        string,
        { ref: ReplayEvidenceSource | MemoryInputRegistration; index: number }[]
      >();
      refs.forEach((ref, index) => {
        let group = groups.get(ref.runId);
        if (group === undefined) {
          group = [];
          groups.set(ref.runId, group);
        }
        group.push({ ref, index });
      });
      const result: { scope: ResearchScope; query: Q }[] = [];
      for (const [runId, group] of groups) {
        const run = this.read(runId);
        const receipts = group.map(({ ref }) =>
          run.receipts.find((entry) =>
            "evidenceId" in ref
              ? (entry.action === "record_evidence" ||
                  entry.action === "replay_evidence") &&
                "evidenceId" in entry.result &&
                entry.result.evidenceId === ref.evidenceId
              : (entry.action === "record_memory_input" ||
                  entry.action === "replay_memory_input") &&
                "inputRef" in entry.result &&
                isDeepStrictEqual(entry.result.inputRef, ref.inputRef),
          )!,
        );
        const bodies = this.store.readContents<Q | { query: Q }>(
          runId,
          receipts.map((receipt) => receipt.request),
        );
        group.forEach(({ index }, item) => {
          const action = receipts[item]!.action;
          const body = bodies[item]!;
          result[index] = {
            scope: run.scope,
            query:
              action === "replay_evidence" || action === "replay_memory_input"
                ? (body as { query: Q }).query
                : (body as Q),
          };
        });
      }
      return result;
    };
    return {
      artifact: (ref) => this.readArtifact(ref),
      evidence: (ref) => this.readEvidence<unknown>(ref),
      memory: (ref) =>
        this.readInput<MemoryInputSnapshot<unknown>>(ref.runId, ref.inputRef),
      evidenceQueries: (refs) => queries<EvidenceQuery>(refs),
      memoryQueries: (refs) => queries<MemoryInputQuery>(refs),
    };
  }

  private mutate<Result extends RunWriteResult>(
    operation: RunOperation,
    scope: string,
    action: ReceiptAction,
    requestId: string,
    request: unknown,
    apply: (run: ResearchRun, writer: ContentWriter) => Result,
  ): Result {
    const current = this.read(operation.runId);
    const repairsViews =
      action === "commit_artifact" ||
      action === "finalize" ||
      action === "redo";
    const receipt = findReceipt(current, scope, action, requestId);
    if (receipt !== undefined) {
      const result = this.replay(current, receipt, request) as Result;
      if (repairsViews) this.repairProjections(operation.runId);
      return result;
    }
    let result: Result;
    this.store.commit(operation.runId, (run, writer) => {
      run.updatedAt = this.now();
      result = apply(run, writer);
      const input = writer.input(() => request);
      run.receipts.push({ scope, action, requestId, request: input, result });
      return run;
    });
    if (repairsViews) this.repairProjections(operation.runId);
    return result!;
  }

  private replay(
    run: ResearchRun,
    receipt: RunReceipt,
    request: unknown,
  ): RunWriteResult {
    const previous = this.store.readContent(run.runId, receipt.request);
    // Compare persisted JSON values; object key order is not request identity.
    if (!isDeepStrictEqual(previous, JSON.parse(JSON.stringify(request))))
      throw new ResearchError(
        "REQUEST_CONFLICT",
        `Request ${receipt.requestId} has different content.`,
      );
    return receipt.result;
  }

  private read(runId: string): ResearchRun {
    const run = this.store.read(runId);
    if (!this.#restored.has(runId)) {
      assertStoredRun(run);
      this.#restored.add(runId);
    }
    return run;
  }

  private rebuildOpenIndex(): void {
    this.#opened.clear();
    for (const stored of this.store.list()) {
      const run = this.read(stored.runId);
      for (const receipt of run.receipts) {
        if (receipt.action !== "open") continue;
        const key = JSON.stringify([receipt.scope, receipt.requestId]);
        if (this.#opened.has(key))
          throw new ResearchError(
            "STORAGE_FAILED",
            "Duplicate run creation receipt.",
          );
        this.#opened.set(key, run.runId);
      }
    }
  }
}

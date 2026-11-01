import type {
  DecisionResult,
  ResearchArtifactInput,
} from "../contracts/artifact-payloads.js";
import type { ISOTime } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  ArtifactCommitResult,
  RunOperation,
  TaskOperation,
} from "../contracts/runs.js";
import { renderDecisionReport } from "../report/decision.js";
import { selectDecisionInputs } from "./decision-basics.js";
import { ArtifactInputs } from "./artifact-inputs.js";
import { summarizeArtifactGaps } from "../artifacts/gaps.js";
import type { RunCommands, RunReader } from "../contracts/run-access.js";

export class DecisionService {
  constructor(
    private readonly runs: Pick<
      RunReader,
      "readArtifact" | "readEvidence" | "readInputs" | "numberContext"
    > &
      Pick<
        RunCommands,
        "claimService" | "serviceForCall" | "finalize" | "block" | "failAttempt"
      >,
    private readonly now: () => ISOTime,
  ) {}

  decide(
    operation: RunOperation,
    taskId: string,
    requestId: string,
    signal?: AbortSignal,
  ): ArtifactCommitResult {
    signal?.throwIfAborted();
    const claimed = this.runs.claimService(
      operation,
      taskId,
      "finalize",
      JSON.stringify(["decide", taskId, requestId]),
    );
    const taskOperation: TaskOperation = {
      ...claimed,
      identity: operation.identity,
      sessionId: null,
    };
    const call = this.runs.serviceForCall(taskOperation, requestId, "finalize");
    if (call.result !== null) return call.result;
    const inputs = new ArtifactInputs(this.runs);
    let decision: ResearchArtifactInput;
    let report: ResearchArtifactInput;
    try {
      const selected = selectDecisionInputs(
        claimed.inputRefs.map((ref) => inputs.artifact(ref)),
      );
      const roots = call.context.tasks.flatMap((task) => task.outputRefs);
      const versions = inputs.closure(roots);
      const validated = selected.draft.decisionValidation;
      if (validated?.version !== 2)
        throw new ResearchError(
          "INVALID_ARTIFACT",
          "The decision draft has no current submission validation; resubmit the manager draft.",
        );
      const proposal = selected.draft.content.payload;
      const base =
        proposal.basePrice === null
          ? null
          : inputs.number(proposal.basePrice, selected.draft.ref).claim;
      const target =
        proposal.targetPrice === null
          ? null
          : inputs.number(proposal.targetPrice, selected.draft.ref).claim;
      const gaps = inputs.reportedGaps(versions);
      const inputRefs = versions.map((version) => version.ref);
      const searchTimes = versions
        .flatMap((version) => inputs.artifactSources(version.ref))
        .map((source) => inputs.source(source).envelope)
        .filter((envelope) => envelope.dataset === "research")
        .map((envelope) => envelope.retrievedAt)
        .sort();
      const result: DecisionResult = {
        ...structuredClone(selected.draft.content.payload),
        schemaVersion: 2,
        runId: operation.runId,
        securityId: call.context.scope.security.id,
        cutoff: call.context.scope.cutoff,
        draftRef: selected.draft.ref,
        inputRefs,
        computedReturn: validated.computedReturn,
        validation: {
          checkedRefs: inputRefs,
          warnings: validated.warnings,
          dataQuality: summarizeArtifactGaps(gaps),
        },
        finalizedAt: this.now(),
      };
      const sections = versions.filter(
        (version) =>
          version.content.kind !== "digest" &&
          version.content.kind !== "collection",
      );
      const digests = versions.filter(
        (version) => version.content.kind === "digest",
      );
      decision = {
        kind: "decision",
        title: "Final decision",
        body: "Final decision is recorded in the structured payload.",
        inputRefs,
        claims: [],
        payload: result,
      };
      const rendered = renderDecisionReport(
        result,
        { base, target },
        [...sections, ...digests],
        searchTimes.at(-1) ?? null,
        [
          ...(proposal.basePrice === null
            ? []
            : inputs
                .numberSources(proposal.basePrice, selected.draft.ref)
                .map((ref) => {
                  const record = inputs.source(ref);
                  return {
                    node: "基准价格",
                    capturedAt:
                      record.snapshotAt ?? record.envelope.retrievedAt,
                  };
                })),
          ...versions.flatMap(({ content }) =>
            content.kind === "collection"
              ? [
                  {
                    node: content.title,
                    capturedAt: content.payload.capturedAt,
                  },
                ]
              : [],
          ),
        ],
      );
      report = {
        kind: "report",
        title: `决策报告 ${result.securityId}`,
        // The container renderer supplies the first title line.
        body: rendered.slice(rendered.indexOf("\n") + 1).trimStart(),
        inputRefs,
        claims: [],
        payload: {
          sections: sections.map((version) => version.ref),
          digests: digests.map((version) => version.ref),
          decision: result,
          limitations: result.limitations,
        },
      };
      signal?.throwIfAborted();
      return this.runs.finalize(taskOperation, decision, report, requestId);
    } catch (cause) {
      if (
        !(cause instanceof ResearchError) ||
        cause.code !== "DATA_INSUFFICIENT"
      )
        throw cause;
      const failure = { code: cause.code, message: cause.message };
      try {
        this.runs.block(
          operation,
          [{ taskId, attempt: claimed.attempt, ...failure }],
          JSON.stringify(["decide-block", taskId, claimed.attempt, requestId]),
        );
        this.runs.failAttempt(
          taskOperation,
          failure,
          JSON.stringify(["decide-fail", requestId]),
        );
      } catch (recording) {
        throw new ResearchError(
          "STORAGE_FAILED",
          "Could not record the finalization blockage.",
          {
            cause: new AggregateError(
              [cause, recording],
              "Decision rejection and state recording failure.",
              { cause: recording },
            ),
          },
        );
      }
      throw cause;
    }
  }
}

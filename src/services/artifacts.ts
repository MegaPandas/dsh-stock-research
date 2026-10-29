import type {
  ArtifactVersion,
  DecisionDraftValidation,
} from "../contracts/artifacts.js";
import type { ResearchArtifactInput } from "../contracts/artifact-payloads.js";
import type { ArtifactRef, SourceRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type { NumberCheck } from "../contracts/numbers.js";
import type { EvidenceData } from "../contracts/query.js";
import type { ArtifactCommitResult, TaskOperation } from "../contracts/runs.js";
import type { RegisteredEvidenceRecord } from "../contracts/task-data.js";
import { parseArtifactInput } from "./artifact-schema.js";
import { isStageReport } from "./analysis-report.js";
import { artifactReferences } from "./artifact-references.js";
import { EvidenceTimeError, verifyEvidence } from "./evidence-checks.js";
import { readPointer, referenceField, SelectorError } from "./number-fields.js";
import type { NumberService } from "./numbers.js";
import { artifactKey } from "./run-dependencies.js";
import type { RunService } from "./runs.js";
import {
  ArtifactInputs,
  type ResearchArtifactVersion,
} from "./artifact-inputs.js";
import {
  assessDecisionBasics,
  selectDecisionInputs,
} from "./decision-basics.js";
import { checkDecisionRequirements } from "./decision-requirements.js";
import {
  readValuationCalculation,
  validateCalculatedReport,
  validateCalculatedTarget,
} from "./valuation-calculations.js";

function invalid(detail: string): never {
  throw new ResearchError("INVALID_ARTIFACT", detail);
}
export class ArtifactNumberError extends ResearchError {
  constructor(readonly checks: NumberCheck[]) {
    super(
      "NUMBER_MISMATCH",
      "Artifact numeric claims did not pass validation.",
    );
  }
}

export class ArtifactService {
  constructor(
    private readonly runs: RunService,
    private readonly numbers: NumberService,
  ) {}

  submitArtifact(
    operation: TaskOperation,
    contents: unknown,
    requestId: string,
  ): ArtifactCommitResult {
    const saved = this.runs.artifactForCall(operation, contents, requestId);
    if (saved !== null) return saved;
    const checked = this.validateArtifact(operation, contents, requestId);
    return this.runs.commitArtifact(
      operation,
      checked.contents,
      requestId,
      checked.decisionValidation,
    );
  }

  /** Validate a draft against a fixed task attempt without publishing or changing its lifecycle. */
  validateArtifact(
    operation: TaskOperation,
    contents: unknown,
    contentId: string,
  ): {
    contents: ResearchArtifactInput[];
    decisionValidation?: DecisionDraftValidation;
  } {
    if (!Array.isArray(contents) || contents.length === 0)
      invalid("A submission requires the complete artifact array.");
    const captured = structuredClone(contents.map(parseArtifactInput));
    const definition = this.runs.readDefinition(operation.runId);
    const valuation = definition.tasks.find(
      ({ id }) => id === operation.taskId,
    )!.valuation;
    for (const content of captured) {
      if (
        ((valuation === "research" && content.kind === "analysis") ||
          (valuation === "decision" && content.kind === "decision_draft")) &&
        !("report" in content.payload)
      )
        invalid(
          "This task requires a report referencing saved valuation calculation results.",
        );
      if (content.kind === "analysis" && "report" in content.payload)
        validateCalculatedReport(
          this.runs,
          operation.runId,
          content.payload.report,
          valuation,
        );
      if (
        content.kind === "decision_draft" &&
        content.payload.report !== undefined
      ) {
        if ("rating" in content.payload.report.content)
          invalid(
            "Decision submission requires the current calculated report contract.",
          );
        validateCalculatedReport(
          this.runs,
          operation.runId,
          content.payload.report,
          valuation,
        );
        validateCalculatedTarget(
          content.payload,
          content.claims,
          definition.scope.security.currency,
        );
      }
    }
    this.checkReferences(operation, captured);
    const checks = captured.flatMap((content, index) =>
      isStageReport(content) && content.claims.length === 0
        ? []
        : [
            this.numbers.checkNumbers(operation, {
              kind: "pending",
              contentId: `${contentId}/${index}`,
              content,
            }),
          ],
    );
    if (checks.some((check) => !check.passed))
      throw new ArtifactNumberError(checks);
    const draft = captured.find((content) => content.kind === "decision_draft");
    if (draft === undefined) return { contents: captured };
    const context = this.runs.numberContext(operation.runId);
    const pending: ResearchArtifactVersion = {
      ref: {
        runId: operation.runId,
        artifactId: "pending:decision-draft",
        revision: 1,
      },
      taskId: operation.taskId,
      attempt: operation.attempt,
      producerSessionId: operation.sessionId,
      createdAt: context.scope.cutoff,
      schemaVersion: 1,
      content: draft,
    };
    const inputs = new ArtifactInputs(this.runs, [pending]);
    const selected = selectDecisionInputs([
      pending,
      ...draft.inputRefs.map((ref) => inputs.artifact(ref)),
    ]);
    const basics = assessDecisionBasics(context.scope, selected, inputs);
    const warnings = [...basics.warnings];
    try {
      checkDecisionRequirements(
        definition.tasks,
        [
          ...context.tasks
            .flatMap((task) => task.outputRefs)
            .map((ref) => inputs.artifact(ref)),
          pending,
        ],
        inputs,
        context.scope.cutoff,
      );
    } catch (cause) {
      if (
        !(cause instanceof ResearchError) ||
        cause.code !== "DATA_INSUFFICIENT"
      )
        throw cause;
      warnings.push(cause.message);
    }
    return {
      contents: captured,
      decisionValidation: {
        version: 2,
        computedReturn: basics.computedReturn,
        warnings: [...new Set(warnings)],
      },
    };
  }

  private checkReferences(
    operation: TaskOperation,
    contents: ResearchArtifactInput[],
  ): void {
    const context = this.runs.numberContext(operation.runId);
    const attempt = context.tasks
      .find((task) => task.taskId === operation.taskId)!
      .attempts.find((attempt) => attempt.number === operation.attempt)!;
    const registered = new Set(
      context.artifacts.map((entry) => artifactKey(entry.ref)),
    );
    const artifacts = new Map<string, ArtifactVersion>();
    const evidence = new Map<string, RegisteredEvidenceRecord<EvidenceData>>();
    const checkedSources = new Set<string>();
    const sourceRecord = (ref: SourceRef) => {
      if (ref.runId !== context.runId)
        invalid("Payload evidence must belong to the authorized run.");
      const entry = context.evidence.find(
        (entry) => entry.evidenceId === ref.evidenceId,
      );
      if (entry === undefined) invalid("Payload evidence is not registered.");
      let record = evidence.get(ref.evidenceId);
      if (record === undefined) {
        record = this.runs.readEvidence<EvidenceData>(ref);
        evidence.set(ref.evidenceId, record);
      }
      return { entry, record };
    };
    for (const content of contents) {
      const declared = new Set(content.inputRefs.map(artifactKey));
      const allowArtifact = (ref: ArtifactRef): ArtifactVersion => {
        if (ref.runId !== context.runId || !registered.has(artifactKey(ref)))
          invalid(
            "An artifact input must be registered in the authorized run.",
          );
        if (!declared.has(artifactKey(ref)))
          invalid(
            "Every adopted artifact version must be declared in inputRefs.",
          );
        const key = artifactKey(ref);
        let version = artifacts.get(key);
        if (version === undefined) {
          version = this.runs.readArtifact(ref);
          artifacts.set(key, version);
        }
        return version;
      };
      for (const ref of content.inputRefs) allowArtifact(ref);
      for (const ref of attempt.inputRefs)
        if (!declared.has(artifactKey(ref)))
          invalid(
            "The claimed default input version is missing from inputRefs.",
          );
      const claimIds = new Set(content.claims.map((claim) => claim.id));
      for (const match of content.body.matchAll(/\{\{number:([^{}]+)\}\}/g))
        if (!claimIds.has(match[1]!))
          invalid(`Body placeholder refers to missing claim ${match[1]}.`);
      if (
        /\{\{number\b/.test(
          content.body.replace(/\{\{number:([^{}]+)\}\}/g, ""),
        )
      )
        invalid("Malformed body number placeholder.");
      const refs = artifactReferences(content);
      for (const id of refs.calculations)
        readValuationCalculation(this.runs, operation.runId, id);
      for (const ref of refs.artifacts) allowArtifact(ref);
      if (content.kind === "digest") {
        const upstream = new Set(content.payload.upstreamRefs.map(artifactKey));
        if (
          upstream.size !== declared.size ||
          [...declared].some((key) => !upstream.has(key))
        )
          invalid("Digest upstreamRefs must match inputRefs.");
      }
      for (const input of refs.numbers) {
        if (input.kind === "local") {
          if (!claimIds.has(input.claimId))
            invalid(`Payload refers to missing local claim ${input.claimId}.`);
        } else {
          const version = allowArtifact(input.artifact);
          if (
            !version.content.claims.some((claim) => claim.id === input.claimId)
          )
            invalid(
              "Payload numeric input is absent from its fixed artifact version.",
            );
        }
      }
      for (const ref of refs.sources) {
        const key = JSON.stringify(ref);
        if (checkedSources.has(key)) continue;
        const { entry, record } = sourceRecord(ref);
        const latest = context.tasks
          .find((task) => task.taskId === entry.taskId)!
          .attempts.at(-1)!;
        if (latest.number !== entry.attempt || latest.status === "invalidated")
          invalid("Payload evidence belongs to a superseded attempt.");
        try {
          verifyEvidence(
            context.scope,
            record.envelope,
            ref,
            referenceField(record.envelope, ref.selector),
            [],
          );
        } catch (cause) {
          if (
            !(cause instanceof SelectorError) &&
            !(cause instanceof EvidenceTimeError)
          )
            throw cause;
          throw new ResearchError(
            "INVALID_ARTIFACT",
            `Invalid payload evidence: ${cause.message}`,
            { cause },
          );
        }
        checkedSources.add(key);
      }
      for (const ref of refs.origins) {
        try {
          readPointer(sourceRecord(ref).record.envelope, ref.selector);
        } catch (cause) {
          if (!(cause instanceof SelectorError)) throw cause;
          throw new ResearchError("INVALID_ARTIFACT", cause.message, { cause });
        }
      }
    }
  }
}

import type {
  ArtifactInput,
  ArtifactVersion,
  NumberInput,
  NumericClaim,
} from "../contracts/artifacts.js";
import type { ArtifactRef, SourceRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  ClaimCheck,
  NumberCheck,
  NumberIssueCode,
  NumberTarget,
  NumberWarning,
} from "../contracts/numbers.js";
import type { EvidenceData } from "../contracts/query.js";
import type { RunOperation } from "../contracts/runs.js";
import type { RegisteredEvidenceRecord } from "../contracts/task-data.js";
import { artifactKey } from "./run-dependencies.js";
import { EvidenceTimeError, verifyEvidence } from "./evidence-checks.js";
import { PriceBasisError, verifyPriceBasis } from "./price-basis.js";
import {
  numberField,
  referenceField,
  SelectorError,
  type NumberField,
} from "./number-fields.js";
import type { RunService } from "./runs.js";
import { readValuationCalculation } from "./valuation-calculations.js";

export const NUMBER_CHECK_VERSION = "1";
// Division and subtraction admit binary rounding; this is not a business/display tolerance.
const SIMPLE_RETURN_ROUNDING_OPERATIONS = 2;
class ClaimError extends Error {
  constructor(
    readonly code: NumberIssueCode,
    detail: string,
  ) {
    super(detail);
  }
}
function fail(code: NumberIssueCode, detail: string): never {
  throw new ClaimError(code, detail);
}
interface ResolvedNumber {
  value: number;
  unit: string;
  estimated: boolean;
  source?: SourceRef;
}

export class NumberService {
  constructor(private readonly runs: RunService) {}

  checkNumbers(operation: RunOperation, target: NumberTarget): NumberCheck {
    const captured = structuredClone(target);
    const context = this.runs.numberContext(operation.runId);
    const artifacts = new Map<string, ArtifactVersion>();
    const evidence = new Map<string, RegisteredEvidenceRecord<EvidenceData>>();
    const inputArtifact = (ref: ArtifactRef): ArtifactVersion => {
      if (ref.runId !== context.runId)
        fail(
          "reference",
          "An artifact input must belong to the authorized run.",
        );
      const key = artifactKey(ref);
      if (!context.artifacts.some((entry) => artifactKey(entry.ref) === key))
        fail("reference", "The artifact version is not registered.");
      let version = artifacts.get(key);
      if (version === undefined) {
        version = this.runs.readArtifact(ref);
        artifacts.set(key, version);
      }
      return version;
    };
    let content: ArtifactInput;
    if (captured.kind === "pending") content = captured.content;
    else {
      if (captured.ref.runId !== operation.runId)
        throw new ResearchError(
          "ACCESS_DENIED",
          "The target artifact belongs to another run.",
        );
      if (
        !context.artifacts.some(
          (entry) => artifactKey(entry.ref) === artifactKey(captured.ref),
        )
      )
        throw new ResearchError(
          "INVALID_ARTIFACT",
          "The target artifact version is not registered.",
        );
      content = inputArtifact(captured.ref).content;
    }
    const getEvidence = (
      ref: SourceRef,
      current = captured.kind === "pending",
    ): RegisteredEvidenceRecord<EvidenceData> => {
      if (ref.runId !== context.runId)
        fail("reference", "Evidence must belong to the authorized run.");
      const entry = context.evidence.find(
        (entry) => entry.evidenceId === ref.evidenceId,
      );
      if (entry === undefined)
        fail("reference", "The evidence is not registered.");
      if (current) {
        const latest = context.tasks
          .find((task) => task.taskId === entry.taskId)!
          .attempts.at(-1)!;
        if (latest.number !== entry.attempt || latest.status === "invalidated")
          fail("reference", "The evidence belongs to a superseded attempt.");
      }
      let record = evidence.get(ref.evidenceId);
      if (record === undefined) {
        record = this.runs.readEvidence<EvidenceData>(ref);
        evidence.set(ref.evidenceId, record);
      }
      return record;
    };
    const claims = new Map<string, NumericClaim>();
    const duplicates = new Set<string>();
    for (const claim of content.claims) {
      if (claims.has(claim.id)) duplicates.add(claim.id);
      claims.set(claim.id, claim);
    }
    const checks = new Map<string, ClaimCheck>();
    const resolved = new Map<string, ResolvedNumber>();
    const active = new Set<string>();

    const sourceField = (
      ref: SourceRef,
      numeric: boolean,
      warnings: NumberWarning[],
    ): NumberField | null => {
      const record = getEvidence(ref);
      const field = numeric
        ? numberField(record.envelope, ref.selector)
        : referenceField(record.envelope, ref.selector);
      verifyEvidence(context.scope, record.envelope, ref, field, warnings);
      return numeric ? (field as NumberField) : null;
    };

    const external = (
      input: Extract<NumberInput, { kind: "artifact" }>,
    ): ResolvedNumber => {
      if (
        !content.inputRefs.some(
          (ref) => artifactKey(ref) === artifactKey(input.artifact),
        )
      )
        fail(
          "reference",
          "An adopted numeric artifact must be declared in inputRefs.",
        );
      const saved = inputArtifact(input.artifact).content.claims.find(
        (claim) => claim.id === input.claimId,
      );
      if (saved === undefined)
        fail(
          "reference",
          "The input claim does not exist in the fixed artifact version.",
        );
      // Committed claims were checked at publication; consume their fixed values directly.
      return {
        value: saved.value,
        unit: saved.unit,
        estimated: saved.kind === "estimated",
        ...(saved.kind === "observed" ? { source: saved.source } : {}),
      };
    };
    const inputNumber = (input: NumberInput): ResolvedNumber => {
      if (input.kind === "artifact") return external(input);
      if (!claims.has(input.claimId))
        fail("reference", `Local input ${input.claimId} does not exist.`);
      const number = check(input.claimId);
      if (number === undefined)
        fail("calculation", `Input claim ${input.claimId} failed validation.`);
      return number;
    };
    const check = (id: string): ResolvedNumber | undefined => {
      if (active.has(id)) fail("cycle", `Calculation input cycle at ${id}.`);
      if (checks.has(id)) return resolved.get(id);
      const claim = claims.get(id)!;
      const item: ClaimCheck = {
        claim,
        passed: false,
        issues: [],
        warnings: [],
      };
      active.add(id);
      try {
        if (id.trim() === "" || duplicates.has(id))
          fail("reference", "Claim identifiers must be nonempty and unique.");
        if (!Number.isFinite(claim.value))
          fail("value", "A claim value must be finite.");
        if (claim.unit.trim() === "")
          fail("unit", "A claim requires an explicit unit.");
        let number: ResolvedNumber;
        if (claim.kind === "observed") {
          const field = sourceField(claim.source, true, item.warnings)!;
          if (field.value === null)
            fail("value", "The selected observation is missing.");
          if (field.value !== claim.value)
            fail(
              "value",
              "The claim does not equal the selected normalized value.",
            );
          if (field.unit !== claim.unit)
            fail("unit", `The selected field uses ${field.unit}.`);
          number = {
            value: claim.value,
            unit: claim.unit,
            estimated: false,
            source: claim.source,
          };
        } else if (claim.kind === "estimated") {
          if (claim.calculationId !== undefined) {
            const calculation = readValuationCalculation(
              this.runs,
              operation.runId,
              claim.calculationId,
            );
            if (
              calculation.result.perShareValues.length !== 1 ||
              calculation.result.perShareValues[0] !== claim.value ||
              claim.unit !== `${calculation.currency}/share`
            )
              fail(
                "calculation",
                "The numeric claim must equal its immutable valuation calculation.",
              );
          }
          if (
            claim.method.trim() === "" ||
            claim.assumptions.length === 0 ||
            claim.assumptions.some((text) => text.trim() === "")
          )
            fail(
              "estimate",
              "An estimate requires a method and nonempty assumptions.",
            );
          for (const ref of claim.evidence)
            sourceField(ref, false, item.warnings);
          item.warnings.push({
            code: "estimate",
            detail:
              "Estimate method and assumptions are present; any explicit source references were checked.",
          });
          number = { value: claim.value, unit: claim.unit, estimated: true };
        } else {
          if (claim.inputs.length !== 2)
            fail(
              "calculation",
              "A simple return requires start and end price inputs.",
            );
          const first = inputNumber(claim.inputs[0]!);
          const second = inputNumber(claim.inputs[1]!);
          const priceUnit = `${context.scope.security.currency}/share`;
          if (
            first.unit !== priceUnit ||
            second.unit !== priceUnit ||
            claim.unit !== "ratio"
          )
            fail(
              "unit",
              "Return inputs require the security currency per share and output ratio.",
            );
          if (first.value <= 0 || second.value < 0)
            fail(
              "calculation",
              "Start price must be positive and end price nonnegative.",
            );
          verifyPriceBasis(
            first,
            second,
            (ref) => getEvidence(ref, false).envelope,
          );
          const quotient = second.value / first.value;
          const expected = quotient - 1;
          const tolerance =
            SIMPLE_RETURN_ROUNDING_OPERATIONS *
            Number.EPSILON *
            Math.max(1, Math.abs(quotient));
          if (
            !Number.isFinite(expected) ||
            Math.abs(claim.value - expected) > tolerance
          )
            fail(
              "calculation",
              "The value does not match end / start - 1 within binary arithmetic rounding.",
            );
          const estimated = first.estimated || second.estimated;
          if (estimated)
            item.warnings.push({
              code: "estimate",
              detail: "This calculation contains an estimated input.",
            });
          number = { value: claim.value, unit: "ratio", estimated };
        }
        item.passed = true;
        resolved.set(id, number);
      } catch (cause) {
        if (cause instanceof ClaimError)
          item.issues.push({ code: cause.code, detail: cause.message });
        else if (cause instanceof SelectorError)
          item.issues.push({ code: "selector", detail: cause.message });
        else if (cause instanceof EvidenceTimeError)
          item.issues.push({ code: "time", detail: cause.message });
        else if (cause instanceof PriceBasisError)
          item.issues.push({ code: "calculation", detail: cause.message });
        else throw cause;
      } finally {
        active.delete(id);
      }
      checks.set(id, item);
      return resolved.get(id);
    };
    for (const claim of content.claims) check(claim.id);
    const results = content.claims.map((claim) => ({
      ...checks.get(claim.id)!,
      claim,
    }));
    return {
      checkerVersion: NUMBER_CHECK_VERSION,
      target:
        captured.kind === "pending"
          ? { kind: "pending", contentId: captured.contentId }
          : { kind: "artifact", ref: captured.ref },
      scope: context.scope,
      passed: results.every((claim) => claim.passed),
      claims: results,
    };
  }
}

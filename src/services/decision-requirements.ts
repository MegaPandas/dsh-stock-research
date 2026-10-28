import type { DataEnvelope, ISOTime, SourceRef } from "../contracts/data.js";
import type { EvidenceData, EvidenceEnvelope } from "../contracts/query.js";
import type { TaskDefinition, DataRequirement } from "../contracts/workflow.js";
import type { ResearchArtifactVersion } from "./artifact-inputs.js";
import { ArtifactInputs } from "./artifact-inputs.js";
import { ResearchError } from "../contracts/errors.js";
import { numberField } from "./number-fields.js";
import { EvidenceTimeError } from "./evidence-checks.js";
import { isStageReport } from "./analysis-report.js";

interface Observation {
  ref: SourceRef;
  asOf: string;
  retrievedAt: string;
  value: unknown;
}
function selected(
  envelope: EvidenceEnvelope,
  field: string,
): { selector: string; asOf: string; value: unknown } | null {
  const data = envelope.data;
  if (
    "table" in data &&
    data.table === "market.daily" &&
    field in data.columns
  ) {
    const index = data.rows.length - 1;
    if (index < 0) return null;
    const selector = `/data/rows/${index}/values/${field}`;
    const point = numberField(envelope, selector);
    return { selector, asOf: point.times[0]!.asOf, value: point.value };
  }
  if (
    envelope.dataset === "market" &&
    "bars" in data &&
    ["open", "high", "low", "close", "volume"].includes(field)
  ) {
    const index = data.bars.length - 1;
    if (index < 0) return null;
    const selector = `/data/bars/${index}/${field}`;
    const point = numberField(envelope, selector);
    return { selector, asOf: point.times[0]!.asOf, value: point.value };
  }
  if (envelope.dataset === "fundamentals" && "observations" in data) {
    const index = data.observations.length - 1;
    if (index < 0) return null;
    const selector =
      "concept" in data && data.field === field
        ? `/data/observations/${index}/value`
        : "fields" in data && data.fields.some((name) => name === field)
          ? `/data/observations/${index}/values/${field}`
          : null;
    if (selector === null) return null;
    const point = numberField(envelope, selector);
    return { selector, asOf: point.times[0]!.asOf, value: point.value };
  }
  if (
    envelope.dataset === "macro" &&
    "seriesId" in data &&
    data.seriesId === field
  ) {
    const index = data.observations.length - 1;
    if (index < 0) return null;
    const selector = `/data/observations/${index}/value`;
    const point = numberField(envelope, selector);
    return { selector, asOf: point.times[0]!.asOf, value: point.value };
  }
  if (
    envelope.dataset === "returns" &&
    "market" in data &&
    ["start.price", "end.price", "value"].includes(field)
  ) {
    const selector =
      field === "value" ? "/data/value" : `/data/${field.replace(".", "/")}`;
    if (
      (field === "start.price" && data.start === null) ||
      (field === "end.price" && data.end === null)
    )
      return null;
    const point = numberField(envelope, selector);
    return {
      selector,
      asOf:
        point.times
          .map((time) => time.asOf)
          .sort()
          .at(-1) ?? envelope.asOf,
      value: point.value,
    };
  }
  if (envelope.dataset === "research" && "items" in data && field === "items")
    return {
      selector: "/data/items",
      asOf: envelope.asOf,
      value: data.items.length === 0 ? null : data.items,
    };
  return null;
}
function insufficient(
  task: string,
  requirement: DataRequirement,
  field: string,
  detail: string,
): never {
  throw new ResearchError(
    "DATA_INSUFFICIENT",
    `Task ${task} requires ${requirement.dataset}.${field}: ${detail}`,
  );
}

/** Coverage uses adopted packets; the latest observation wins before missing/gap checks. */
export function checkDecisionRequirements(
  tasks: readonly TaskDefinition[],
  versions: readonly ResearchArtifactVersion[],
  inputs: ArtifactInputs,
  cutoff: ISOTime,
): void {
  for (const task of tasks) {
    const requirements = task.dataRequirements.filter(
      (requirement) => requirement.requiredForDecision,
    );
    if (requirements.length === 0) continue;
    const adopted = inputs.closure(
      versions
        .filter((version) => version.taskId === task.id)
        .map((version) => version.ref),
    );
    const sources = [
      ...new Map(
        adopted
          .flatMap((version) => inputs.artifactSources(version.ref))
          .map((ref) => [JSON.stringify([ref.runId, ref.evidenceId]), ref]),
      ).values(),
    ];
    const provided = adopted.some((version) => isStageReport(version.content));
    for (const requirement of requirements) {
      if (requirement.fields.length === 0)
        throw new ResearchError(
          "DATA_INSUFFICIENT",
          `Task ${task.id} declares required data without fields.`,
        );
      for (const field of requirement.fields) {
        const observations: Observation[] = [];
        for (const ref of sources) {
          const envelope: DataEnvelope<EvidenceData> =
            inputs.source(ref).envelope;
          if (envelope.dataset !== requirement.dataset) continue;
          const point = selected(envelope, field);
          if (point !== null)
            observations.push({
              ref: { ...ref, selector: point.selector },
              asOf: point.asOf,
              retrievedAt: envelope.retrievedAt,
              value: point.value,
            });
        }
        if (observations.length === 0)
          insufficient(task.id, requirement, field, "no adopted observation");
        const rank = (point: Observation) =>
          `${point.asOf}/${point.retrievedAt}`;
        const latest = observations.reduce((a, b) =>
          rank(a) >= rank(b) ? a : b,
        );
        for (const point of observations.filter(
          (point) => rank(point) === rank(latest),
        )) {
          if (point.value === null)
            insufficient(
              task.id,
              requirement,
              field,
              "the latest adopted observation is missing",
            );
          if (provided) {
            try {
              inputs.checkSourceTime(
                point.ref,
                requirement.dataset !== "research",
                cutoff,
              );
            } catch (cause) {
              if (!(cause instanceof EvidenceTimeError)) throw cause;
              insufficient(task.id, requirement, field, cause.message);
            }
          }
          const gaps = inputs.blockingGaps(
            point.ref,
            requirement.dataset !== "research",
            cutoff,
          );
          if (gaps.length > 0)
            insufficient(
              task.id,
              requirement,
              field,
              `${gaps[0]!.field}: ${gaps[0]!.detail}`,
            );
        }
        for (const version of versions.filter(
          (version) => version.taskId === task.id,
        )) {
          if (
            version.content.kind !== "analysis" &&
            version.content.kind !== "digest"
          )
            continue;
          const declared =
            version.content.kind === "analysis"
              ? "schemaVersion" in version.content.payload
                ? []
                : version.content.payload.gaps
              : version.content.payload.gaps.map((entry) => entry.gap);
          const gap = declared.find(
            (gap) => gap.field === field || gap.field === latest.ref.selector,
          );
          if (gap !== undefined)
            insufficient(task.id, requirement, field, gap.detail);
        }
      }
    }
  }
}

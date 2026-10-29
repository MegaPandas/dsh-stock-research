import type {
  DecisionProposal,
  DecisionResult,
  ResearchArtifactInput,
  SupportedStatement,
} from "../contracts/artifact-payloads.js";
import type { NumberInput } from "../contracts/artifacts.js";
import type { ArtifactRef, SourceRef } from "../contracts/data.js";

export function artifactCalculationIds(
  content: ResearchArtifactInput,
): string[] {
  const ids: string[] = [];
  for (const claim of content.claims)
    if (claim.kind === "estimated" && claim.calculationId !== undefined)
      ids.push(claim.calculationId);
  if ("report" in content.payload && content.payload.report !== undefined) {
    const report = content.payload.report;
    if ("valuation" in report.content && report.content.valuation != null)
      for (const method of report.content.valuation.methods)
        ids.push(...(method.calculationIds ?? []));
    if (
      "targetPrice" in report.content &&
      report.content.targetPrice?.calculationId !== undefined
    )
      ids.push(report.content.targetPrice.calculationId);
  }
  return ids;
}

export function artifactReferences(content: ResearchArtifactInput): {
  artifacts: ArtifactRef[];
  sources: SourceRef[];
  origins: SourceRef[];
  numbers: NumberInput[];
  calculations: string[];
} {
  const refs = {
    artifacts: [] as ArtifactRef[],
    sources: [] as SourceRef[],
    origins: [] as SourceRef[],
    numbers: [] as NumberInput[],
    calculations: artifactCalculationIds(content),
  };
  function statement(
    item: Pick<SupportedStatement, "evidence" | "numbers">,
    draft?: ArtifactRef,
  ): void {
    for (const ref of item.evidence) {
      if ("artifactId" in ref) refs.artifacts.push(ref);
      else refs.sources.push(ref);
    }
    refs.numbers.push(
      ...item.numbers.map((input): NumberInput =>
        draft !== undefined && input.kind === "local"
          ? { kind: "artifact", artifact: draft, claimId: input.claimId }
          : input,
      ),
    );
  }
  function proposal(item: DecisionProposal, draft?: ArtifactRef): void {
    for (const thesis of item.thesis) statement(thesis, draft);
    statement(
      {
        evidence: [],
        numbers: [
          ...(item.basePrice === null ? [] : [item.basePrice]),
          ...(item.targetPrice === null ? [] : [item.targetPrice]),
        ],
      },
      draft,
    );
  }
  function decision(item: DecisionResult): void {
    refs.artifacts.push(
      item.draftRef,
      ...item.inputRefs,
      ...item.validation.checkedRefs,
    );
    proposal(item, item.draftRef);
  }
  function gaps(
    values: Extract<
      ResearchArtifactInput,
      { kind: "digest" | "report" }
    >["payload"]["gaps"],
  ): void {
    for (const entry of values) {
      if (entry.kind === "artifact") refs.artifacts.push(entry.artifact);
      else refs.origins.push(entry.source);
    }
  }
  switch (content.kind) {
    case "analysis":
      if (!("schemaVersion" in content.payload))
        content.payload.findings.forEach((item) => statement(item));
      break;
    case "debate":
      if ("schemaVersion" in content.payload) break;
      content.payload.arguments.forEach((item) => statement(item));
      content.payload.rebuttals.forEach((item) => {
        refs.artifacts.push(item.target);
        statement(item);
      });
      break;
    case "risk":
      content.payload.issues.forEach((item) => statement(item));
      break;
    case "plan":
      content.payload.thesis.forEach((item) => statement(item));
      break;
    case "digest":
      gaps(content.payload.gaps);
      refs.artifacts.push(...content.payload.upstreamRefs);
      refs.numbers.push(...content.payload.numbers);
      content.payload.facts.forEach((item) => statement(item));
      content.payload.risks.forEach((item) => statement(item));
      break;
    case "decision_draft":
      proposal(content.payload);
      break;
    case "decision":
      decision(content.payload);
      break;
    case "report":
      gaps(content.payload.gaps);
      refs.artifacts.push(
        ...content.payload.sections,
        ...content.payload.digests,
      );
      decision(content.payload.decision);
      break;
  }
  return refs;
}

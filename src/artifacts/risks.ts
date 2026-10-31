import { isDeepStrictEqual } from "node:util";
import type {
  ResearchArtifactVersion,
  RiskIssue,
} from "../contracts/artifact-payloads.js";
import type { NumberInput } from "../contracts/artifacts.js";
import type { ArtifactRef, EvidenceRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { artifactKey } from "../contracts/artifact-identity.js";
import { bindArtifactNumber } from "./references.js";

function uniqueEvidence(refs: readonly EvidenceRef[]): EvidenceRef[] {
  return [
    ...new Map(
      refs.map((ref) => [
        "artifactId" in ref
          ? artifactKey(ref)
          : JSON.stringify([ref.runId, ref.evidenceId, ref.selector]),
        ref,
      ]),
    ).values(),
  ];
}
type FixedNumber = Extract<NumberInput, { kind: "artifact" }>;
type InheritedRisk = Omit<RiskIssue, "numbers"> & { numbers: FixedNumber[] };
function uniqueNumbers(refs: readonly FixedNumber[]): FixedNumber[] {
  return [
    ...new Map(
      refs.map((ref) => [
        JSON.stringify([artifactKey(ref.artifact), ref.claimId]),
        ref,
      ]),
    ).values(),
  ];
}
export function inheritRisks(
  versions: readonly ResearchArtifactVersion[],
): RiskIssue[] {
  const risks = new Map<string, InheritedRisk>();
  for (const version of versions) {
    const values =
      version.content.kind === "risk"
        ? version.content.payload.issues
        : version.content.kind === "digest"
          ? version.content.payload.risks
          : [];
    for (const issue of values) {
      // Inherited evidence is consumed through its checked artifact, not as a fresh source citation.
      const artifacts = issue.evidence.filter(
        (ref): ref is ArtifactRef => "artifactId" in ref,
      );
      const inherited = uniqueEvidence([
        ...artifacts,
        ...(artifacts.length === issue.evidence.length && artifacts.length > 0
          ? []
          : [version.ref]),
      ]);
      const candidate: InheritedRisk = {
        ...issue,
        evidence: inherited,
        numbers: issue.numbers.map((input) =>
          bindArtifactNumber(input, version.ref),
        ),
      };
      const previous = risks.get(issue.issueId);
      if (previous === undefined) risks.set(issue.issueId, candidate);
      else {
        const {
          evidence: previousEvidence,
          numbers: previousNumbers,
          ...previousCore
        } = previous;
        const { evidence, numbers, ...core } = candidate;
        if (!isDeepStrictEqual(previousCore, core))
          throw new ResearchError(
            "DATA_INSUFFICIENT",
            `Conflicting inherited risk issue ${issue.issueId}.`,
          );
        risks.set(issue.issueId, {
          ...previous,
          evidence: uniqueEvidence([...previousEvidence, ...evidence]),
          numbers: uniqueNumbers([...previousNumbers, ...numbers]),
        });
      }
    }
  }
  return [...risks.values()];
}

import { isDeepStrictEqual } from "node:util";
import type { RiskIssue } from "../contracts/artifact-payloads.js";
import type { NumberInput } from "../contracts/artifacts.js";
import type { ArtifactRef, EvidenceRef } from "../contracts/data.js";
import type { DigestNumberCandidate } from "../contracts/digests.js";
import { ResearchError } from "../contracts/errors.js";
import {
  ArtifactInputs,
  type ResearchArtifactVersion,
} from "./artifact-inputs.js";
import { artifactReferences } from "./artifact-references.js";
import { artifactKey } from "./run-dependencies.js";

export function bindNumber(
  input: NumberInput,
  local: ArtifactRef,
): Extract<NumberInput, { kind: "artifact" }> {
  return input.kind === "artifact"
    ? input
    : { kind: "artifact", artifact: local, claimId: input.claimId };
}
export function digestNumbers(
  versions: readonly ResearchArtifactVersion[],
  inputs: ArtifactInputs,
): DigestNumberCandidate[] {
  const numbers = new Map<string, DigestNumberCandidate>();
  const adopt = (input: NumberInput, local: ArtifactRef) => {
    const ref = bindNumber(input, local);
    const key = JSON.stringify([artifactKey(ref.artifact), ref.claimId]);
    if (numbers.has(key)) return;
    const { claim } = inputs.number(ref, local);
    numbers.set(key, {
      candidateId: `n${numbers.size}`,
      input: ref,
      claim,
      estimated: inputs.estimated(ref, local),
    });
    if (claim.kind === "calculated")
      for (const dependency of claim.inputs) adopt(dependency, ref.artifact);
  };
  for (const version of versions) {
    for (const claim of version.content.claims)
      adopt({ kind: "local", claimId: claim.id }, version.ref);
    for (const input of artifactReferences(version.content).numbers)
      adopt(input, version.ref);
  }
  return [...numbers.values()];
}
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
export function digestRisks(
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
        numbers: issue.numbers.map((input) => bindNumber(input, version.ref)),
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

import type { ResearchArtifactVersion } from "../../contracts/artifact-payloads.js";
import type { NumberInput } from "../../contracts/artifacts.js";
import type { ArtifactRef } from "../../contracts/data.js";
import type { DigestNumberCandidate } from "../../contracts/digests.js";
import type { ArtifactInputs } from "../artifact-inputs.js";
import {
  artifactReferences,
  bindArtifactNumber,
} from "../../artifacts/references.js";
import { artifactKey } from "../../contracts/artifact-identity.js";

export function digestNumbers(
  versions: readonly ResearchArtifactVersion[],
  inputs: ArtifactInputs,
): DigestNumberCandidate[] {
  const numbers = new Map<string, DigestNumberCandidate>();
  const adopt = (input: NumberInput, local: ArtifactRef) => {
    const ref = bindArtifactNumber(input, local);
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

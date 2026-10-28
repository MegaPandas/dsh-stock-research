import type { DigestPayload } from "../contracts/artifact-payloads.js";
import type { NumericClaim } from "../contracts/artifacts.js";
import type { ResearchScope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import {
  ArtifactInputs,
  type ResearchArtifactVersion,
} from "./artifact-inputs.js";
import { PriceBasisError, verifyPriceBasis } from "./price-basis.js";
import {
  decisionPolicy,
  priceRating,
  PRICE_RATING_POLICY,
} from "../contracts/rating-policy.js";

function invalid(detail: string): never {
  throw new ResearchError("INVALID_ARTIFACT", detail);
}
export function selectDecisionInputs(
  versions: readonly ResearchArtifactVersion[],
): {
  draft: ResearchArtifactVersion & {
    content: Extract<
      ResearchArtifactVersion["content"],
      { kind: "decision_draft" }
    >;
  };
  digests: ResearchArtifactVersion[];
} {
  const drafts = versions.filter(
    (version) => version.content.kind === "decision_draft",
  );
  const digests = versions.filter(
    (version) => version.content.kind === "digest",
  );
  if (drafts.length !== 1 || digests.length === 0)
    invalid(
      "Finalization requires one fixed manager decision draft and its selected risk digest inputs.",
    );
  return {
    draft: drafts[0] as ResearchArtifactVersion & {
      content: Extract<
        ResearchArtifactVersion["content"],
        { kind: "decision_draft" }
      >;
    },
    digests,
  };
}
export interface DecisionBasics {
  computedReturn: number | null;
  warnings: string[];
}

/** Checks correctable decision content before publication; data gaps remain warnings. */
export function assessDecisionBasics(
  scope: ResearchScope,
  selected: ReturnType<typeof selectDecisionInputs>,
  inputs: ArtifactInputs,
): DecisionBasics {
  const { draft, digests } = selected;
  const proposal = draft.content.payload;
  if (proposal.horizonEndDate <= scope.date)
    invalid("The decision horizon must be after the research date.");
  const base =
    proposal.basePrice === null
      ? null
      : inputs.number(proposal.basePrice, draft.ref).claim;
  const target =
    proposal.targetPrice === null
      ? null
      : inputs.number(proposal.targetPrice, draft.ref).claim;
  const unit = `${scope.security.currency}/share`;
  if (base !== null && (base.value <= 0 || base.unit !== unit))
    invalid(`The base price must be positive and use ${unit}.`);
  if (target !== null && (target.value < 0 || target.unit !== unit))
    invalid(`The target price must be nonnegative and use ${unit}.`);
  const profile = (claim: NumericClaim) => ({
    estimated: claim.kind === "estimated",
    ...(claim.kind === "observed" ? { source: claim.source } : {}),
  });
  try {
    if (base !== null || target !== null)
      verifyPriceBasis(
        profile(base ?? target!),
        profile(target ?? base!),
        (ref) => inputs.source(ref).envelope,
      );
  } catch (cause) {
    if (!(cause instanceof PriceBasisError)) throw cause;
    throw new ResearchError("INVALID_ARTIFACT", cause.message, { cause });
  }
  const computedReturn =
    target === null || base === null ? null : target.value / base.value - 1;
  if (computedReturn !== null && !Number.isFinite(computedReturn))
    invalid("The expected return is outside the finite numeric range.");
  if (proposal.ratingPolicy === PRICE_RATING_POLICY) {
    if (proposal.horizonEndDate !== decisionPolicy(scope.date).horizonEndDate)
      invalid(
        "The price rating horizon must be six calendar months after the research date.",
      );
    if (
      proposal.rating !==
      priceRating(base?.value ?? null, target?.value ?? null)
    )
      invalid(
        "The price rating must match the fixed absolute-price intervals.",
      );
  }
  const requiredRisks = new Set(
    digests.flatMap((version) =>
      (version.content.payload as DigestPayload).risks.map(
        (risk) => risk.issueId,
      ),
    ),
  );
  const responses = new Map(
    proposal.riskResponses.map((response) => [response.issueId, response]),
  );
  const missing = [...requiredRisks].filter((id) => !responses.has(id));
  if (missing.length > 0)
    invalid(`Risk responses are missing: ${missing.join(", ")}.`);
  const unknown = [...responses.keys()].filter((id) => !requiredRisks.has(id));
  if (unknown.length > 0)
    invalid(`Risk responses refer to unknown issues: ${unknown.join(", ")}.`);
  const warnings: string[] = [];
  if (proposal.rating === null)
    warnings.push("The available information does not support a rating.");
  if (base === null)
    warnings.push(
      "The base price is unavailable; expected return cannot be computed.",
    );
  const numericFacts = [
    ...(proposal.basePrice === null ? [] : [proposal.basePrice]),
    ...(proposal.targetPrice === null ? [] : [proposal.targetPrice]),
    ...proposal.thesis.flatMap((thesis) => thesis.numbers),
  ];
  for (const input of numericFacts) {
    const gaps = inputs.numberGaps(input, draft.ref, scope.cutoff);
    if (gaps.length > 0)
      warnings.push(
        `A decision numeric premise has a gap: ${gaps[0]!.gap.field}: ${gaps[0]!.gap.detail}`,
      );
  }
  for (const ref of proposal.thesis.flatMap((thesis) => thesis.evidence)) {
    const gaps =
      "artifactId" in ref
        ? inputs
            .blockingReportedGaps(inputs.closure([ref]), scope.cutoff)
            .map((entry) => entry.gap)
        : inputs.blockingGaps(ref, false, scope.cutoff);
    if (gaps.length > 0)
      warnings.push(
        `A decision evidence premise has a gap: ${gaps[0]!.field}: ${gaps[0]!.detail}`,
      );
  }
  warnings.push(
    ...[...requiredRisks].flatMap((id) => {
      const response = responses.get(id)!;
      return response.disposition === "unresolved"
        ? [`Risk ${id} remains unresolved: ${response.reason}`]
        : [];
    }),
  );
  return { computedReturn, warnings };
}

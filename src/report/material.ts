import type { ArtifactInput } from "../contracts/artifacts.js";
import type { AgentReport } from "../contracts/agent-reports.js";
import type {
  DecisionProposal,
  RiskIssue,
} from "../contracts/artifact-payloads.js";
import { renderArtifactBody } from "./render.js";

/** Present business content; storage identity and provenance stay outside context. */
export function reportMaterial(artifact: ArtifactInput) {
  const payload = artifact.payload as {
    report?: AgentReport;
    issues?: RiskIssue[];
    publicSearchAsOf?: string;
    rating?: DecisionProposal["rating"];
    horizonEndDate?: string;
    ratingPolicy?: DecisionProposal["ratingPolicy"];
  };
  if (payload.report === undefined)
    return { title: artifact.title, body: renderArtifactBody(artifact) };
  const report = payload.report;
  return {
    title: artifact.title,
    ...report,
    ...(payload.publicSearchAsOf === undefined
      ? {}
      : { publicSearchAsOf: payload.publicSearchAsOf }),
    ...((artifact.kind === "decision_draft" || artifact.kind === "decision") &&
    payload.ratingPolicy !== undefined
      ? {
          decision: {
            rating: payload.rating,
            horizonEndDate: payload.horizonEndDate,
            ratingPolicy: payload.ratingPolicy,
          },
        }
      : {}),
    ...(artifact.kind === "risk"
      ? {
          content: {
            issues: payload.issues!.map(
              ({
                issueId,
                description,
                impact,
                trigger,
                constraint,
                recommendation,
              }) => ({
                issueId,
                description,
                impact,
                trigger,
                constraint,
                recommendation,
              }),
            ),
          },
        }
      : {}),
  };
}

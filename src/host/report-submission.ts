import { ResearchError } from "../contracts/errors.js";
import type { ArtifactCommitResult } from "../contracts/runs.js";
import type { ArtifactService } from "../services/artifacts.js";
import {
  taskOperation,
  type SessionBindings,
  type ResearchCaller,
} from "./bindings.js";

export type ReportCaller = ResearchCaller;

/** ArtifactService owns validation of both assembled reports and external drafts. */
export type SubmitReport = (
  contents: unknown,
  requestId: string,
  caller: ReportCaller,
) => ArtifactCommitResult;

export function createReportSubmission(
  artifacts: ArtifactService,
  bindings: SessionBindings,
): SubmitReport {
  return (contents, requestId, caller) => {
    caller.signal.throwIfAborted();
    const operation = taskOperation(bindings.require(caller.agent));
    if (Array.isArray(contents))
      for (const content of contents) {
        const kind = (content as { kind?: unknown } | null)?.kind;
        if (kind === "digest" || kind === "decision" || kind === "report")
          throw new ResearchError(
            "ACCESS_DENIED",
            "Service artifacts cannot be submitted by a research role.",
          );
      }
    return artifacts.submitArtifact(operation, contents, requestId);
  };
}

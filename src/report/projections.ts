import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { ProjectionWrite } from "../contracts/storage.js";
import { renderArtifact } from "./render.js";

const FIXED_VIEWS = {
  plan: "plan.md",
  digest: "digest.md",
  decision_draft: "decision.draft.md",
  decision: "decision.json",
  report: "report.md",
} as const;

export function renderRunProjections(
  artifacts: readonly ArtifactVersion[],
): ProjectionWrite[] {
  const fixed = new Map<string, ProjectionWrite>();
  const named = new Map<string, ProjectionWrite>();
  for (const artifact of artifacts) {
    const kind = artifact.content.kind;
    const content =
      kind === "decision"
        ? `${JSON.stringify(artifact.content.payload, null, 2)}\n`
        : renderArtifact(artifact.content);
    if (kind === "analysis" || kind === "debate" || kind === "risk") {
      const directory = kind === "analysis" ? "reports" : "debate";
      const key = `${directory}/${artifact.taskId}`;
      const existing = named.get(key);
      named.set(key, {
        target: { directory, name: artifact.taskId },
        content:
          existing === undefined
            ? content
            : `${existing.content}\n---\n\n${content}`,
      });
    } else {
      const filename = FIXED_VIEWS[kind];
      fixed.set(filename, { target: { filename }, content });
    }
  }
  return [...named.values(), ...fixed.values()];
}

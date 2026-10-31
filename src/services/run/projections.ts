import type { ArtifactVersion } from "../../contracts/artifacts.js";
import type { SyncRunProjections } from "../../contracts/runs.js";
import { renderRunProjections } from "../../report/projections.js";
import type { RunStore } from "../../runs/store.js";

export function createRunProjector(
  store: Pick<RunStore<object>, "readContents" | "syncProjections">,
): SyncRunProjections {
  return ({ runId, revision, artifactRefs }) => {
    const artifacts =
      artifactRefs.length === 0
        ? []
        : store.readContents<ArtifactVersion>(
            runId,
            artifactRefs.map((ref) => ({
              kind: "artifact",
              id: ref.artifactId,
              revision: ref.revision,
            })),
          );
    store.syncProjections(runId, revision, renderRunProjections(artifacts));
  };
}

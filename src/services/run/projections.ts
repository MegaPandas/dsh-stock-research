import type { ArtifactVersion } from "../../contracts/artifacts.js";
import type { SyncRunProjections } from "../../contracts/runs.js";
import { renderRunProjections } from "../../report/projections.js";
import type { RunStore } from "../../runs/store.js";

export function createRunProjector(
  store: Pick<RunStore<object>, "syncProjections">,
): SyncRunProjections {
  return ({ runId, revision, artifactRefs }, contents) => {
    const artifacts =
      artifactRefs.length === 0
        ? []
        : contents.readContents<ArtifactVersion>(
            artifactRefs.map((ref) => ({
              kind: "artifact",
              id: ref.artifactId,
              revision: ref.revision,
            })),
          );
    store.syncProjections(runId, revision, renderRunProjections(artifacts));
  };
}

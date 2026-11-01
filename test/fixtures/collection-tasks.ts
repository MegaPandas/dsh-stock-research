import type { CollectionSnapshot } from "../../src/contracts/collection.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import type { ArtifactPayloads } from "../../src/contracts/artifact-payloads.js";
import type { RunAccess } from "../../src/contracts/run-access.js";

/** Publish fixed service outputs before manually claiming dependent business tasks. */
export function completeCollectionTasks(
  runs: Pick<
    RunAccess,
    | "readDefinition"
    | "view"
    | "claimService"
    | "commitArtifact"
    | "replaySnapshot"
    | "readArtifact"
  >,
  runId: string,
  identity: string,
): Record<string, ArtifactRef> {
  const definition = runs.readDefinition(runId);
  const replay = runs.replaySnapshot(runId);
  const refs: Record<string, ArtifactRef> = {};
  for (const task of definition.tasks) {
    if (
      task.executor.kind !== "service" ||
      task.executor.service !== "collection"
    )
      continue;
    const current = runs
      .view({ runId })
      .tasks.find(({ taskId }) => taskId === task.id)!;
    if (current.status === "succeeded") {
      refs[task.id] = current.outputRefs[0]!;
      continue;
    }
    const node = task.executor.node;
    const capturedFrom =
      replay?.tasks.find(({ taskId }) => taskId === task.id)?.outputRefs[0] ??
      null;
    let payload: ArtifactPayloads["collection"];
    if (replay !== null) {
      if (capturedFrom === null)
        throw new Error(
          `Fixture replay has no captured output for ${task.id}.`,
        );
      payload = {
        ...structuredClone(
          runs.readArtifact(capturedFrom).content
            .payload as ArtifactPayloads["collection"],
        ),
        capturedFrom,
      };
    } else {
      const snapshot: CollectionSnapshot = {
        schemaVersion: 1,
        node,
        scope: definition.scope,
        packets: [],
        failures: [],
      };
      payload = { snapshot, capturedAt: definition.scope.cutoff, capturedFrom };
    }
    const claim = runs.claimService(
      { runId, identity },
      task.id,
      "collection",
      `fixture:${task.id}`,
    );
    refs[task.id] = runs.commitArtifact(
      { ...claim, identity, sessionId: null },
      [
        {
          kind: "collection",
          title: `Fixed ${node} fixture`,
          body: "Fixed collection fixture.",
          inputRefs: claim.inputRefs,
          claims: [],
          payload,
        },
      ],
      `fixture:${task.id}`,
    ).refs[0]!;
  }
  return refs;
}

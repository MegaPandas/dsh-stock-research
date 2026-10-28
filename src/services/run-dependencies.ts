import type { ArtifactInput, ArtifactVersion } from "../contracts/artifacts.js";
import type { ArtifactRef } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import type {
  ClaimResult,
  RedoTaskResult,
  ResearchRun,
} from "../contracts/runs.js";

export function artifactKey(ref: ArtifactRef): string {
  return JSON.stringify([ref.runId, ref.artifactId, ref.revision]);
}

export function affectedTaskIds(
  run: ResearchRun,
  taskId: string,
  readArtifact: (ref: ArtifactRef) => ArtifactVersion,
): Set<string> {
  const dependents = new Map<string, Set<string>>();
  const owners = new Map<string, string>();
  function edge(upstream: string, downstream: string) {
    let next = dependents.get(upstream);
    if (next === undefined) {
      next = new Set();
      dependents.set(upstream, next);
    }
    next.add(downstream);
  }
  for (const task of run.tasks)
    for (const ref of task.outputRefs)
      owners.set(artifactKey(ref), task.taskId);
  for (const task of run.definition.tasks)
    for (const dependency of task.dependsOn) edge(dependency, task.id);
  for (const task of run.tasks) {
    if (task.status === "pending" || task.status === "cancelled") continue;
    const inputs = [
      ...task.attempts.at(-1)!.inputRefs,
      ...task.outputRefs.flatMap((ref) => readArtifact(ref).content.inputRefs),
    ];
    for (const ref of inputs) {
      const owner = owners.get(artifactKey(ref));
      if (owner !== undefined) edge(owner, task.taskId);
    }
  }
  const affected = new Set([taskId]);
  const queue = [taskId];
  for (let index = 0; index < queue.length; index++) {
    for (const downstream of dependents.get(queue[index]!) ?? []) {
      if (affected.has(downstream)) continue;
      affected.add(downstream);
      queue.push(downstream);
    }
  }
  return affected;
}

export function assertFreshInputs(
  run: ResearchRun,
  taskId: string,
  attempt: number,
  contents: readonly ArtifactInput[],
): void {
  const inputs = new Set(
    contents.flatMap((content) => content.inputRefs.map(artifactKey)),
  );
  if (inputs.size === 0) return;
  // An extra dependency becomes known at submission; compare it with redos since claim.
  for (let index = run.receipts.length - 1; index >= 0; index--) {
    const receipt = run.receipts[index]!;
    if (receipt.action === "claim") {
      const claimed = receipt.result as ClaimResult;
      if (claimed.taskId === taskId && claimed.attempt === attempt) return;
    }
    if (receipt.action !== "redo") continue;
    const redone = receipt.result as RedoTaskResult;
    if (redone.invalidatedRefs.some((ref) => inputs.has(artifactKey(ref))))
      throw new ResearchError(
        "STALE_ATTEMPT",
        `Task ${taskId} adopted an input invalidated after its attempt was claimed.`,
      );
  }
}

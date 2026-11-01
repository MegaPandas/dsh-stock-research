import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { ArtifactRef } from "../contracts/data.js";
import type { RunReader } from "../contracts/run-access.js";
import type { RunView } from "../contracts/runs.js";
import {
  authorizeRun,
  type ResearchCaller,
  type SessionBindings,
} from "./bindings.js";

export interface RunReadOperations {
  readRun(runId: string, caller: ResearchCaller): RunView;
  readArtifact(ref: ArtifactRef, caller: ResearchCaller): ArtifactVersion;
}

export function createRunReadOperations(
  runs: Pick<RunReader, "view" | "readArtifact">,
  bindings: SessionBindings,
): RunReadOperations {
  return {
    readRun(runId, caller) {
      caller.signal.throwIfAborted();
      const bound = bindings.require(caller.agent);
      authorizeRun(bound.binding, runId);
      return runs.view({ runId });
    },
    readArtifact(ref, caller) {
      caller.signal.throwIfAborted();
      const bound = bindings.require(caller.agent);
      authorizeRun(bound.binding, ref.runId);
      return runs.readArtifact(ref);
    },
  };
}

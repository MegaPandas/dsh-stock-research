import type { ArtifactVersion } from "../contracts/artifacts.js";
import type { RunReader } from "../contracts/run-access.js";
import type { RunView } from "../contracts/runs.js";
import { artifactRef, object, text } from "../tools/parameters.js";
import {
  authorizeRun,
  type ResearchCaller,
  type SessionBindings,
} from "./bindings.js";

export interface RunReadOperations {
  readRun(value: unknown, caller: ResearchCaller): RunView;
  readArtifact(value: unknown, caller: ResearchCaller): ArtifactVersion;
}

export function createRunReadOperations(
  runs: Pick<RunReader, "view" | "readArtifact">,
  bindings: SessionBindings,
): RunReadOperations {
  return {
    readRun(value, caller) {
      caller.signal.throwIfAborted();
      const bound = bindings.require(caller.agent);
      const item = object(value, ["runId"]);
      const runId = text(item.runId, "runId");
      authorizeRun(bound.binding, runId);
      return runs.view({ runId });
    },
    readArtifact(value, caller) {
      caller.signal.throwIfAborted();
      const bound = bindings.require(caller.agent);
      const item = object(value, ["ref"]);
      const ref = artifactRef(item.ref);
      authorizeRun(bound.binding, ref.runId);
      return runs.readArtifact(ref);
    },
  };
}

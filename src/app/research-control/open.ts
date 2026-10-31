import type {
  CollectionProgress,
  CollectionSnapshot,
} from "../../contracts/collection.js";
import type { ResearchScope } from "../../contracts/data.js";
import type { QueryPolicy } from "../../contracts/query.js";
import type { OpenRunInput, RunInput, RunView } from "../../contracts/runs.js";
import type { SourceDescription } from "../../contracts/sources.js";
import type { RunDefinition } from "../../contracts/workflow.js";
import { researchCutoff } from "../ask-input.js";
import {
  attachCollection,
  requireCollectionData,
} from "../collection-snapshot.js";
import { createQuickInput, QUICK_RESEARCH_STAGES } from "../plan/quick.js";
import { createDeepInput, DEEP_RESEARCH_STAGES } from "../plan/deep.js";
import { attachResearchStages } from "../research-stages.js";

export interface OpenResearchRequest {
  scope: ResearchScope;
  mode: RunDefinition["mode"];
  policy: QueryPolicy;
  sources: readonly SourceDescription[];
  publicSearchLimit: number;
  modelInput: RunInput;
  requestId: string;
}
export interface OpenResearchPorts {
  collection: {
    collect(
      scope: ResearchScope,
      signal: AbortSignal,
      onProgress: (progress: CollectionProgress) => void,
    ): Promise<CollectionSnapshot>;
    finalizeScope(snapshot: CollectionSnapshot, scope: ResearchScope): void;
  };
  openRun(input: OpenRunInput, requestId: string): RunView;
  now(): Date;
}

export async function openResearch(
  ports: OpenResearchPorts,
  request: OpenResearchRequest,
  signal: AbortSignal,
  onProgress: (progress: CollectionProgress) => void,
): Promise<RunView> {
  const collection = await ports.collection.collect(
    request.scope,
    signal,
    onProgress,
  );
  requireCollectionData(collection);
  signal.throwIfAborted();
  const scope = {
    ...request.scope,
    cutoff: researchCutoff(request.scope, ports.now()),
  };
  ports.collection.finalizeScope(collection, scope);
  const input = attachResearchStages(
    attachCollection(
      (request.mode === "quick" ? createQuickInput : createDeepInput)(
        scope,
        request.policy,
        request.sources,
        [],
        request.publicSearchLimit,
      ),
      collection,
    ),
    request.mode === "quick" ? QUICK_RESEARCH_STAGES : DEEP_RESEARCH_STAGES,
  );
  input.inputs.push(request.modelInput);
  return ports.openRun(input, request.requestId);
}

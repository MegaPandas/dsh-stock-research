import type {
  CollectionProgress,
  CollectionSnapshot,
  CollectionNode,
} from "../../contracts/collection.js";
import type { ResearchScope } from "../../contracts/data.js";
import type { QueryPolicy } from "../../contracts/query.js";
import type { OpenRunInput, RunInput, RunView } from "../../contracts/runs.js";
import type { SourceDescription } from "../../contracts/sources.js";
import type { RunDefinition } from "../../contracts/workflow.js";
import { COLLECTION_SOURCE_VERSIONS } from "../../data/versions.js";
import { researchCutoff } from "../research-scope.js";
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
    collectNode(
      scope: ResearchScope,
      node: CollectionNode,
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
  const collection = await ports.collection.collectNode(
    request.scope,
    "required",
    signal,
    onProgress,
  );
  requireCollectionData(collection);
  signal.throwIfAborted();
  const capturedAt = ports.now();
  collection.capturedAt = capturedAt.toISOString();
  const scope = {
    ...request.scope,
    cutoff: researchCutoff(request.scope, capturedAt),
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
  for (const [key, version] of Object.entries(COLLECTION_SOURCE_VERSIONS)) {
    input.versions.adapters[key] = version.adapterVersion;
    input.versions.normalization[key] = version.normalizationVersion;
  }
  input.inputs.push(request.modelInput);
  return ports.openRun(input, request.requestId);
}

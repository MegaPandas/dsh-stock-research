import { serializeJson } from "../cache/json.js";
import type { SourceRef } from "../contracts/data.js";
import type {
  QueryData,
  QueryRequest,
  QuerySnapshot,
  TaskQueryResponse,
} from "../contracts/query.js";
import type { ReplayEvidenceSource } from "../contracts/replay.js";
import type { TaskOperation } from "../contracts/runs.js";
import type { EvidenceQuery } from "../contracts/task-data.js";
import { extractCandidates } from "./candidates.js";
import type { QueryService } from "./query.js";
import { adoptQuerySnapshot } from "./query-snapshot.js";
import type { RunService } from "./runs.js";
import { SharedQueries } from "./shared-queries.js";

function evidenceQuery(request: QueryRequest): EvidenceQuery {
  return {
    dataset: request.dataset,
    provider: request.provider,
    parameters: { ...request.parameters },
  };
}

/** Own task evidence calls; the injected query service has a separate lifetime. */
export class TaskQueryService {
  readonly #flights = new SharedQueries<SourceRef>();

  constructor(
    private readonly queries: Pick<QueryService, "query">,
    private readonly runs: RunService,
  ) {}

  async queryForTask<Q extends QueryRequest>(
    operation: TaskOperation,
    request: Q,
    callId: string,
    signal?: AbortSignal,
    snapshot?: QuerySnapshot,
  ): Promise<TaskQueryResponse<Q>> {
    const active =
      signal === undefined
        ? this.#flights.signal
        : AbortSignal.any([this.#flights.signal, signal]);
    active.throwIfAborted();
    const bound = { ...operation };
    const identity = serializeJson(request);
    const captured = JSON.parse(identity) as Q;
    const query = evidenceQuery(captured);
    const prepared = this.runs.evidenceForCall(bound, query, callId);
    if (prepared.sourceRef !== null)
      return {
        sourceRef: prepared.sourceRef,
        envelope: this.runs.readEvidence<QueryData<Q>>(prepared.sourceRef)
          .envelope,
      };
    if (prepared.lineage !== null)
      return this.replayForTask(bound, captured, callId, null, active);
    const fixed =
      snapshot === undefined ? undefined : structuredClone(snapshot);
    const key = JSON.stringify([
      bound.identity,
      bound.runId,
      bound.taskId,
      bound.attempt,
      callId,
    ]);
    const sourceRef = await this.#flights.run(
      key,
      identity,
      async (producerSignal) => {
        const envelope =
          fixed === undefined
            ? await this.queries.query(prepared.scope, captured, producerSignal)
            : adoptQuerySnapshot(prepared.scope, captured, fixed);
        producerSignal.throwIfAborted();
        return this.runs.recordEvidence(
          bound,
          query,
          { envelope, candidates: extractCandidates(envelope) },
          callId,
        );
      },
      active,
    );
    active.throwIfAborted();
    return {
      sourceRef,
      envelope: this.runs.readEvidence<QueryData<Q>>(sourceRef).envelope,
    };
  }

  async replayForTask<Q extends QueryRequest>(
    operation: TaskOperation,
    request: Q,
    callId: string,
    source: ReplayEvidenceSource | null = null,
    signal?: AbortSignal,
  ): Promise<TaskQueryResponse<Q>> {
    const active =
      signal === undefined
        ? this.#flights.signal
        : AbortSignal.any([this.#flights.signal, signal]);
    active.throwIfAborted();
    const captured = JSON.parse(serializeJson(request)) as Q;
    const selected =
      source === null
        ? null
        : { runId: source.runId, evidenceId: source.evidenceId };
    const sourceRef = this.runs.replayEvidence(
      { ...operation },
      evidenceQuery(captured),
      callId,
      selected,
    );
    active.throwIfAborted();
    return {
      sourceRef,
      envelope: this.runs.readEvidence<QueryData<Q>>(sourceRef).envelope,
    };
  }

  close(): Promise<void> {
    return this.#flights.close();
  }
}

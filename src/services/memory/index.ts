import { serializeJson } from "../../json/serialize.js";
import type { ISOTime, ResearchScope } from "../../contracts/data.js";
import { ResearchError } from "../../contracts/errors.js";
import type {
  MemoryAccess,
  MemoryEntry,
  MemoryState,
  QueryMemoryReturns,
  RecallQuery,
  RememberInput,
  RememberOperation,
} from "../../contracts/memory-service.js";
import type { MemoryIndex, MemoryRef } from "../../contracts/memory.js";
import type { TaskOperation } from "../../contracts/runs.js";
import type {
  MemoryInputQuery,
  MemoryInputRegistration,
  MemoryInputSnapshot,
  MemorySnapshotEntry,
} from "../../contracts/task-data.js";
import type { MemoryStore } from "../../memory/store.js";
import { readPointer } from "../../json/pointer.js";
import { assertMemoryEntry, assertMemoryState } from "./state.js";
import type { RunCommands, RunReader } from "../../contracts/run-access.js";
import { SharedQueries } from "../shared-queries.js";

function inputQuery(query: RecallQuery): MemoryInputQuery {
  return {
    scope: { runId: query.runId },
    parameters: { text: query.text, limit: query.limit },
  };
}
export class MemoryService implements MemoryAccess {
  readonly #writes = new SharedQueries<MemoryRef>();
  constructor(
    private readonly store: Pick<
      MemoryStore<MemoryState>,
      "readIndex" | "readEntry" | "inspect" | "commit"
    >,
    private readonly runs: Pick<
      RunReader,
      "view" | "readArtifact" | "readEvidence" | "readInput"
    > &
      Pick<
        RunCommands,
        "memoryInputForCall" | "recordMemoryInput" | "replayMemoryInput"
      >,
    private readonly queryReturns: QueryMemoryReturns,
    private readonly now: () => ISOTime,
  ) {
    this.index();
  }
  async remember(
    operation: RememberOperation,
    input: RememberInput,
    requestId: string,
    signal?: AbortSignal,
    capturedReturns?: Awaited<ReturnType<QueryMemoryReturns>>,
  ): Promise<MemoryRef> {
    this.#writes.signal.throwIfAborted();
    signal?.throwIfAborted();
    const scope = JSON.stringify([operation.identity, operation.runId]);
    const request = serializeJson({ scope: operation.scope, input });
    const existing = this.receipt(this.index(), scope, requestId, request);
    if (existing !== null) return existing;
    const captured = JSON.parse(request) as {
      scope: ResearchScope;
      input: RememberInput;
    };
    const bound = { ...operation, scope: captured.scope };
    return this.#writes.run(
      JSON.stringify([scope, requestId]),
      request,
      async (active) => {
        const linked = this.runs.view(bound);
        if (linked.scope.security.id !== bound.scope.security.id)
          throw new ResearchError(
            "ACCESS_DENIED",
            "Memory review security must match the linked run.",
          );
        const previous = captured.input.previous;
        if (previous !== null)
          this.store.inspect((index, reader) => {
            assertMemoryState(index);
            this.assertCurrent(index, previous);
            const value = reader.readEntries<unknown>([previous])[0];
            assertMemoryEntry(value, previous);
            if (value.runId !== bound.runId)
              throw new ResearchError(
                "ACCESS_DENIED",
                "Memory revision belongs to another run.",
              );
          });
        for (const ref of captured.input.evidence) {
          if (ref.runId !== bound.runId)
            throw new ResearchError(
              "ACCESS_DENIED",
              "Memory evidence must belong to the linked run.",
            );
          if ("artifactId" in ref) this.runs.readArtifact(ref);
          else readPointer(this.runs.readEvidence(ref).envelope, ref.selector);
        }
        const returns = captured.input.returns;
        let recorded: MemoryEntry["returns"];
        if (returns.kind === "unavailable") recorded = returns;
        else {
          const result =
            capturedReturns ??
            (await this.queryReturns(
              structuredClone(bound.scope),
              structuredClone(returns.request),
              active,
            ));
          const {
            algorithmVersion,
            requestedStartDate,
            requestedEndDate,
            start,
            end,
            comparable,
            value,
            unit,
          } = result.data;
          const data = {
            algorithmVersion,
            requestedStartDate,
            requestedEndDate,
            start,
            end,
            comparable,
            value,
            unit,
          };
          const envelope = { ...result, data };
          delete envelope.candidateClaims;
          recorded = {
            kind: "recorded",
            snapshot: {
              scope: bound.scope,
              request: returns.request,
              envelope,
            },
          };
        }
        active.throwIfAborted();
        const completed = this.receipt(this.index(), scope, requestId, request);
        if (completed !== null) return completed;
        const saved = this.store.commit((current, writer) => {
          this.assertCurrent(current, previous);
          const content = captured.input;
          const ref = writer.entry(content.previous, (ref): MemoryEntry => ({
            ...content,
            ref,
            runId: bound.runId,
            securityId: bound.scope.security.id,
            identity: bound.identity,
            recordedAt: this.now(),
            returns: recorded,
          }));
          return {
            stateVersion: 1,
            receipts: [...current.receipts, { scope, requestId, request, ref }],
          };
        });
        return this.receipt(saved, scope, requestId, request)!;
      },
      signal,
    );
  }
  recall(
    scope: ResearchScope,
    query: RecallQuery,
    signal?: AbortSignal,
  ): MemorySnapshotEntry<MemoryEntry>[] {
    this.#writes.signal.throwIfAborted();
    signal?.throwIfAborted();
    return this.store.inspect((index, reader) => {
      assertMemoryState(index);
      const found: MemorySnapshotEntry<MemoryEntry>[] = [];
      const cutoff = Date.parse(scope.cutoff);
      const needle = query.text?.toLowerCase();
      let pending = Object.entries(index.entries).map(
        ([entryId, versions]) => ({
          entryId,
          versions,
          position: versions.length - 1,
        }),
      );
      while (pending.length > 0) {
        const refs = pending.map(({ entryId, versions, position }) => ({
          entryId,
          revision: versions[position]!,
        }));
        const entries = reader.readEntries<unknown>(refs);
        const older: typeof pending = [];
        for (let i = 0; i < pending.length; i++) {
          const entry = entries[i];
          assertMemoryEntry(entry, refs[i]!);
          if (Date.parse(entry.recordedAt) > cutoff) {
            const candidate = pending[i]!;
            if (candidate.position > 0)
              older.push({ ...candidate, position: candidate.position - 1 });
            continue;
          }
          if (
            entry.securityId !== scope.security.id ||
            (query.runId !== null && entry.runId !== query.runId)
          )
            continue;
          if (
            needle !== undefined &&
            !`${entry.outcome}\n${entry.note}`.toLowerCase().includes(needle)
          )
            continue;
          found.push({ ref: entry.ref, content: entry });
        }
        pending = older;
      }
      found.sort(
        (a, b) =>
          Date.parse(b.content.recordedAt) - Date.parse(a.content.recordedAt) ||
          a.ref.entryId.localeCompare(b.ref.entryId),
      );
      return found.slice(0, query.limit);
    });
  }
  recallForTask(
    operation: TaskOperation,
    query: RecallQuery,
    callId: string,
    signal?: AbortSignal,
    source: MemoryInputRegistration | null = null,
  ): MemoryInputSnapshot<MemoryEntry> {
    this.#writes.signal.throwIfAborted();
    signal?.throwIfAborted();
    // The task scope is owned by RunService; it cannot be supplied by the caller.
    const request = inputQuery(query);
    const prepared = this.runs.memoryInputForCall(
      operation,
      request,
      callId,
      source,
    );
    let inputRef = prepared.inputRef;
    if (inputRef === null) {
      const result =
        prepared.lineage === null
          ? this.runs.recordMemoryInput(
              operation,
              request,
              this.recall(prepared.scope, query, signal),
              callId,
            )
          : this.runs.replayMemoryInput(operation, request, callId, source);
      inputRef = result.inputRef;
    }
    return this.runs.readInput<MemoryInputSnapshot<MemoryEntry>>(
      operation.runId,
      inputRef,
    );
  }
  read(ref: MemoryRef): MemoryEntry {
    const value = this.store.readEntry<unknown>(ref);
    assertMemoryEntry(value, ref);
    return value;
  }
  close(): Promise<void> {
    return this.#writes.close();
  }
  private index(): MemoryIndex<MemoryState> {
    const index = this.store.readIndex();
    assertMemoryState(index);
    return index;
  }
  private receipt(
    index: MemoryIndex<MemoryState>,
    scope: string,
    requestId: string,
    request: string,
  ): MemoryRef | null {
    const previous = index.receipts.find(
      (receipt) => receipt.scope === scope && receipt.requestId === requestId,
    );
    if (previous === undefined) return null;
    if (previous.request !== request)
      throw new ResearchError(
        "REQUEST_CONFLICT",
        "Memory requestId has different content.",
      );
    return previous.ref;
  }
  private assertCurrent(
    index: MemoryIndex<MemoryState>,
    previous: MemoryRef | null,
  ): void {
    if (previous === null) return;
    if (
      !Object.hasOwn(index.entries, previous.entryId) ||
      index.entries[previous.entryId]!.at(-1) !== previous.revision
    )
      throw new ResearchError(
        "REQUEST_CONFLICT",
        "Memory revision is no longer current.",
      );
  }
}

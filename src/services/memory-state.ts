import type { MemoryEntry, MemoryState } from "../contracts/memory-service.js";
import type { MemoryIndex, MemoryRef } from "../contracts/memory.js";
import { ResearchError } from "../contracts/errors.js";
import { parseISOTime, parseLocalDate } from "../contracts/time.js";

function invalid(field: string): never {
  throw new ResearchError("STORAGE_FAILED", `Invalid stored memory: ${field}.`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function text(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") invalid(field);
}
function finite(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
}
function choice(
  value: unknown,
  options: readonly unknown[],
  field: string,
): void {
  if (!options.includes(value)) invalid(field);
}
function time(value: unknown, field: string, date = false): void {
  try {
    if (date) parseLocalDate(value);
    else parseISOTime(value);
  } catch (cause) {
    throw new ResearchError(
      "STORAGE_FAILED",
      `Invalid stored memory: ${field}.`,
      { cause },
    );
  }
}
function ref(value: unknown, field: string): MemoryRef {
  const item = object(value, field);
  text(item.entryId, `${field}.entryId`);
  if (
    typeof item.revision !== "number" ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1
  )
    invalid(`${field}.revision`);
  return item as unknown as MemoryRef;
}
function evidence(value: unknown, runId: unknown): void {
  for (const entry of list(value, "evidence")) {
    const item = object(entry, "evidence ref");
    text(item.runId, "evidence.runId");
    if (item.runId !== runId) invalid("evidence run mismatch");
    if (Object.hasOwn(item, "artifactId")) {
      text(item.artifactId, "evidence.artifactId");
      ref({ entryId: item.artifactId, revision: item.revision }, "artifact");
    } else {
      text(item.evidenceId, "evidence.evidenceId");
      if (typeof item.selector !== "string") invalid("evidence.selector");
    }
  }
}
function gaps(value: unknown, minimum: number): void {
  const values = list(value, "gaps");
  if (values.length < minimum) invalid("missing return explanation");
  for (const value of values) {
    const item = object(value, "gap");
    choice(
      item.code,
      ["missing", "stale", "unverified_time", "incomparable"],
      "gap.code",
    );
    text(item.field, "gap.field");
    text(item.detail, "gap.detail");
  }
}
function scope(value: unknown, securityId: unknown): void {
  const item = object(value, "return scope");
  const security = object(item.security, "security");
  for (const key of ["id", "symbol", "exchange", "currency", "timeZone"])
    text(security[key], `security.${key}`);
  choice(security.market, ["US", "CN"], "security.market");
  if (security.id !== securityId) invalid("return security mismatch");
  time(item.date, "scope.date", true);
  time(item.cutoff, "scope.cutoff");
}
function price(value: unknown): void {
  if (value === null) return;
  const item = object(value, "return price");
  time(item.date, "return price.date", true);
  finite(item.price, "return price.price");
  text(item.currency, "return price.currency");
  choice(
    item.adjustment,
    ["unadjusted", "split_adjusted", "total_return_adjusted"],
    "return price.adjustment",
  );
  time(item.asOf, "return price.asOf");
  if (item.availableAt !== null)
    time(item.availableAt, "return price.availableAt");
}
function returns(value: unknown, securityId: unknown): void {
  const item = object(value, "returns");
  choice(item.kind, ["recorded", "unavailable"], "returns.kind");
  if (item.kind === "unavailable") {
    gaps(item.gaps, 1);
    return;
  }
  const snapshot = object(item.snapshot, "return snapshot");
  scope(snapshot.scope, securityId);
  const request = object(snapshot.request, "return request");
  choice(request.dataset, ["returns"], "return request.dataset");
  choice(
    request.provider,
    ["yahoo", "eastmoney", "tencent"],
    "return request.provider",
  );
  const parameters = object(request.parameters, "return parameters");
  for (const key of ["historyStartDate", "startDate", "endDate"])
    time(parameters[key], key, true);
  finite(parameters.maxAgeMs, "maxAgeMs");
  choice(parameters.comparable, [true, false], "comparable");
  const envelope = object(snapshot.envelope, "return envelope");
  choice(envelope.dataset, ["returns"], "return envelope.dataset");
  for (const key of ["asOf", "retrievedAt", "cutoff"]) time(envelope[key], key);
  if (envelope.availableAt !== null) time(envelope.availableAt, "availableAt");
  finite(envelope.ageMs, "ageMs");
  choice(envelope.stale, [true, false], "stale");
  choice(
    envelope.historicalKnowledge,
    ["verified", "unverified"],
    "historicalKnowledge",
  );
  gaps(envelope.gaps, 0);
  const source = object(envelope.source, "return source");
  for (const key of [
    "provider",
    "url",
    "adapterVersion",
    "normalizationVersion",
  ])
    text(source[key], `return source.${key}`);
  const data = object(envelope.data, "return data");
  text(data.algorithmVersion, "algorithmVersion");
  time(data.requestedStartDate, "requestedStartDate", true);
  time(data.requestedEndDate, "requestedEndDate", true);
  price(data.start);
  price(data.end);
  choice(data.comparable, [true, false], "return comparable");
  choice(data.unit, ["ratio"], "return unit");
  if (data.value !== null) finite(data.value, "return value");
}
export function assertMemoryState(
  index: MemoryIndex<object>,
): asserts index is MemoryIndex<MemoryState> {
  const state = index as unknown as Record<string, unknown>;
  if (state.stateVersion !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `Unsupported memory state: ${String(state.stateVersion)}`,
    );
  const identities = new Set<string>();
  for (const value of list(state.receipts, "receipts")) {
    const item = object(value, "receipt");
    for (const key of ["scope", "requestId", "request"])
      text(item[key], `receipt.${key}`);
    const result = ref(item.ref, "receipt.ref");
    if (
      !Object.hasOwn(index.entries, result.entryId) ||
      !index.entries[result.entryId]!.includes(result.revision)
    )
      invalid("unregistered receipt result");
    const key = JSON.stringify([item.scope, item.requestId]);
    if (identities.has(key)) invalid("duplicate receipt identity");
    identities.add(key);
  }
}
export function assertMemoryEntry(
  value: unknown,
  expected: MemoryRef,
): asserts value is MemoryEntry {
  const item = object(value, "entry");
  const current = ref(item.ref, "entry.ref");
  if (
    current.entryId !== expected.entryId ||
    current.revision !== expected.revision
  )
    invalid("entry ref mismatch");
  if (item.previous !== null) {
    const previous = ref(item.previous, "previous");
    if (
      previous.entryId !== current.entryId ||
      previous.revision >= current.revision
    )
      invalid("previous revision");
  }
  for (const key of ["runId", "securityId", "identity", "outcome", "note"])
    text(item[key], key);
  time(item.recordedAt, "recordedAt");
  evidence(item.evidence, item.runId);
  returns(item.returns, item.securityId);
}

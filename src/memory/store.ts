import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ResearchError } from "../contracts/errors.js";
import type {
  MemoryIndex,
  MemoryRef,
  MemoryWriter,
} from "../contracts/memory.js";
import type { DataRoot } from "../storage/data-root.js";
import {
  createDirectory,
  nextRevision,
  publishJson,
  readJson,
  storageIO,
  writeImmutable,
} from "../storage/files.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(detail: string): never {
  throw new ResearchError("STORAGE_FAILED", `Invalid memory index: ${detail}`);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("expected an object");
  return value as Record<string, unknown>;
}

function decode<State extends object>(value: unknown): MemoryIndex<State> {
  const data = object(value);
  if (typeof data.schemaVersion !== "number") invalid("invalid schemaVersion");
  if (data.schemaVersion !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `Unsupported memory schema: ${data.schemaVersion}`,
    );
  if (
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 1
  )
    invalid("invalid index revision");
  const entries = object(data.entries);
  for (const [id, versions] of Object.entries(entries)) {
    if (!ID.test(id) || !Array.isArray(versions) || versions.length === 0)
      invalid("invalid entry registration");
    let previous = 0;
    for (const revision of versions) {
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision <= previous
      )
        invalid(
          "entry revisions are not strictly increasing positive integers",
        );
      previous = revision;
    }
  }
  return data as MemoryIndex<State>;
}

function registered(
  entries: Readonly<Record<string, readonly number[]>>,
  ref: MemoryRef,
): boolean {
  return (
    Object.hasOwn(entries, ref.entryId) &&
    entries[ref.entryId]!.includes(ref.revision)
  );
}

class FileEntries implements MemoryWriter {
  readonly entries: Record<string, number[]>;

  constructor(
    private readonly directory: string,
    entries: Readonly<Record<string, readonly number[]>>,
  ) {
    this.entries = Object.fromEntries(
      Object.entries(entries).map(([id, versions]) => [id, [...versions]]),
    );
  }

  entry(
    previous: MemoryRef | null,
    build: (ref: MemoryRef) => unknown,
  ): MemoryRef {
    let entryId: string;
    let revision: number;
    if (previous === null) {
      entryId = randomUUID();
      revision = 1;
    } else {
      if (!registered(this.entries, previous))
        throw new ResearchError(
          "VERSION_UNAVAILABLE",
          "Previous memory revision is not registered.",
        );
      entryId = previous.entryId;
      revision = nextRevision(
        join(this.directory, "entries", entryId),
        previous.revision,
      );
    }
    const ref: MemoryRef = { entryId, revision };
    writeImmutable(
      join(this.directory, "entries", entryId, `${revision}.json`),
      build(ref),
    );
    this.entries[entryId] =
      previous === null ? [revision] : [...this.entries[entryId]!, revision];
    return ref;
  }
}

export class MemoryStore<State extends object> {
  readonly #directory: string;
  readonly #indexPath: string;

  constructor(
    private readonly root: DataRoot,
    initialize: () => State,
  ) {
    root.assertOpen();
    this.#directory = join(root.path, "memory");
    this.#indexPath = join(this.#directory, "index.json");
    storageIO("Cannot initialize memory directory.", () =>
      createDirectory(this.#directory),
    );
    const existing = storageIO("Cannot inspect memory index.", () =>
      fs.statSync(this.#indexPath, { throwIfNoEntry: false }),
    );
    if (existing === undefined) {
      const entries = storageIO("Cannot inspect memory entries.", () =>
        fs.statSync(join(this.#directory, "entries"), {
          throwIfNoEntry: false,
        }),
      );
      if (entries !== undefined) invalid("entries exist without their index");
      const state = initialize();
      const index: MemoryIndex<State> = {
        ...state,
        schemaVersion: 1,
        revision: 1,
        entries: {},
      };
      publishJson(this.#directory, "index.json", index);
    } else {
      this.readIndex();
    }
  }

  readIndex(): MemoryIndex<State> {
    this.root.assertOpen();
    return decode<State>(readJson(this.#indexPath));
  }

  currentRefs(): MemoryRef[] {
    const index = this.readIndex();
    return Object.entries(index.entries).map(([entryId, versions]) => ({
      entryId,
      revision: versions.at(-1)!,
    }));
  }

  readEntry<T>(ref: MemoryRef): T {
    const index = this.readIndex();
    if (!registered(index.entries, ref))
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "Memory revision is not registered.",
      );
    return readJson(
      join(this.#directory, "entries", ref.entryId, `${ref.revision}.json`),
    ) as T;
  }

  commit(
    build: (current: MemoryIndex<State>, writer: MemoryWriter) => State,
  ): MemoryIndex<State> {
    const current = this.readIndex();
    const writer = new FileEntries(this.#directory, current.entries);
    const state = build(current, writer);
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) invalid("index revision exhausted");
    const index: MemoryIndex<State> = {
      ...state,
      schemaVersion: 1,
      revision,
      entries: writer.entries,
    };
    publishJson(this.#directory, "index.json", index);
    return index;
  }
}

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ResearchError } from "../contracts/errors.js";
import type {
  ArtifactContentRef,
  ContentRef,
  ContentWriter,
  RunLocation,
  StoredRun,
  ProjectionWrite,
} from "../contracts/storage.js";
import type { DataRoot } from "../storage/data-root.js";
import {
  createDirectory,
  publishJson,
  nextRevision,
  readJson,
  storageIO,
  syncDirectory,
  writeImmutable,
} from "../storage/files.js";
import { syncProjectionFiles } from "./projections.js";
import { creationRunId, isKeyedRunId, RUN_ID as ID } from "./creation-id.js";

const UUID_LENGTH = 36;

function invalid(detail: string): never {
  throw new ResearchError(
    "STORAGE_FAILED",
    `Invalid stored manifest: ${detail}`,
  );
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("expected an object");
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function contentPath(ref: ContentRef): string {
  return ref.kind === "artifact"
    ? `artifacts/${ref.id}/${ref.revision}.json`
    : `${ref.kind === "input" ? "inputs" : "evidence"}/${ref.id}.json`;
}

function decode<State extends object>(value: unknown): StoredRun<State> {
  const data = object(value);
  if (typeof data.schemaVersion !== "number") invalid("missing schemaVersion");
  if (data.schemaVersion !== 1)
    throw new ResearchError(
      "VERSION_UNAVAILABLE",
      `Unsupported manifest schema: ${data.schemaVersion}`,
    );
  if (typeof data.runId !== "string" || !ID.test(data.runId))
    invalid("invalid runId");
  if (!positiveInteger(data.revision)) invalid("invalid revision");
  if (!Array.isArray(data.contents)) invalid("missing content registry");
  const keys = new Set<string>();
  for (const value of data.contents) {
    const ref = object(value);
    if (typeof ref.id !== "string" || !ID.test(ref.id))
      invalid("invalid content identifier");
    if (
      ref.kind !== "input" &&
      ref.kind !== "evidence" &&
      ref.kind !== "artifact"
    )
      invalid("invalid content kind");
    if (ref.kind === "artifact" && !positiveInteger(ref.revision))
      invalid("invalid artifact revision");
    const key = contentPath(ref as unknown as ContentRef);
    if (keys.has(key)) invalid("duplicate content registration");
    keys.add(key);
  }
  return data as StoredRun<State>;
}

class FileContents implements ContentWriter {
  readonly entries: ContentRef[];

  constructor(
    private readonly directory: string,
    contents: readonly ContentRef[],
  ) {
    this.entries = [...contents];
  }

  input(build: (id: string) => unknown): ContentRef {
    return this.write("input", build);
  }

  evidence(build: (id: string) => unknown): ContentRef {
    return this.write("evidence", build);
  }

  private write(
    kind: "input" | "evidence",
    build: (id: string) => unknown,
  ): ContentRef {
    const ref: ContentRef = { kind, id: randomUUID() };
    writeImmutable(join(this.directory, contentPath(ref)), build(ref.id));
    this.entries.push(ref);
    return ref;
  }

  artifact(
    previous: ArtifactContentRef | null,
    build: (ref: ArtifactContentRef) => unknown,
  ): ArtifactContentRef {
    let id: string;
    let revision: number;
    if (previous === null) {
      id = randomUUID();
      revision = 1;
    } else {
      if (
        !this.entries.some(
          (entry) => contentPath(entry) === contentPath(previous),
        )
      )
        throw new ResearchError(
          "VERSION_UNAVAILABLE",
          "Previous artifact version is not registered in this run.",
        );
      id = previous.id;
      revision = nextRevision(
        join(this.directory, "artifacts", id),
        previous.revision,
      );
    }
    const ref: ArtifactContentRef = { kind: "artifact", id, revision };
    writeImmutable(join(this.directory, contentPath(ref)), build(ref));
    this.entries.push(ref);
    return ref;
  }
}

export class RunStore<State extends object> {
  readonly #directories = new Map<
    string,
    { path: string; committed: boolean }
  >();

  constructor(private readonly root: DataRoot) {
    root.assertOpen();
    const directory = join(root.path, "runs");
    storageIO("Cannot initialize runs directory.", () =>
      createDirectory(directory),
    );
    const dates = storageIO("Cannot enumerate run dates.", () =>
      fs.readdirSync(directory, { withFileTypes: true }),
    );
    for (const date of dates) {
      if (!date.isDirectory()) continue;
      const parent = join(directory, date.name);
      const runs = storageIO("Cannot enumerate runs.", () =>
        fs.readdirSync(parent, { withFileTypes: true }),
      );
      for (const run of runs) {
        if (!run.isDirectory()) continue;
        const path = join(parent, run.name);
        const committed = this.hasManifest(path);
        const runId = run.name.slice(-UUID_LENGTH);
        // An unfinished keyed creation is still a reservation for that request.
        if (!committed && !(ID.test(runId) && isKeyedRunId(runId))) continue;
        if (!ID.test(runId) || !run.name.endsWith(`-${runId}`))
          invalid("run directory has no valid identifier");
        if (this.#directories.has(runId)) invalid("duplicate run identifier");
        this.#directories.set(runId, { path, committed });
      }
    }
  }

  create(
    location: RunLocation,
    build: (runId: string, writer: ContentWriter) => State,
    creationKey?: string,
  ): StoredRun<State> {
    this.root.assertOpen();
    const runId =
      creationKey === undefined ? randomUUID() : creationRunId(creationKey);
    if (this.#directories.has(runId))
      throw new ResearchError(
        "STORAGE_FAILED",
        `Run ${runId} already has a directory; read its manifest before retrying creation.`,
      );
    const security = location.securityId.replace(/[^A-Za-z0-9._-]/g, "_");
    const directory = join(
      this.root.path,
      "runs",
      location.date,
      `${security}-${location.mode}-${runId}`,
    );
    const entry = { path: directory, committed: false };
    storageIO("Cannot create run directory.", () => {
      const parent = join(this.root.path, "runs", location.date);
      createDirectory(parent);
      fs.mkdirSync(directory);
      this.#directories.set(runId, entry);
      // Persist both the new directory inode and its name in the parent.
      syncDirectory(directory);
      syncDirectory(parent);
    });
    const writer = new FileContents(directory, []);
    const state = build(runId, writer);
    const manifest: StoredRun<State> = {
      ...state,
      schemaVersion: 1,
      runId,
      revision: 1,
      contents: writer.entries,
    };
    publishJson(directory, "manifest.json", manifest);
    entry.committed = true;
    return manifest;
  }

  findCreation(key: string): string | null {
    this.root.assertOpen();
    const runId = creationRunId(key);
    return this.#directories.has(runId) ? runId : null;
  }

  read(runId: string): StoredRun<State> {
    this.root.assertOpen();
    const entry = this.entry(runId);
    const manifest = decode<State>(readJson(join(entry.path, "manifest.json")));
    if (manifest.runId !== runId) invalid("run identifier changed");
    entry.committed = true;
    return manifest;
  }

  listRunIds(): string[] {
    this.root.assertOpen();
    const result: string[] = [];
    for (const [runId, entry] of this.#directories) {
      if (entry.committed || this.hasManifest(entry.path)) result.push(runId);
    }
    return result;
  }

  list(): StoredRun<State>[] {
    return this.listRunIds().map((runId) => this.read(runId));
  }

  commit(
    runId: string,
    build: (current: StoredRun<State>, writer: ContentWriter) => State,
  ): StoredRun<State> {
    const current = this.read(runId);
    const directory = this.entry(runId).path;
    const writer = new FileContents(directory, current.contents);
    const state = build(current, writer);
    const revision = current.revision + 1;
    if (!positiveInteger(revision)) invalid("manifest revision exhausted");
    const manifest: StoredRun<State> = {
      ...state,
      schemaVersion: 1,
      runId,
      revision,
      contents: writer.entries,
    };
    publishJson(directory, "manifest.json", manifest);
    return manifest;
  }

  readContent<T>(runId: string, ref: ContentRef): T {
    const manifest = this.read(runId);
    if (
      !manifest.contents.some(
        (entry) => contentPath(entry) === contentPath(ref),
      )
    )
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "Content is not registered in this run.",
      );
    return readJson(join(this.entry(runId).path, contentPath(ref))) as T;
  }

  readContents<T>(runId: string, refs: readonly ContentRef[]): T[] {
    const manifest = this.read(runId);
    const registered = new Set(manifest.contents.map(contentPath));
    const paths = refs.map(contentPath);
    for (const path of paths)
      if (!registered.has(path))
        throw new ResearchError(
          "VERSION_UNAVAILABLE",
          "Content is not registered in this run.",
        );
    return paths.map(
      (path) => readJson(join(this.entry(runId).path, path)) as T,
    );
  }

  syncProjections(
    runId: string,
    revision: number,
    projections: readonly ProjectionWrite[],
  ): void {
    const current = this.read(runId);
    if (current.revision !== revision)
      throw new ResearchError(
        "VERSION_UNAVAILABLE",
        "Projection snapshot is no longer the current manifest revision.",
      );
    syncProjectionFiles(this.entry(runId).path, projections);
  }

  private entry(runId: string): { path: string; committed: boolean } {
    const directory = this.#directories.get(runId);
    if (directory === undefined)
      throw new ResearchError("VERSION_UNAVAILABLE", "Run is not registered.");
    return directory;
  }

  private hasManifest(directory: string): boolean {
    return storageIO(
      "Cannot inspect run manifest.",
      () =>
        fs.statSync(join(directory, "manifest.json"), {
          throwIfNoEntry: false,
        }) !== undefined,
    );
  }
}

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

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
        if (!this.hasManifest(path)) continue;
        const manifest = decode<State>(readJson(join(path, "manifest.json")));
        if (!run.name.endsWith(`-${manifest.runId}`))
          invalid("run directory and identifier differ");
        if (this.#directories.has(manifest.runId))
          invalid("duplicate run identifier");
        this.#directories.set(manifest.runId, { path, committed: true });
      }
    }
  }

  create(
    location: RunLocation,
    build: (runId: string, writer: ContentWriter) => State,
  ): StoredRun<State> {
    this.root.assertOpen();
    const runId = randomUUID();
    const security = location.securityId.replace(/[^A-Za-z0-9._-]/g, "_");
    const directory = join(
      this.root.path,
      "runs",
      location.date,
      `${security}-${location.mode}-${runId}`,
    );
    storageIO("Cannot create run directory.", () => {
      const parent = join(this.root.path, "runs", location.date);
      createDirectory(parent);
      fs.mkdirSync(directory);
      // Persist both the new directory inode and its name in the parent.
      syncDirectory(directory);
      syncDirectory(parent);
    });
    // Keep the locator even if publication reports an ambiguous post-rename failure.
    const entry = { path: directory, committed: false };
    this.#directories.set(runId, entry);
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

  read(runId: string): StoredRun<State> {
    this.root.assertOpen();
    const entry = this.entry(runId);
    const manifest = decode<State>(readJson(join(entry.path, "manifest.json")));
    if (manifest.runId !== runId) invalid("run identifier changed");
    entry.committed = true;
    return manifest;
  }

  list(): StoredRun<State>[] {
    this.root.assertOpen();
    const result: StoredRun<State>[] = [];
    for (const [runId, entry] of this.#directories) {
      if (entry.committed || this.hasManifest(entry.path))
        result.push(this.read(runId));
    }
    return result;
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

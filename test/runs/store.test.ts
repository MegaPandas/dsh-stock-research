import fs from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactContentRef,
  ContentRef,
} from "../../src/contracts/storage.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { RunStore } from "../../src/runs/store.js";

interface State {
  label: string;
  ref?: ContentRef;
  artifact?: ArtifactContentRef;
}
const location = {
  date: "2024-01-02",
  securityId: "US:NVDA",
  mode: "quick",
} as const;
const directories: string[] = [];
const roots: DataRoot[] = [];
function directory() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-store-test-"));
  directories.push(path);
  return path;
}
function open(path = directory()) {
  const root = new DataRoot(path);
  roots.push(root);
  return { path, root, store: new RunStore<State>(root) };
}
function runDirectory(path: string, id: string) {
  return join(path, "runs", location.date, `US_NVDA-quick-${id}`);
}
function contentPath(path: string, id: string, ref: ContentRef) {
  return join(
    runDirectory(path, id),
    ref.kind === "artifact"
      ? `artifacts/${ref.id}/${ref.revision}.json`
      : `${ref.kind === "input" ? "inputs" : "evidence"}/${ref.id}.json`,
  );
}
function manifestPath(path: string, id: string) {
  return join(runDirectory(path, id), "manifest.json");
}
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected failure");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) root.close();
  for (const path of directories.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("single-writer run store", () => {
  it("batch reads registered contents in request order with one manifest read", () => {
    const { path, store } = open();
    const run = store.create(location, (_runId, writer) => {
      writer.input(() => ({ value: 1 }));
      writer.evidence(() => ({ value: 2 }));
      writer.artifact(null, () => ({ value: 3 }));
      return { label: "batch" };
    });
    const read = vi.spyOn(fs, "readFileSync");
    const result = store.readContents<{ value: number }>(run.runId, [
      run.contents[1]!,
      run.contents[0]!,
      run.contents[2]!,
    ]);
    expect(result).toEqual([{ value: 2 }, { value: 1 }, { value: 3 }]);
    expect(
      read.mock.calls.filter(
        ([file]) => String(file) === manifestPath(path, run.runId),
      ),
    ).toHaveLength(1);
    result[0]!.value = 99;
    expect(store.readContent(run.runId, run.contents[1]!)).toEqual({
      value: 2,
    });
  });

  it("batch reads reject a foreign reference even alongside registered content", () => {
    const { store } = open();
    const first = store.create(location, (_runId, writer) => ({
      label: "first",
      ref: writer.input(() => ({ value: 1 })),
    }));
    const second = store.create(location, (_runId, writer) => ({
      label: "second",
      ref: writer.input(() => ({ value: 2 })),
    }));
    expect(() =>
      store.readContents(first.runId, [first.ref!, second.ref!]),
    ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
    expect(store.readContent(second.runId, second.ref!)).toEqual({ value: 2 });
  });

  it("batch reads preserve missing-file causes and data-root ownership", () => {
    const { path, root, store } = open();
    const run = store.create(location, (_runId, writer) => ({
      label: "batch",
      ref: writer.input(() => ({ value: 1 })),
    }));
    fs.unlinkSync(contentPath(path, run.runId, run.ref!));
    expect(
      caught(() => store.readContents(run.runId, [run.ref!])),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: { code: "ENOENT" } });
    root.close();
    expect(() => store.readContents(run.runId, [])).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(() => store.readContent(run.runId, run.ref!)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it("writes a real manifest and registered immutable inputs and evidence", () => {
    const { path, store } = open();
    const run = store.create(location, (runId, writer) => {
      const ref = writer.input((id) => ({ id, runId, prices: [1, 2] }));
      writer.evidence((id) => ({ id, source: "sample" }));
      return { label: "created", ref };
    });
    expect(run).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      label: "created",
    });
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.contents.map(({ kind }) => kind)).toEqual(["input", "evidence"]);
    expect(
      JSON.parse(fs.readFileSync(manifestPath(path, run.runId), "utf8")),
    ).toEqual(run);
    expect(store.readContent(run.runId, run.ref!)).toEqual({
      id: run.ref!.id,
      runId: run.runId,
      prices: [1, 2],
    });
    expect(fs.existsSync(contentPath(path, run.runId, run.contents[1]!))).toBe(
      true,
    );
    expect(store.list()).toEqual([run]);
  });

  it("reopens persisted state and old artifact versions after a commit", () => {
    const { path, root, store } = open();
    const first = store.create(location, (_id, writer) => ({
      label: "first",
      artifact: writer.artifact(null, (ref) => ({ ref, text: "old" })),
    }));
    const next = store.commit(first.runId, (current, writer) => ({
      label: "next",
      artifact: writer.artifact(current.artifact!, (ref) => ({
        ref,
        text: "new",
      })),
    }));
    expect(next.revision).toBe(2);
    expect(next.artifact).toEqual({ ...first.artifact, revision: 2 });
    expect(next.contents).toEqual([first.artifact, next.artifact]);
    root.close();
    const reopened = open(path).store;
    expect(reopened.read(first.runId)).toEqual(next);
    expect(reopened.readContent(first.runId, first.artifact!)).toEqual({
      ref: first.artifact,
      text: "old",
    });
    expect(reopened.readContent(first.runId, next.artifact!)).toEqual({
      ref: next.artifact,
      text: "new",
    });
  });

  it("does not let returned state mutations alter disk state", () => {
    const { store } = open();
    const run = store.create(location, () => ({ label: "original" }));
    run.label = "changed";
    expect(store.read(run.runId).label).toBe("original");
    const read = store.read(run.runId);
    read.label = "also changed";
    expect(store.list()[0]!.label).toBe("original");
  });

  it("preserves opaque business fields instead of imposing business schemas", () => {
    const root = open().root;
    const store = new RunStore<{
      custom: { status: number; nested: string[] };
    }>(root);
    const run = store.create(location, () => ({
      custom: { status: 123, nested: ["opaque"] },
    }));
    expect(store.read(run.runId).custom).toEqual({
      status: 123,
      nested: ["opaque"],
    });
  });

  it("propagates builder errors unchanged and leaves unpublished content inaccessible", () => {
    const { store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    const failure = new Error("business failed");
    let orphan: ContentRef | undefined;
    expect(
      caught(() =>
        store.commit(run.runId, (_current, writer) => {
          orphan = writer.evidence(() => ({ value: 42 }));
          throw failure;
        }),
      ),
    ).toBe(failure);
    expect(store.read(run.runId)).toEqual(run);
    expect(() => store.readContent(run.runId, orphan!)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("keeps the old manifest and closes the descriptor when content writing fails", () => {
    const { path, store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    const originalWrite = fs.writeFileSync;
    const failure = new Error("disk write failed");
    let failedFd: number | undefined;
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "number") {
          failedFd = args[0];
          originalWrite(args[0], "{", "utf8");
          throw failure;
        }
        return originalWrite(...args);
      },
    );
    const error = caught(() =>
      store.commit(run.runId, (_current, writer) => ({
        label: "new",
        ref: writer.input(() => ({ payload: true })),
      })),
    );
    expect(error).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(() => fs.fstatSync(failedFd!)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(store.read(run.runId)).toEqual(run);
    expect(
      JSON.parse(fs.readFileSync(manifestPath(path, run.runId), "utf8")),
    ).toEqual(run);
  });

  it("preserves both write and close failures while retaining the old manifest", () => {
    const { store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    const write = fs.writeFileSync;
    const close = fs.closeSync;
    const writeFailure = new Error("content write failed");
    const closeFailure = new Error("content close failed");
    let failedFd: number | undefined;
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "number") {
          failedFd = args[0];
          throw writeFailure;
        }
        return write(...args);
      },
    );
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd);
      if (fd === failedFd) throw closeFailure;
    });
    const error = caught(() =>
      store.commit(run.runId, (_current, writer) => ({
        label: "new",
        ref: writer.input(() => ({ value: 42 })),
      })),
    );
    expect(error).toMatchObject({
      code: "STORAGE_FAILED",
      cause: expect.any(AggregateError),
    });
    expect((error as Error).cause).toMatchObject({
      cause: writeFailure,
      errors: expect.arrayContaining([writeFailure, closeFailure]),
    });
    vi.restoreAllMocks();
    expect(() => fs.fstatSync(failedFd!)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(store.read(run.runId)).toEqual(run);
  });

  it("does not publish successfully written content when manifest rename fails", () => {
    const { path, store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    const failure = new Error("rename failed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    let ref: ContentRef | undefined;
    expect(
      caught(() =>
        store.commit(run.runId, (_current, writer) => {
          ref = writer.input(() => ({ value: 42 }));
          return { label: "new", ref };
        }),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(fs.existsSync(contentPath(path, run.runId, ref!))).toBe(true);
    expect(store.read(run.runId)).toEqual(run);
    expect(() => store.readContent(run.runId, ref!)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("recovers the new manifest after rename succeeds but directory fsync fails", () => {
    const { path, root, store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    const failure = new Error("directory sync failed");
    let published = false;
    let failedFd: number | undefined;
    let ref: ContentRef | undefined;
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) {
        failedFd = fd;
        throw failure;
      }
      sync(fd);
    });
    expect(
      caught(() =>
        store.commit(run.runId, (_current, writer) => {
          ref = writer.evidence(() => ({ saved: true }));
          return { label: "published", ref };
        }),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(() => fs.fstatSync(failedFd!)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(store.read(run.runId)).toMatchObject({
      revision: 2,
      label: "published",
    });
    root.close();
    const reopened = open(path).store;
    expect(reopened.read(run.runId)).toMatchObject({
      revision: 2,
      label: "published",
    });
    expect(reopened.readContent(run.runId, ref!)).toEqual({ saved: true });
  });

  it("omits directories whose initial manifest was never published", () => {
    const { path, root, store } = open();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("not published");
    });
    expect(() =>
      store.create(location, () => ({ label: "unpublished" })),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    vi.restoreAllMocks();
    expect(store.list()).toEqual([]);
    root.close();
    expect(open(path).store.list()).toEqual([]);
  });

  it("reports a deleted committed manifest instead of silently omitting its run", () => {
    const { path, store } = open();
    const run = store.create(location, () => ({ label: "committed" }));
    fs.unlinkSync(manifestPath(path, run.runId));
    expect(caught(() => store.list())).toMatchObject({
      code: "STORAGE_FAILED",
      cause: { code: "ENOENT" },
    });
  });

  it("discovers an initial create published before directory sync failed", () => {
    const { path, root, store } = open();
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    const failure = new Error("initial directory sync failed");
    let published = false;
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() =>
        store.create(location, (_id, writer) => ({
          label: "created",
          ref: writer.input(() => ({ persisted: true })),
        })),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    const visible = store.list();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ label: "created", revision: 1 });
    root.close();
    const reopened = open(path).store;
    expect(reopened.read(visible[0]!.runId)).toEqual(visible[0]);
    expect(reopened.readContent(visible[0]!.runId, visible[0]!.ref!)).toEqual({
      persisted: true,
    });
  });

  it("recovers a visible manifest after SIGKILL between rename and directory sync", () => {
    const path = directory();
    const fixture = fileURLToPath(
      new URL("../fixtures/run-store-crash.mjs", import.meta.url),
    );
    const child = spawnSync(process.execPath, [fixture, path], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    const { runId } = JSON.parse(child.stdout) as { runId: string };
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(join(path, ".writer.lock"))).toBe(true);
    const { store } = open(path);
    const recovered = store.read(runId);
    expect(recovered).toMatchObject({ revision: 2, label: "new" });
    expect(recovered.contents.map(({ kind }) => kind)).toEqual([
      "input",
      "evidence",
    ]);
    expect(
      recovered.contents.map((ref) => store.readContent(runId, ref)),
    ).toEqual([{ value: "old input" }, { value: "new evidence" }]);
  }, 15_000);

  it("skips physical orphan artifact revisions without overwriting them", () => {
    const { path, store } = open();
    const run = store.create(location, (_id, writer) => ({
      label: "first",
      artifact: writer.artifact(null, () => ({ value: 1 })),
    }));
    const orphan: ArtifactContentRef = { ...run.artifact!, revision: 2 };
    fs.writeFileSync(
      contentPath(path, run.runId, orphan),
      JSON.stringify({ orphan: true }),
      { flag: "wx" },
    );
    const next = store.commit(run.runId, (_current, writer) => ({
      label: "next",
      artifact: writer.artifact(run.artifact!, () => ({ value: 3 })),
    }));
    expect(next.artifact!.revision).toBe(3);
    expect(
      JSON.parse(fs.readFileSync(contentPath(path, run.runId, orphan), "utf8")),
    ).toEqual({ orphan: true });
    expect(() => store.readContent(run.runId, orphan)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("rejects foreign content and foreign artifact ancestry", () => {
    const { store } = open();
    const first = store.create(location, (_id, writer) => ({
      label: "first",
      artifact: writer.artifact(null, () => ({ value: 1 })),
    }));
    const second = store.create(location, () => ({ label: "second" }));
    expect(() => store.readContent(second.runId, first.artifact!)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
    expect(() =>
      store.commit(second.runId, (_current, writer) => ({
        label: "invalid",
        artifact: writer.artifact(first.artifact!, () => ({})),
      })),
    ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
    expect(store.read(second.runId).revision).toBe(1);
  });

  it("rejects concurrent ownership in this process and another process", () => {
    const { path } = open();
    expect(caught(() => new DataRoot(path))).toMatchObject({
      code: "STORAGE_FAILED",
    });
    const fixture = fileURLToPath(
      new URL("../fixtures/writer-lock-probe.mjs", import.meta.url),
    );
    const child = spawnSync(process.execPath, [fixture, path], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("blocked");
  });

  it("allows exactly one simultaneous process contender to hold the data root", async () => {
    const path = directory();
    const fixture = fileURLToPath(
      new URL("../fixtures/writer-lock-contender.mjs", import.meta.url),
    );
    const children = [
      fork(fixture, [path], { silent: true }),
      fork(fixture, [path], { silent: true }),
    ];
    const message = (child: (typeof children)[number]) =>
      new Promise<unknown>((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
      });
    try {
      expect(await Promise.all(children.map(message))).toEqual([
        "ready",
        "ready",
      ]);
      const outcomes = children.map(message);
      for (const child of children) child.send("start");
      expect((await Promise.all(outcomes)).sort()).toEqual([
        "acquired",
        "blocked",
      ]);
      expect(() => new DataRoot(path)).toThrowError(
        expect.objectContaining({ code: "STORAGE_FAILED" }),
      );
    } finally {
      const exited = children.map(
        (child) =>
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
      );
      for (const child of children) child.send("release");
      await Promise.all(exited);
    }
    open(path).root.close();
  }, 10_000);

  it("rejects legacy JSON locks without deleting them", () => {
    const path = directory();
    const text = JSON.stringify({
      pid: 2147483647,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00Z",
    });
    fs.writeFileSync(join(path, ".writer.lock"), text);
    expect(caught(() => new DataRoot(path))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: expect.any(Error),
    });
    expect(fs.readFileSync(join(path, ".writer.lock"), "utf8")).toBe(text);
  });

  it("makes repeated close safe without deleting a replacement owner's lock", () => {
    const { path, root, store } = open();
    const run = store.create(location, () => ({ label: "old" }));
    root.close();
    const replacement = open(path);
    root.close();
    expect(() => new DataRoot(path)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(() =>
      store.commit(run.runId, () => ({ label: "forbidden" })),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    expect(replacement.store.read(run.runId).revision).toBe(1);
  });

  it("closes its SQLite connection if lock acquisition fails", () => {
    const path = directory();
    const failure = new Error("lock acquisition failed");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(() => {
      throw failure;
    });
    expect(caught(() => new DataRoot(path))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: failure,
    });
    expect(close).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    expect(open(path).store.list()).toEqual([]);
  });

  it.each(["json", "schema", "unsafe-path", "duplicate-content"])(
    "rejects %s corruption without clearing or rebuilding stored data",
    (kind) => {
      const { path, root, store } = open();
      const run = store.create(location, (_id, writer) => ({
        label: "original",
        ref: writer.input(() => ({ value: 42 })),
      }));
      const malformed =
        kind === "json"
          ? "{"
          : JSON.stringify({
              ...run,
              ...(kind === "schema" ? { schemaVersion: 2 } : {}),
              ...(kind === "unsafe-path"
                ? { contents: [{ kind: "input", id: "../../escape" }] }
                : {}),
              ...(kind === "duplicate-content"
                ? { contents: [run.ref, run.ref] }
                : {}),
            });
      fs.writeFileSync(manifestPath(path, run.runId), malformed);
      const expected =
        kind === "schema" ? "VERSION_UNAVAILABLE" : "STORAGE_FAILED";
      expect(() => store.read(run.runId)).toThrowError(
        expect.objectContaining({ code: expected }),
      );
      root.close();
      const nextRoot = new DataRoot(path);
      roots.push(nextRoot);
      expect(() => new RunStore<State>(nextRoot)).toThrowError(
        expect.objectContaining({ code: expected }),
      );
      expect(fs.readFileSync(manifestPath(path, run.runId), "utf8")).toBe(
        malformed,
      );
      expect(
        JSON.parse(
          fs.readFileSync(contentPath(path, run.runId, run.ref!), "utf8"),
        ),
      ).toEqual({ value: 42 });
    },
  );
});

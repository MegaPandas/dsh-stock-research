import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRef } from "../../src/contracts/memory.js";
import type { ContentRef } from "../../src/contracts/storage.js";
import { MemoryStore } from "../../src/memory/store.js";
import { RunStore } from "../../src/runs/store.js";
import { DataRoot } from "../../src/storage/data-root.js";

interface State {
  label: string;
  receipt?: string;
  ref?: MemoryRef;
}
const directories: string[] = [];
const roots: DataRoot[] = [];
function directory() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-memory-test-"));
  directories.push(path);
  return path;
}
function open(path = directory()) {
  const root = new DataRoot(path);
  roots.push(root);
  return {
    root,
    path,
    store: new MemoryStore<State>(root, () => ({ label: "initial" })),
  };
}
function indexPath(path: string) {
  return join(path, "memory", "index.json");
}
function entryPath(path: string, ref: MemoryRef) {
  return join(path, "memory", "entries", ref.entryId, `${ref.revision}.json`);
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

describe("memory version store", () => {
  it("initializes a fresh index and reopens without calling its initializer", () => {
    const { path, root, store } = open();
    expect(store.readIndex()).toEqual({
      label: "initial",
      schemaVersion: 1,
      revision: 1,
      entries: {},
    });
    expect(store.currentRefs()).toEqual([]);
    const committed = store.commit(() => ({ label: "persisted" }));
    root.close();
    const replacement = new DataRoot(path);
    roots.push(replacement);
    const initialize = vi.fn(() => ({ label: "reset" }));
    const reopened = new MemoryStore<State>(replacement, initialize);
    expect(initialize).not.toHaveBeenCalled();
    expect(reopened.readIndex()).toEqual(committed);
  });

  it("keeps registered old versions readable and returns only current heads after reopening", () => {
    const { path, root, store } = open();
    const first = store.commit((_current, writer) => ({
      label: "first",
      ref: writer.entry(null, (ref) => ({ ref, value: "old" })),
    }));
    const second = store.commit((current, writer) => ({
      label: "second",
      ref: writer.entry(current.ref!, (ref) => ({ ref, value: "new" })),
    }));
    expect(second.ref).toEqual({ entryId: first.ref!.entryId, revision: 2 });
    expect(second.entries).toEqual({ [first.ref!.entryId]: [1, 2] });
    root.close();
    const reopened = open(path).store;
    expect(reopened.currentRefs()).toEqual([second.ref]);
    expect(reopened.readEntry(first.ref!)).toEqual({
      ref: first.ref,
      value: "old",
    });
    expect(reopened.readEntry(second.ref!)).toEqual({
      ref: second.ref,
      value: "new",
    });
  });

  it("isolates returned index mutations from persisted state and entry registration", () => {
    const { store } = open();
    const index = store.commit((_current, writer) => ({
      label: "saved",
      ref: writer.entry(null, () => ({ value: 42 })),
    }));
    index.label = "mutated";
    const read = store.readIndex();
    read.label = "mutated read";
    expect(store.readIndex().label).toBe("saved");
    const heads = store.currentRefs();
    heads.length = 0;
    expect(store.currentRefs()).toEqual([index.ref]);
  });

  it("shares one DataRoot with RunStore without changing existing run files", () => {
    const { path, root, store } = open();
    const runs = new RunStore<{ ref: ContentRef }>(root);
    const run = runs.create(
      { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
      (_id, writer) => {
        const ref = writer.input(() => ({ immutable: true }));
        return { ref };
      },
    );
    const manifest = join(
      path,
      "runs",
      "2024-01-02",
      `US_NVDA-quick-${run.runId}`,
      "manifest.json",
    );
    const before = fs.readFileSync(manifest, "utf8");
    store.commit((_current, writer) => ({
      label: "memory changed",
      ref: writer.entry(null, () => ({ note: true })),
    }));
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
    expect(runs.readContent(run.runId, run.ref)).toEqual({ immutable: true });
  });

  it("publishes opaque receipt state and entry registration together", () => {
    const { path, store } = open();
    const index = store.commit((_current, writer) => ({
      label: "accepted",
      receipt: "request-42",
      ref: writer.entry(null, () => ({ nested: ["business payload"] })),
    }));
    const disk = JSON.parse(fs.readFileSync(indexPath(path), "utf8"));
    expect(disk).toEqual({
      label: "accepted",
      receipt: "request-42",
      ref: index.ref,
      schemaVersion: 1,
      revision: 2,
      entries: { [index.ref!.entryId]: [1] },
    });
    expect(store.readEntry(index.ref!)).toEqual({
      nested: ["business payload"],
    });
  });

  it("propagates builder errors and keeps their written orphan unregistered", () => {
    const { path, store } = open();
    const before = store.readIndex();
    const failure = new Error("business failed");
    let orphan: MemoryRef | undefined;
    expect(
      caught(() =>
        store.commit((_current, writer) => {
          orphan = writer.entry(null, () => ({ orphan: true }));
          throw failure;
        }),
      ),
    ).toBe(failure);
    expect(fs.existsSync(entryPath(path, orphan!))).toBe(true);
    expect(store.readIndex()).toEqual(before);
    expect(() => store.readEntry(orphan!)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("keeps the old index when writing an entry fails", () => {
    const { store } = open();
    const before = store.readIndex();
    const write = fs.writeFileSync;
    const failure = new Error("entry write failed");
    vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === "number") throw failure;
        return write(...args);
      },
    );
    expect(
      caught(() =>
        store.commit((_current, writer) => ({
          label: "new",
          ref: writer.entry(null, () => ({ value: 42 })),
        })),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(store.readIndex()).toEqual(before);
    expect(store.currentRefs()).toEqual([]);
  });

  it("does not expose a written entry if publishing the index fails", () => {
    const { path, store } = open();
    const before = store.readIndex();
    const failure = new Error("rename failed");
    let orphan: MemoryRef | undefined;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    expect(
      caught(() =>
        store.commit((_current, writer) => {
          orphan = writer.entry(null, () => ({ value: 42 }));
          return { label: "new", ref: orphan };
        }),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(fs.existsSync(entryPath(path, orphan!))).toBe(true);
    expect(store.readIndex()).toEqual(before);
    expect(() => store.readEntry(orphan!)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
  });

  it("recovers new state and heads when index rename succeeds before a directory sync error", () => {
    const { path, root, store } = open();
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("index directory sync failed");
    let ref: MemoryRef | undefined;
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      if (String(args[1]) === indexPath(path)) published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() =>
        store.commit((_current, writer) => {
          ref = writer.entry(null, () => ({ saved: true }));
          return { label: "published", receipt: "receipt", ref };
        }),
      ),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    root.close();
    const reopened = open(path).store;
    expect(reopened.readIndex()).toMatchObject({
      revision: 2,
      label: "published",
      receipt: "receipt",
    });
    expect(reopened.currentRefs()).toEqual([ref]);
    expect(reopened.readEntry(ref!)).toEqual({ saved: true });
  });

  it("skips physical orphan versions while retaining all registered versions", () => {
    const { path, store } = open();
    const first = store.commit((_current, writer) => ({
      label: "first",
      ref: writer.entry(null, () => ({ value: 1 })),
    }));
    const orphan = { entryId: first.ref!.entryId, revision: 2 };
    fs.writeFileSync(
      entryPath(path, orphan),
      JSON.stringify({ orphan: true }),
      { flag: "wx" },
    );
    const next = store.commit((_current, writer) => ({
      label: "third",
      ref: writer.entry(first.ref!, () => ({ value: 3 })),
    }));
    expect(next.ref).toEqual({ entryId: first.ref!.entryId, revision: 3 });
    expect(next.entries).toEqual({ [first.ref!.entryId]: [1, 3] });
    expect(store.currentRefs()).toEqual([next.ref]);
    expect(() => store.readEntry(orphan)).toThrowError(
      expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
    );
    expect(
      JSON.parse(fs.readFileSync(entryPath(path, orphan), "utf8")),
    ).toEqual({ orphan: true });
  });

  it("refuses to initialize an empty index over an existing entries directory", () => {
    const path = directory();
    const root = new DataRoot(path);
    roots.push(root);
    fs.mkdirSync(join(path, "memory", "entries"), { recursive: true });
    const initialize = vi.fn(() => ({ label: "reset" }));
    expect(() => new MemoryStore<State>(root, initialize)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    expect(initialize).not.toHaveBeenCalled();
    expect(fs.existsSync(indexPath(path))).toBe(false);
  });

  it("rejects unregistered references and prototype names without reading outside the registry", () => {
    const { store } = open();
    for (const entryId of [
      "00000000-0000-4000-8000-000000000000",
      "__proto__",
    ]) {
      const ref = { entryId, revision: 1 };
      expect(() => store.readEntry(ref)).toThrowError(
        expect.objectContaining({ code: "VERSION_UNAVAILABLE" }),
      );
      expect(() =>
        store.commit((_current, writer) => ({
          label: "invalid",
          ref: writer.entry(ref, () => ({})),
        })),
      ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
    }
    expect(store.readIndex().revision).toBe(1);
  });

  it("rejects all operations after its shared root is closed", () => {
    const { root, store } = open();
    root.close();
    for (const action of [
      () => store.readIndex(),
      () => store.currentRefs(),
      () => store.readEntry({ entryId: "__proto__", revision: 1 }),
      () => store.commit(() => ({ label: "new" })),
    ]) {
      expect(action).toThrowError(
        expect.objectContaining({ code: "STORAGE_FAILED" }),
      );
    }
  });

  it("reports damaged registered entry JSON without changing its index", () => {
    const { path, store } = open();
    const index = store.commit((_current, writer) => ({
      label: "saved",
      ref: writer.entry(null, () => ({ value: 42 })),
    }));
    fs.writeFileSync(entryPath(path, index.ref!), "{");
    expect(caught(() => store.readEntry(index.ref!))).toMatchObject({
      code: "STORAGE_FAILED",
      cause: expect.any(SyntaxError),
    });
    expect(store.readIndex()).toEqual(index);
  });

  it.each(["json", "schema", "unsafe-key", "unordered", "empty"])(
    "rejects %s index corruption without reinitializing it",
    (kind) => {
      const { path, root, store } = open();
      const index = store.commit((_current, writer) => ({
        label: "saved",
        ref: writer.entry(null, () => ({ value: 42 })),
      }));
      const text =
        kind === "json"
          ? "{"
          : JSON.stringify({
              ...index,
              ...(kind === "schema" ? { schemaVersion: 2 } : {}),
              ...(kind === "unsafe-key"
                ? { entries: { "../escape": [1] } }
                : {}),
              ...(kind === "unordered"
                ? { entries: { [index.ref!.entryId]: [2, 1] } }
                : {}),
              ...(kind === "empty"
                ? { entries: { [index.ref!.entryId]: [] } }
                : {}),
            });
      fs.writeFileSync(indexPath(path), text);
      const code = kind === "schema" ? "VERSION_UNAVAILABLE" : "STORAGE_FAILED";
      expect(() => store.readIndex()).toThrowError(
        expect.objectContaining({ code }),
      );
      const initialize = vi.fn(() => ({ label: "reset" }));
      expect(() => new MemoryStore<State>(root, initialize)).toThrowError(
        expect.objectContaining({ code }),
      );
      expect(initialize).not.toHaveBeenCalled();
      expect(fs.readFileSync(indexPath(path), "utf8")).toBe(text);
    },
  );

  it("recovers a visible memory index after SIGKILL immediately after rename", () => {
    const path = directory();
    const fixture = fileURLToPath(
      new URL("../fixtures/memory-store-crash.mjs", import.meta.url),
    );
    const child = spawnSync(process.execPath, [fixture, path], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    const previous = JSON.parse(child.stdout) as MemoryRef;
    expect(fs.existsSync(join(path, ".writer.lock"))).toBe(true);
    const { store } = open(path);
    const next = { entryId: previous.entryId, revision: 2 };
    expect(store.readIndex()).toMatchObject({
      label: "new",
      receipt: "committed",
      revision: 3,
    });
    expect(store.currentRefs()).toEqual([next]);
    expect(store.readEntry(previous)).toEqual({ value: "old" });
    expect(store.readEntry(next)).toEqual({ value: "new" });
  }, 15_000);
});

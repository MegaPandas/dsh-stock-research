import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContentRef,
  ProjectionWrite,
} from "../../src/contracts/storage.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { RunStore } from "../../src/runs/store.js";

const directories: string[] = [];
const roots: DataRoot[] = [];
function setup() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-projections-test-"));
  directories.push(path);
  const root = new DataRoot(path);
  roots.push(root);
  const store = new RunStore<{ label: string; ref: ContentRef }>(root);
  const run = store.create(
    { date: "2024-01-02", securityId: "US:NVDA", mode: "quick" },
    (_id, writer) => ({
      label: "canonical",
      ref: writer.input(() => ({ original: true })),
    }),
  );
  const directory = join(
    path,
    "runs",
    "2024-01-02",
    `US_NVDA-quick-${run.runId}`,
  );
  return { root, store, run, directory };
}
const report: ProjectionWrite = {
  target: { filename: "report.md" },
  content: "# Report\n",
};
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

describe("rebuildable run projections", () => {
  it("retries syncing an empty group after its last view was deleted before a sync failure", () => {
    const { store, run, directory } = setup();
    const view: ProjectionWrite = {
      target: { directory: "reports", name: "last" },
      content: "last report",
    };
    store.syncProjections(run.runId, run.revision, [view]);
    const parent = fs.statSync(join(directory, "reports"));
    const sync = fs.fsyncSync;
    const failure = new Error("empty reports directory sync failed");
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const stat = fs.fstatSync(fd);
      if (stat.dev === parent.dev && stat.ino === parent.ino) throw failure;
      sync(fd);
    });
    expect(
      caught(() => store.syncProjections(run.runId, run.revision, [])),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    expect(fs.readdirSync(join(directory, "reports"))).toEqual([]);
    expect(
      caught(() => store.syncProjections(run.runId, run.revision, [])),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    store.syncProjections(run.runId, run.revision, []);
    expect(store.read(run.runId)).toEqual(run);
  });

  it("retains identical view files and replaces changed contents without revising canonical state", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [report]);
    const path = join(directory, "report.md");
    const original = fs.statSync(path, { bigint: true }).ino;
    store.syncProjections(run.runId, run.revision, [report]);
    expect(fs.statSync(path, { bigint: true }).ino).toBe(original);
    fs.writeFileSync(path, "edited view");
    store.syncProjections(run.runId, run.revision, [report]);
    expect(fs.readFileSync(path, "utf8")).toBe(report.content);
    expect(store.read(run.runId)).toEqual(run);
  });

  it("propagates retained directory sync failure and permits recovery without replacing the file", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [report]);
    const path = join(directory, "report.md");
    const original = fs.statSync(path, { bigint: true }).ino;
    const sync = fs.fsyncSync;
    const failure = new Error("retained directory sync failed");
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() => store.syncProjections(run.runId, run.revision, [report])),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    store.syncProjections(run.runId, run.revision, [report]);
    expect(fs.statSync(path, { bigint: true }).ino).toBe(original);
    expect(store.read(run.runId)).toEqual(run);
  });

  it("writes all fixed views and encoded named views without changing canonical state", () => {
    const { store, run, directory } = setup();
    const manifest = fs.readFileSync(join(directory, "manifest.json"), "utf8");
    const inputFile = join(directory, "inputs", `${run.ref.id}.json`);
    const immutable = fs.readFileSync(inputFile, "utf8");
    const fixed = [
      "digest.md",
      "plan.md",
      "decision.draft.md",
      "decision.json",
      "report.md",
    ] as const;
    store.syncProjections(run.runId, run.revision, [
      ...fixed.map((filename) => ({
        target: { filename },
        content: `content:${filename}`,
      })),
      {
        target: { directory: "reports", name: "../../outside" },
        content: "named report",
      },
      { target: { directory: "debate", name: "bull/bear" }, content: "debate" },
    ]);
    for (const filename of fixed)
      expect(fs.readFileSync(join(directory, filename), "utf8")).toBe(
        `content:${filename}`,
      );
    expect(
      fs.readFileSync(
        join(directory, "reports", "..%2F..%2Foutside.md"),
        "utf8",
      ),
    ).toBe("named report");
    expect(
      fs.readFileSync(join(directory, "debate", "bull%2Fbear.md"), "utf8"),
    ).toBe("debate");
    expect(fs.existsSync(join(directory, "outside.md"))).toBe(false);
    expect(fs.readFileSync(join(directory, "manifest.json"), "utf8")).toBe(
      manifest,
    );
    expect(fs.readFileSync(inputFile, "utf8")).toBe(immutable);
    expect(store.read(run.runId)).toEqual(run);
    expect(store.readContent(run.runId, run.ref)).toEqual({ original: true });
  });

  it("reconciles the complete owned view set while retaining unknown files and canonical content", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [
      report,
      { target: { filename: "plan.md" }, content: "old plan" },
      { target: { directory: "reports", name: "old" }, content: "old report" },
      { target: { directory: "debate", name: "old" }, content: "old debate" },
    ]);
    fs.writeFileSync(
      join(directory, "reports", "notes.txt"),
      "unknown extension",
    );
    fs.writeFileSync(join(directory, "notes.md"), "outside owned names");
    store.syncProjections(run.runId, run.revision, [
      { target: { filename: "report.md" }, content: "replacement" },
    ]);
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "replacement",
    );
    for (const name of ["plan.md", "reports/old.md", "debate/old.md"])
      expect(fs.existsSync(join(directory, name))).toBe(false);
    expect(
      fs.readFileSync(join(directory, "reports", "notes.txt"), "utf8"),
    ).toBe("unknown extension");
    expect(fs.readFileSync(join(directory, "notes.md"), "utf8")).toBe(
      "outside owned names",
    );
    expect(store.readContent(run.runId, run.ref)).toEqual({ original: true });
  });

  it("clears all owned projections when the desired set is empty", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [
      report,
      { target: { directory: "debate", name: "view" }, content: "debate" },
    ]);
    store.syncProjections(run.runId, run.revision, []);
    expect(fs.existsSync(join(directory, "report.md"))).toBe(false);
    expect(fs.existsSync(join(directory, "debate", "view.md"))).toBe(false);
    expect(store.read(run.runId)).toEqual(run);
  });

  it("rejects a stale manifest revision before changing any existing view", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [report]);
    const next = store.commit(run.runId, (current) => ({
      label: "new canonical",
      ref: current.ref,
    }));
    const write = vi.spyOn(fs, "writeFileSync");
    expect(() =>
      store.syncProjections(run.runId, run.revision, [
        { target: { filename: "report.md" }, content: "stale view" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "VERSION_UNAVAILABLE" }));
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "# Report\n",
    );
    expect(store.read(run.runId)).toEqual(next);
  });

  it("rebuilds manually deleted views from the same committed revision", () => {
    const { store, run, directory } = setup();
    const views: ProjectionWrite[] = [
      report,
      {
        target: { directory: "reports", name: "analysis" },
        content: "analysis",
      },
    ];
    store.syncProjections(run.runId, run.revision, views);
    fs.unlinkSync(join(directory, "report.md"));
    fs.rmSync(join(directory, "reports"), { recursive: true });
    store.syncProjections(run.runId, run.revision, views);
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "# Report\n",
    );
    expect(
      fs.readFileSync(join(directory, "reports", "analysis.md"), "utf8"),
    ).toBe("analysis");
    expect(store.read(run.runId).revision).toBe(1);
  });

  it("repairs a partially published view set and removes obsolete views on retry", () => {
    const { store, run, directory } = setup();
    store.syncProjections(run.runId, run.revision, [
      { target: { filename: "plan.md" }, content: "old plan" },
    ]);
    const next = store.commit(run.runId, (current) => ({
      label: "new canonical",
      ref: current.ref,
    }));
    const views: ProjectionWrite[] = [
      report,
      {
        target: { directory: "reports", name: "new" },
        content: "new analysis",
      },
    ];
    const rename = fs.renameSync;
    let renamed = false;
    const failure = new Error("view rename failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      if (renamed) throw failure;
      rename(...args);
      renamed = true;
    });
    expect(
      caught(() => store.syncProjections(run.runId, next.revision, views)),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(store.read(run.runId)).toEqual(next);
    expect(store.readContent(run.runId, run.ref)).toEqual({ original: true });
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "# Report\n",
    );
    expect(fs.readFileSync(join(directory, "plan.md"), "utf8")).toBe(
      "old plan",
    );
    store.syncProjections(run.runId, next.revision, views);
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "# Report\n",
    );
    expect(fs.readFileSync(join(directory, "reports", "new.md"), "utf8")).toBe(
      "new analysis",
    );
    expect(fs.existsSync(join(directory, "plan.md"))).toBe(false);
  });

  it("does not roll back canonical state after a visible view rename followed by fsync failure", () => {
    const { store, run, directory } = setup();
    const rename = fs.renameSync;
    const sync = fs.fsyncSync;
    let published = false;
    const failure = new Error("view directory sync failed");
    vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args);
      published = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (published && fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    expect(
      caught(() => store.syncProjections(run.runId, run.revision, [report])),
    ).toMatchObject({ code: "STORAGE_FAILED", cause: failure });
    vi.restoreAllMocks();
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toBe(
      "# Report\n",
    );
    expect(store.read(run.runId)).toEqual(run);
    expect(store.readContent(run.runId, run.ref)).toEqual({ original: true });
    store.syncProjections(run.runId, run.revision, [report]);
    expect(store.read(run.runId).revision).toBe(1);
  });

  it("rejects projection operations after closing DataRoot", () => {
    const { root, store, run, directory } = setup();
    root.close();
    expect(() =>
      store.syncProjections(run.runId, run.revision, [report]),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    expect(fs.existsSync(join(directory, "report.md"))).toBe(false);
  });
});

import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataRoot } from "../../src/storage/data-root.js";
import { RunStore } from "../../src/runs/store.js";

interface State {
  key: string;
}
const location = {
  date: "2024-01-02",
  securityId: "US:NVDA",
  mode: "quick",
} as const;
const paths: string[] = [];
const roots: DataRoot[] = [];
function open(path = fs.mkdtempSync(join(tmpdir(), "dsh-creation-"))) {
  paths.push(path);
  const root = new DataRoot(path);
  roots.push(root);
  return { path, root, store: new RunStore<State>(root) };
}
function manifest(path: string, runId: string) {
  return join(
    path,
    "runs",
    location.date,
    `US_NVDA-quick-${runId}`,
    "manifest.json",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) root.close();
  for (const path of paths.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

describe("persistent creation lookup", () => {
  it("keeps the persistent keyed identifier stable and preserves random creates", () => {
    const { store } = open();
    expect(store.findCreation("request-a")).toBeNull();
    const run = store.create(
      location,
      () => ({ key: "request-a" }),
      "request-a",
    );
    expect(run.runId).toBe("429e0497-0b13-80ac-9bfb-8a89e264bd0c");
    expect(store.findCreation("request-a")).toBe(run.runId);
    expect(
      open().store.create(location, () => ({ key: "request-a" }), "request-a")
        .runId,
    ).toBe(run.runId);
    const randomStore = open().store;
    expect(
      randomStore.create(location, () => ({ key: "same" })).runId,
    ).not.toBe(randomStore.create(location, () => ({ key: "same" })).runId);
  });

  it("locates requests after restart without reading historical manifests", () => {
    const { path, root, store } = open();
    const first = store.create(location, () => ({ key: "first" }), "first");
    const keyed = store.create(location, () => ({ key: "new" }), "new");
    root.close();
    const read = vi.spyOn(fs, "readFileSync");
    const reopened = open(path).store;
    expect(reopened.findCreation("first")).toBe(first.runId);
    expect(reopened.findCreation("new")).toBe(keyed.runId);
    expect(reopened.findCreation("unrelated")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("retains an interrupted keyed directory across restart without blocking unrelated creation", () => {
    const { path, root, store } = open();
    expect(() =>
      store.create(
        location,
        () => {
          throw new Error("build failed");
        },
        "request-a",
      ),
    ).toThrow("build failed");
    const runId = store.findCreation("request-a")!;
    expect(() => store.read(runId)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    root.close();
    const reopened = open(path).store;
    expect(reopened.findCreation("request-a")).toBe(runId);
    expect(() =>
      reopened.create(
        { ...location, date: "2024-01-03" },
        () => ({ key: "request-a" }),
        "request-a",
      ),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_FAILED" }));
    expect(reopened.findCreation("unrelated")).toBeNull();
    expect(
      reopened.create(location, () => ({ key: "unrelated" }), "unrelated").key,
    ).toBe("unrelated");
    expect(reopened.listRunIds()).not.toContain(runId);
  });

  it("preserves missing committed manifests and checks root ownership", () => {
    const { path, root, store } = open();
    const run = store.create(
      location,
      () => ({ key: "request-a" }),
      "request-a",
    );
    fs.unlinkSync(manifest(path, run.runId));
    root.close();
    const reopened = open(path);
    expect(reopened.store.findCreation("request-a")).toBe(run.runId);
    expect(() => reopened.store.read(run.runId)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
    reopened.root.close();
    expect(() => reopened.store.findCreation("request-a")).toThrowError(
      expect.objectContaining({ code: "STORAGE_FAILED" }),
    );
  });

  it.each(["before", "after"])(
    "locates a keyed creation after SIGKILL %s manifest publication",
    (point) => {
      const path = fs.mkdtempSync(join(tmpdir(), "dsh-creation-crash-"));
      paths.push(path);
      const fixture = fileURLToPath(
        new URL("../fixtures/run-creation-crash.mjs", import.meta.url),
      );
      const child = spawnSync(process.execPath, [fixture, path, point], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBe("SIGKILL");
      const { store } = open(path);
      const runId = store.findCreation("request-a");
      expect(runId).toBe("429e0497-0b13-80ac-9bfb-8a89e264bd0c");
      if (point === "after")
        expect(store.read(runId!)).toMatchObject({
          key: "request-a",
          revision: 1,
        });
      else
        expect(() => store.read(runId!)).toThrowError(
          expect.objectContaining({ code: "STORAGE_FAILED" }),
        );
    },
  );
});

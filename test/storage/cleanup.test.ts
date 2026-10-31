import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearResearchData } from "../../src/storage/cleanup.js";
import { DataRoot } from "../../src/storage/data-root.js";

const directories: string[] = [];
function directory() {
  const path = fs.mkdtempSync(join(tmpdir(), "dsh-cleanup-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0))
    fs.rmSync(path, { recursive: true, force: true });
});

it("removes research data and preserves collection records and the lock file", () => {
  const path = directory();
  for (const name of ["runs", "memory", "drafts", "reviews", "collections"]) {
    fs.mkdirSync(join(path, name));
    fs.writeFileSync(join(path, name, "record"), name);
  }
  for (const name of [
    "cache.sqlite",
    "cache.sqlite-wal",
    "cache.sqlite-shm",
    "cache.sqlite-journal",
  ])
    fs.writeFileSync(join(path, name), "cache");
  clearResearchData(path);
  expect(fs.readdirSync(path)).toEqual([".writer.lock", "collections"]);
  expect(fs.readFileSync(join(path, "collections", "record"), "utf8")).toBe(
    "collections",
  );
  new DataRoot(path).close();
});

it("refuses cleanup while another writer owns the data root", () => {
  const path = directory();
  fs.writeFileSync(join(path, "cache.sqlite"), "cache");
  const root = new DataRoot(path);
  try {
    expect(() => clearResearchData(path)).toThrow("writer lock");
    expect(fs.readFileSync(join(path, "cache.sqlite"), "utf8")).toBe("cache");
  } finally {
    root.close();
  }
});

it("releases the writer lock when deletion fails and propagates the error", () => {
  const path = directory();
  const error = new Error("deletion failed");
  vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
    throw error;
  });
  expect(() => clearResearchData(path)).toThrow(error);
  new DataRoot(path).close();
});

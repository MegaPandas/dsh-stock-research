import fs from "node:fs";
import { join } from "node:path";
import { DataRoot } from "./data-root.js";

export function clearResearchData(path: string): void {
  const root = new DataRoot(path);
  try {
    for (const name of [
      "cache.sqlite",
      "cache.sqlite-wal",
      "cache.sqlite-shm",
      "cache.sqlite-journal",
      "runs",
      "memory",
      "drafts",
      "reviews",
    ])
      fs.rmSync(join(root.path, name), { recursive: true, force: true });
  } finally {
    root.close();
  }
}

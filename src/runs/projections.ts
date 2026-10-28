import fs from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import {
  PROJECTION_FILES,
  type ProjectionTarget,
  type ProjectionWrite,
} from "../contracts/storage.js";
import {
  createDirectory,
  publishText,
  storageIO,
  syncDirectory,
} from "../storage/files.js";

const GROUPS = ["reports", "debate"] as const;

function projectionPath(target: ProjectionTarget): string {
  return "filename" in target
    ? target.filename
    : `${target.directory}/${encodeURIComponent(target.name)}.md`;
}

function existingProjections(directory: string): string[] {
  return storageIO("Cannot enumerate convenience projections.", () => {
    const paths: string[] = [];
    for (const name of PROJECTION_FILES) {
      if (
        fs.statSync(join(directory, name), { throwIfNoEntry: false }) !==
        undefined
      )
        paths.push(name);
    }
    for (const group of GROUPS) {
      const path = join(directory, group);
      if (fs.statSync(path, { throwIfNoEntry: false }) === undefined) continue;
      for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md"))
          paths.push(`${group}/${entry.name}`);
      }
    }
    return paths;
  });
}

export function syncProjectionFiles(
  directory: string,
  projections: readonly ProjectionWrite[],
): void {
  const expected = new Set<string>();
  for (const projection of projections) {
    const relative = projectionPath(projection.target);
    expected.add(relative);
    const path = join(directory, relative);
    const parent = dirname(path);
    storageIO("Cannot prepare projection directory.", () =>
      createDirectory(parent),
    );
    const unchanged = storageIO(
      "Cannot read an existing projection.",
      () =>
        fs.statSync(path, { throwIfNoEntry: false }) !== undefined &&
        fs.readFileSync(path).equals(Buffer.from(projection.content, "utf8")),
    );
    if (!unchanged) publishText(parent, basename(path), projection.content);
  }
  for (const relative of existingProjections(directory)) {
    if (expected.has(relative)) continue;
    const path = join(directory, relative);
    storageIO(`Cannot remove obsolete projection: ${relative}`, () => {
      fs.unlinkSync(path);
    });
  }
  // A prior rename or last-file unlink can be visible before its directory is synced.
  storageIO("Cannot sync projection directories.", () => {
    syncDirectory(directory);
    for (const group of GROUPS) {
      const path = join(directory, group);
      if (fs.statSync(path, { throwIfNoEntry: false }) !== undefined)
        syncDirectory(path);
    }
  });
}

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ResearchError } from "../contracts/errors.js";

export function storageIO<T>(operation: string, action: () => T): T {
  try {
    return action();
  } catch (cause) {
    throw new ResearchError("STORAGE_FAILED", operation, { cause });
  }
}

export function withDescriptor<T>(fd: number, action: () => T): T {
  let result: T;
  try {
    result = action();
  } catch (cause) {
    const errors = [cause];
    try {
      fs.closeSync(fd);
    } catch (cleanup) {
      errors.push(cleanup);
    }
    if (errors.length > 1)
      throw new AggregateError(errors, "File operation and close failed.", {
        cause,
      });
    throw cause;
  }
  fs.closeSync(fd);
  return result;
}

export function syncDirectory(path: string): void {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  withDescriptor(fd, () => fs.fsyncSync(fd));
}

export function createDirectory(path: string): void {
  const firstCreated = fs.mkdirSync(path, { recursive: true });
  if (firstCreated === undefined) return;
  const stop = dirname(firstCreated);
  let current = path;
  while (current !== stop) {
    syncDirectory(current);
    current = dirname(current);
  }
  syncDirectory(stop);
}

export function writeExclusive(path: string, text: string): void {
  const fd = fs.openSync(path, "wx", 0o600);
  withDescriptor(fd, () => {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  });
}

export function writeImmutable(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  storageIO(`Cannot write immutable content: ${path}`, () => {
    createDirectory(dirname(path));
    writeExclusive(path, text);
    syncDirectory(dirname(path));
  });
}

export function publishJson(
  directory: string,
  filename: "manifest.json" | "index.json",
  value: unknown,
): void {
  const text = JSON.stringify(value);
  publishText(directory, filename, text);
}

export function publishText(
  directory: string,
  filename: string,
  text: string,
): void {
  storageIO(`Cannot publish ${filename}: ${directory}`, () => {
    const temporary = join(directory, `.${filename}-${randomUUID()}.tmp`);
    writeExclusive(temporary, text);
    fs.renameSync(temporary, join(directory, filename));
    // Once renamed, the new state may be visible even if this sync fails.
    syncDirectory(directory);
  });
}

export function nextRevision(directory: string, previous: number): number {
  return storageIO(`Cannot allocate a revision: ${directory}`, () => {
    fs.statSync(join(directory, `${previous}.json`));
    let maximum = 0;
    for (const name of fs.readdirSync(directory)) {
      const match = /^([1-9]\d*)\.json$/.exec(name);
      if (match === null) continue;
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision))
        throw new Error("Invalid physical revision.");
      maximum = Math.max(maximum, revision);
    }
    const revision = maximum + 1;
    if (!Number.isSafeInteger(revision))
      throw new Error("Physical revision exhausted.");
    return revision;
  });
}

export function readJson(path: string): unknown {
  return storageIO(`Cannot read stored JSON: ${path}`, () =>
    JSON.parse(fs.readFileSync(path, "utf8")),
  );
}

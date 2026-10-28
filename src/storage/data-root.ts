import fs from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { ResearchError } from "../contracts/errors.js";
import {
  createDirectory,
  storageIO,
  syncDirectory,
  withDescriptor,
} from "./files.js";

export class DataRoot {
  readonly path: string;
  readonly #lockPath: string;
  #closed = false;

  constructor(path: string) {
    this.path = resolve(path);
    this.#lockPath = join(this.path, ".writer.lock");
    storageIO(`Cannot acquire data-root writer lock: ${this.path}`, () => {
      createDirectory(this.path);
      const fd = fs.openSync(this.#lockPath, "wx", 0o600);
      try {
        withDescriptor(fd, () => {
          fs.writeFileSync(
            fd,
            JSON.stringify({
              pid: process.pid,
              hostname: hostname(),
              acquiredAt: new Date().toISOString(),
            }),
            "utf8",
          );
          fs.fsyncSync(fd);
        });
        syncDirectory(this.path);
      } catch (cause) {
        const errors = [cause];
        try {
          fs.unlinkSync(this.#lockPath);
          syncDirectory(this.path);
        } catch (cleanup) {
          errors.push(cleanup);
        }
        throw errors.length === 1
          ? cause
          : new AggregateError(
              errors,
              "Writer-lock initialization and cleanup failed.",
              { cause },
            );
      }
    });
  }

  assertOpen(): void {
    if (this.#closed)
      throw new ResearchError("STORAGE_FAILED", "Data-root writer is closed.");
  }

  close(): void {
    if (this.#closed) return;
    storageIO(`Cannot release data-root writer lock: ${this.path}`, () => {
      fs.unlinkSync(this.#lockPath);
      this.#closed = true;
      syncDirectory(this.path);
    });
  }
}

import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchError } from "../contracts/errors.js";
import { createDirectory, storageIO } from "./files.js";

export class DataRoot {
  readonly path: string;
  readonly #lock: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.path = resolve(path);
    this.#lock = storageIO(
      `Cannot acquire data-root writer lock: ${this.path}`,
      () => {
        createDirectory(this.path);
        const lock = new DatabaseSync(join(this.path, ".writer.lock"), {
          timeout: 0,
        });
        try {
          // Keep the inode: unlinking it would let another writer lock a different file.
          // SQLite's OS lock is released by close or process death, including SIGKILL.
          // IMMEDIATE reserves the single writer without upgrading past other
          // contenders' transient read locks, which could make both starts fail.
          lock.exec("BEGIN IMMEDIATE");
          return lock;
        } catch (cause) {
          const errors = [cause];
          try {
            lock.close();
          } catch (cleanup) {
            errors.push(cleanup);
          }
          if (errors.length > 1)
            throw new AggregateError(
              errors,
              "Writer-lock acquisition and cleanup failed.",
              { cause },
            );
          throw cause;
        }
      },
    );
  }

  assertOpen(): void {
    if (this.#closed)
      throw new ResearchError("STORAGE_FAILED", "Data-root writer is closed.");
  }

  close(): void {
    if (this.#closed) return;
    storageIO(`Cannot release data-root writer lock: ${this.path}`, () => {
      this.#lock.close();
      this.#closed = true;
    });
  }
}

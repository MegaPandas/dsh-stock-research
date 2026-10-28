import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { QueryCacheKey } from "../contracts/cache.js";
import type { DataEnvelope } from "../contracts/data.js";
import { ResearchError } from "../contracts/errors.js";
import { serializeJson } from "./json.js";

export function createCacheKey(key: QueryCacheKey): string {
  return serializeJson(key);
}

export class SqliteCache {
  readonly #database: DatabaseSync;
  readonly #maxEntries: number;
  readonly #read: StatementSync;
  readonly #write: StatementSync;
  readonly #deleteExpired: StatementSync;
  readonly #evict: StatementSync;

  constructor(options: { path: string; maxEntries: number }) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new ResearchError(
        "INVALID_INPUT",
        "Cache maxEntries must be a positive safe integer",
      );
    }
    const database = new DatabaseSync(options.path);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS cache_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cache_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          expires_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cache_expires ON cache_entries (expires_at);
      `);
      this.#read = database.prepare(
        "SELECT payload FROM cache_entries WHERE cache_key = ? AND expires_at > ?",
      );
      this.#write = database.prepare(
        "INSERT OR REPLACE INTO cache_entries (cache_key, payload, expires_at) VALUES (?, ?, ?)",
      );
      this.#deleteExpired = database.prepare(
        "DELETE FROM cache_entries WHERE expires_at <= ?",
      );
      this.#evict = database.prepare(`
        DELETE FROM cache_entries WHERE id IN (
          SELECT id FROM cache_entries ORDER BY id
          LIMIT (SELECT max(count(*) - ?, 0) FROM cache_entries)
        )
      `);
      database.exec("BEGIN IMMEDIATE");
      this.#deleteExpired.run(Date.now());
      this.#evict.run(options.maxEntries);
      database.exec("COMMIT");
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    this.#maxEntries = options.maxEntries;
  }

  get<T>(key: QueryCacheKey): DataEnvelope<T> | undefined {
    this.#assertOpen();
    const row = this.#read.get(createCacheKey(key), Date.now());
    return row === undefined
      ? undefined
      : (JSON.parse(row.payload as string) as DataEnvelope<T>);
  }

  set<T>(key: QueryCacheKey, envelope: DataEnvelope<T>, ttlMs: number): void {
    this.#assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new ResearchError(
        "INVALID_INPUT",
        "Cache TTL must be a finite nonnegative duration",
      );
    }
    const cacheKey = createCacheKey(key);
    const payload = serializeJson(envelope);
    const now = Date.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#write.run(cacheKey, payload, now + ttlMs);
      this.#deleteExpired.run(now);
      this.#evict.run(this.#maxEntries);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Cache write and rollback failed",
            {
              cause: rollbackError,
            },
          );
        }
      }
      throw error;
    }
  }

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }

  #assertOpen(): void {
    if (!this.#database.isOpen) {
      throw new ResearchError("STORAGE_FAILED", "Cache is closed");
    }
  }
}

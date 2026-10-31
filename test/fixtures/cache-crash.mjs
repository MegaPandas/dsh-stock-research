import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { SqliteCache } from "@megapandas/dsh-stock-research/core";

const cache = new SqliteCache({ path: process.argv[2], maxEntries: 2 });
const point = process.argv[3];
const key = JSON.parse(process.argv[4]);
const original = JSON.parse(process.argv[5]);
const updated = JSON.parse(process.argv[6]);
cache.set(key, original, 60_000);

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === "COMMIT" && point === "before-commit")
    process.kill(process.pid, "SIGKILL");
  const result = exec.call(this, sql);
  if (sql === "COMMIT" && point === "after-commit")
    process.kill(process.pid, "SIGKILL");
  return result;
};
cache.set(key, updated, 60_000);

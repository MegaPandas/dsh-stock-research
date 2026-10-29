import process from "node:process";
import { DataRoot } from "@megapandas/dsh-stock-research/core";
try {
  const root = new DataRoot(process.argv[2]);
  root.close();
  process.stdout.write("acquired");
} catch (error) {
  if (error.code !== "STORAGE_FAILED") throw error;
  process.stdout.write("blocked");
}

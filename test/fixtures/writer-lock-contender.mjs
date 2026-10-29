import process from "node:process";
import { DataRoot } from "@megapandas/dsh-stock-research/core";
let root;
process.on("message", (message) => {
  if (message === "start") {
    try {
      root = new DataRoot(process.argv[2]);
      process.send("acquired");
    } catch (error) {
      if (error.code !== "STORAGE_FAILED") throw error;
      process.send("blocked");
    }
  } else if (message === "release") {
    root?.close();
    process.disconnect();
  }
});
process.send("ready");

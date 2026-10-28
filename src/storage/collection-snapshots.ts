import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CollectionRecord } from "../contracts/collection.js";
import type { DataRoot } from "./data-root.js";
import { createDirectory, publishText, storageIO } from "./files.js";

export class CollectionSnapshotStore {
  constructor(private readonly root: DataRoot) {}

  save(record: CollectionRecord): string {
    this.root.assertOpen();
    const directory = join(this.root.path, "collections");
    const filename = `${randomUUID()}.json`;
    const path = join(directory, filename);
    return storageIO(`Cannot save collection snapshot: ${path}`, () => {
      const text = JSON.stringify(record);
      createDirectory(directory);
      publishText(directory, filename, text);
      return path;
    });
  }
}

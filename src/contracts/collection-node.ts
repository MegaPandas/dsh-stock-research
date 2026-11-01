import type { CollectionDataset, CollectionNode } from "./collection.js";

/** Fixed data groups follow the consumers' table boundaries, including benchmarks. */
export function collectionNodeForTable(
  id: string,
  dataset: CollectionDataset,
): CollectionNode {
  if (id === "market.daily") return "required";
  if (
    dataset === "market" &&
    id.startsWith("benchmark.") &&
    !/^benchmark\.(shanghai|shenzhen|csi300|chinext)\./.test(id)
  )
    return "macro";
  return dataset;
}

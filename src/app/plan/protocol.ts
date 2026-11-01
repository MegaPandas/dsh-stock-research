import type { QuerySnapshot } from "../../contracts/query.js";
import type { CollectionNode } from "../../contracts/collection.js";

export const ANALYST_COLLECTION_NODES: Readonly<
  Record<string, Exclude<CollectionNode, "required">>
> = {
  "analysis.market": "market",
  "analysis.sentiment": "market",
  "analysis.fundamentals": "fundamentals",
  "analysis.business": "fundamentals",
  "analysis.macro": "macro",
  "analysis.geopolitics": "macro",
};

export const APPLICATION_INPUT_NAME = "stock-research:application";
export const QUICK_SNAPSHOTS_INPUT = "stock-research:queries";

export interface QuickQuerySnapshot extends QuerySnapshot {
  taskId: string;
}

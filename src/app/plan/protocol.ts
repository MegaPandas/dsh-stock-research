import type { QuerySnapshot } from "../../contracts/query.js";

export const APPLICATION_INPUT_NAME = "stock-research:application";
export const QUICK_SNAPSHOTS_INPUT = "stock-research:queries";

export interface QuickQuerySnapshot extends QuerySnapshot {
  taskId: string;
}

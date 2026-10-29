import type { SqliteCache } from "../cache/index.js";
import type {
  CollectedTableData,
  CollectionOptions,
  CollectionTask,
} from "../contracts/collection.js";
import type { DataEnvelope, ResearchScope } from "../contracts/data.js";
import { COLLECTION_VERSION } from "../data/versions.js";
import { applyCollectionFreshness } from "./collection-freshness.js";

const CHINA_REUSABLE_TABLES = new Set([
  "market.daily",
  "market.weekly",
  "market.monthly",
  "market.averages",
  "valuation.history",
  "financial.indicators",
  "financial.quarter",
  "financial.income",
  "financial.balance",
  "financial.cashflow",
  "macro.gdp",
  "macro.cpi",
  "macro.ppi",
  "macro.pmi",
  "macro.moneySupply",
  "macro.lpr",
  "macro.industrial",
  "macro.retail",
  "macro.investment",
  "macro.trade",
  "macro.socialFinancing",
  "benchmark.bondYields",
  ...[
    "shanghai",
    "shenzhen",
    "csi300",
    "chinext",
    "gold",
    "dxy",
    "usdcny",
    "usdcnh",
    "eurusd",
    "usdjpy",
  ].flatMap((asset) =>
    ["daily", "weekly", "monthly"].map(
      (interval) => `benchmark.${asset}.${interval}`,
    ),
  ),
]);

// Completed CN observations can be shared within these inclusion boundaries.
// Live quotes and US sources retain exact cutoffs.
function cacheWindow(
  scope: ResearchScope,
  task: CollectionTask,
): string | undefined {
  if (scope.security.market !== "CN" || !CHINA_REUSABLE_TABLES.has(task.id))
    return undefined;
  const day = scope.cutoff.slice(0, 10);
  return [
    "00:00:00.000",
    "07:00:00.000",
    "07:30:00.000",
    "15:59:59.999",
    "16:00:00.000",
    "23:59:59.999",
  ]
    .map((time) => `${day}T${time}Z`)
    .filter((time) => time <= scope.cutoff)
    .at(-1)!;
}

export class CollectionCache {
  constructor(
    private readonly cache: SqliteCache,
    private readonly options: Pick<CollectionOptions, "freshness" | "ttl">,
  ) {}

  read(
    scope: ResearchScope,
    task: CollectionTask,
  ): DataEnvelope<CollectedTableData> | undefined {
    const cached = this.cache.get<CollectedTableData>(this.key(scope, task));
    if (cached === undefined || cached.cutoff > scope.cutoff) return undefined;
    cached.cutoff = scope.cutoff;
    cached.ageMs = Date.parse(scope.cutoff) - Date.parse(cached.asOf);
    applyCollectionFreshness(scope, cached, this.freshness(task));
    return cached;
  }

  write(
    scope: ResearchScope,
    task: CollectionTask,
    envelope: DataEnvelope<CollectedTableData>,
  ): void {
    this.cache.set(
      this.key(scope, task),
      envelope,
      this.options.ttl[task.dataset],
    );
  }

  refresh(
    scope: ResearchScope,
    task: CollectionTask,
    envelope: DataEnvelope<CollectedTableData>,
  ): void {
    applyCollectionFreshness(scope, envelope, this.freshness(task));
  }

  private freshness(task: CollectionTask): number {
    return this.options.freshness[
      task.id === "valuation.history" ? "market" : task.dataset
    ];
  }

  private key(scope: ResearchScope, task: CollectionTask) {
    const window = cacheWindow(scope, task);
    return {
      provider: task.provider,
      dataset: task.dataset,
      securityId:
        window !== undefined &&
        (task.id.startsWith("macro.") || task.id.startsWith("benchmark."))
          ? "CN:shared"
          : scope.security.id,
      cutoff: window ?? scope.cutoff,
      parameters: {
        table: task.id,
        date: scope.date,
        freshness: this.freshness(task),
        ...(window === undefined ? {} : { cacheWindow: "cn-segment-v1" }),
      },
      adapterVersion: COLLECTION_VERSION,
      normalizationVersion: COLLECTION_VERSION,
    };
  }
}

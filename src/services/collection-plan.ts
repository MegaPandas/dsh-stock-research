import type {
  CollectionFailure,
  CollectionOptions,
  CollectionPlan,
  CollectionTask,
} from "../contracts/collection.js";
import type { ResearchScope } from "../contracts/data.js";
import { createChinaMarketTasks } from "../data/collection-market.js";
import { createChinaFinancialTasks } from "../data/collection-financials.js";
import { createChinaMacroTasks } from "../data/collection-macro.js";
import { createBenchmarkMarketTasks } from "../data/collection-benchmarks.js";
import { createBenchmarkBondTasks } from "../data/collection-bonds.js";
import type { HttpClient } from "../data/http.js";
import { XueqiuClient } from "../data/xueqiu.js";
import { createUsCollectionTasks } from "./collection-us.js";
import type { QueryService } from "./query.js";

const REQUIRED_DATA_TIMEOUT_MS = 45_000;
const TABLE_TIMEOUT_MS = 120_000;

/** Compile source capabilities before execution; source order defines preference. */
export function createCollectionPlans(
  http: HttpClient,
  queries: Pick<QueryService, "query">,
  scope: ResearchScope,
  options: CollectionOptions,
): { plans: CollectionPlan[]; disabled: CollectionFailure[] } {
  const enabled = new Set(options.enabledSources);
  let sources: CollectionTask[];
  if (scope.security.market === "CN") {
    const xueqiu = enabled.has("xueqiu")
      ? new XueqiuClient(http.forSource("xueqiu"), options.xueqiuCookie!)
      : undefined;
    sources = [
      ...createChinaMarketTasks(http, scope, xueqiu),
      ...createChinaFinancialTasks(http.forSource("eastmoney"), scope, xueqiu),
      ...createChinaMacroTasks(http, scope),
      ...createBenchmarkMarketTasks(http, scope, xueqiu),
      ...createBenchmarkBondTasks(http.forSource("eastmoney"), scope),
    ];
  } else {
    sources = createUsCollectionTasks(queries, scope, options);
  }
  const tables = new Map<string, CollectionTask[]>();
  for (const source of sources) {
    const candidates = tables.get(source.id);
    if (candidates) candidates.push(source);
    else tables.set(source.id, [source]);
  }
  const plans: CollectionPlan[] = [];
  const disabled: CollectionFailure[] = [];
  for (const [id, sources] of tables) {
    const candidates = sources.filter((source) =>
      source.enabledBy.every((key) => enabled.has(key)),
    );
    if (candidates.length === 0) {
      disabled.push({
        id,
        provider: sources[0]!.provider,
        code: "SOURCE_UNAVAILABLE",
        detail: "This dataset's sources are not enabled in the deployment.",
      });
      continue;
    }
    const required =
      options.requireDailyMarket === true && id === "market.daily";
    plans.push({
      id,
      dataset: candidates[0]!.dataset,
      candidates,
      required,
      timeoutMs: required ? REQUIRED_DATA_TIMEOUT_MS : TABLE_TIMEOUT_MS,
    });
  }
  return { plans, disabled };
}

import type {
  CollectionSourceConfig,
  CollectionTaskFactory,
} from "../contracts/collection.js";
import type { ReadSource } from "../contracts/query.js";
import { createChinaMarketTasks } from "./collection-market.js";
import { createChinaFinancialTasks } from "./collection-financials.js";
import { createChinaMacroTasks } from "./collection-macro.js";
import { createBenchmarkMarketTasks } from "./collection-benchmarks.js";
import { createBenchmarkBondTasks } from "./collection-bonds.js";
import { createUsCollectionTasks } from "./collection-us.js";
import type { HttpClient } from "./http.js";
import { XueqiuClient } from "./xueqiu.js";

export function createCollectionTaskFactory(
  http: HttpClient,
  readSource: ReadSource,
  config: CollectionSourceConfig,
): CollectionTaskFactory {
  const captured = structuredClone(config);
  return (scope, options) => {
    if (scope.security.market !== "CN")
      return createUsCollectionTasks(
        readSource,
        scope,
        options,
        captured.secCiks,
      );
    const xueqiu = options.enabledSources.includes("xueqiu")
      ? new XueqiuClient(http.forSource("xueqiu"), captured.xueqiuCookie!)
      : undefined;
    return [
      ...createChinaMarketTasks(http, scope, xueqiu),
      ...createChinaFinancialTasks(http.forSource("eastmoney"), scope, xueqiu),
      ...createChinaMacroTasks(http, scope),
      ...createBenchmarkMarketTasks(http, scope, xueqiu),
      ...createBenchmarkBondTasks(http.forSource("eastmoney"), scope),
    ];
  };
}

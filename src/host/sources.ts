import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-web";
import { ResearchError } from "../contracts/errors.js";
import { YahooMarketAdapter } from "../data/yahoo-market.js";
import { EastmoneyMarketAdapter } from "../data/eastmoney-market.js";
import { TencentMarketAdapter } from "../data/tencent-market.js";
import { SecConceptAdapter } from "../data/sec-concept.js";
import { EastmoneyIncomeAdapter } from "../data/eastmoney-income.js";
import { SinaIncomeAdapter } from "../data/sina-income.js";
import { FredCsvAdapter } from "../data/fred-csv.js";
import { HostResearchAdapter } from "../data/host-research.js";
import type { HttpClient } from "../data/http.js";
import type { QuerySources } from "../services/query-sources.js";
import type { ResearchConfig } from "./config.js";

export function createSources(
  ctx: Context,
  http: HttpClient,
  config: ResearchConfig,
): QuerySources {
  const sources: QuerySources = {};
  const enabled = new Set(config.enabledSources);
  if (enabled.has("yahoo"))
    sources.yahoo = new YahooMarketAdapter(http.forSource("yahoo"));
  if (enabled.has("eastmoney-market"))
    sources.eastmoneyMarket = new EastmoneyMarketAdapter(
      http.forSource("eastmoney"),
    );
  if (enabled.has("tencent"))
    sources.tencent = new TencentMarketAdapter(http.forSource("tencent"));
  if (enabled.has("sec"))
    sources.sec = new SecConceptAdapter(
      http.forSource("sec"),
      config.secUserAgent!,
    );
  if (enabled.has("eastmoney-income"))
    sources.eastmoneyIncome = new EastmoneyIncomeAdapter(
      http.forSource("eastmoney"),
    );
  if (enabled.has("sina"))
    sources.sina = new SinaIncomeAdapter(http.forSource("sina"));
  if (enabled.has("fred"))
    sources.fred = new FredCsvAdapter(http.forSource("fred"));
  if (enabled.has("dsh-web")) {
    const web = ctx.get("web");
    if (web === undefined)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "The enabled dsh-web source requires the host web service.",
      );
    sources.research = new HostResearchAdapter((request, signal) =>
      web.search(request, signal),
    );
  }
  return sources;
}

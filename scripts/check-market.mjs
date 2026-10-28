import console from "node:console";
import process from "node:process";
import {
  EastmoneyMarketAdapter,
  HttpClient,
  TencentMarketAdapter,
  YahooMarketAdapter,
} from "dsh-stock-research/core";

const sources = new Map([
  ["yahoo", YahooMarketAdapter],
  ["eastmoney", EastmoneyMarketAdapter],
  ["tencent", TencentMarketAdapter],
]);
const Adapter = sources.get(process.argv[2]);
if (!Adapter || process.argv.length !== 3) {
  console.error("Usage: npm run check:market -- <yahoo|eastmoney|tencent>");
  process.exitCode = 2;
} else {
  const http = new HttpClient({
    timeoutMs: 20_000,
    maxConcurrency: 1,
    minIntervalMs: 2_000,
  });
  const security =
    Adapter === YahooMarketAdapter
      ? {
          id: "US:NVDA",
          market: "US",
          symbol: "NVDA",
          exchange: "NASDAQ",
          currency: "USD",
          timeZone: "America/New_York",
        }
      : {
          id: "CN:600519.SH",
          market: "CN",
          symbol: "600519.SH",
          exchange: "SH",
          currency: "CNY",
          timeZone: "Asia/Shanghai",
        };
  try {
    const result = await new Adapter(http).query({
      scope: {
        security,
        date: "2024-01-02",
        cutoff: "2024-01-02T23:00:00.000Z",
      },
      startDate: "2024-01-02",
      maxAgeMs: 86_400_000,
    });
    console.log(
      JSON.stringify({
        provider: result.source.provider,
        bars: result.data.bars,
        retrievedAt: result.retrievedAt,
        historicalKnowledge: result.historicalKnowledge,
      }),
    );
  } finally {
    await http.close();
  }
}

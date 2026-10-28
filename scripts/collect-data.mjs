import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import console from "node:console";
import {
  CollectionService,
  DataRoot,
  HttpClient,
  QueryService,
  RunService,
  RunStore,
  SqliteCache,
  parseLocalDate,
} from "@megapandas/dsh-stock-research/core";

const [securityInput, dateInput, destination] = process.argv.slice(2);
if (process.argv.length !== 5 || destination === undefined) {
  console.error(
    "Usage: npm run collect:data -- <SZ.002594|SH.600519> <YYYY-MM-DD> <new-output-directory>",
  );
  process.exit(2);
}
const match = /^(SH|SZ)[.:](\d{6})$/.exec(securityInput);
if (match === null) throw new Error("Use an explicit SH/SZ A-share code.");
const date = parseLocalDate(dateInput);
const startedAt = new Date();
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
}).format(startedAt);
if (date > today) throw new Error("Research dates cannot be in the future.");
const security = {
  id: `CN:${match[2]}.${match[1]}`,
  market: "CN",
  symbol: `${match[2]}.${match[1]}`,
  exchange: match[1],
  currency: "CNY",
  timeZone: "Asia/Shanghai",
};
const scope = {
  security,
  date,
  cutoff: new Date(
    Math.min(startedAt.getTime(), Date.parse(`${date}T23:59:59.999+08:00`)),
  ).toISOString(),
};
mkdirSync(destination);
mkdirSync(join(destination, "requests"));
const scratch = mkdtempSync(join(tmpdir(), "stock-collection-cache-"));
const root = new DataRoot(scratch);
const cache = new SqliteCache({
  path: join(scratch, "cache.sqlite"),
  maxEntries: 100,
});
const http = new HttpClient({
  timeoutMs: 15000,
  maxConcurrency: 1,
  minIntervalMs: 2000,
});
const ttl = {
  market: 3600000,
  fundamentals: 86400000,
  macro: 86400000,
  research: 0,
};
const runs = new RunService(new RunStore(root), () => new Date().toISOString());
const queries = new QueryService({}, cache, runs, ttl);
const collector = new CollectionService(http, cache, queries, {
  enabledSources: [
    "eastmoney-market",
    "tencent",
    "eastmoney-income",
    "sina",
    "china-macro",
    "benchmarks",
  ],
  freshness: {
    market: 86400000,
    fundamentals: 200 * 86400000,
    macro: 45 * 86400000,
  },
  secCiks: {},
  ttl,
});
const requests = [];
const save = (name, value) =>
  writeFileSync(
    join(destination, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
const recordedClients = new WeakSet();
function recordRequests(client) {
  if (recordedClients.has(client)) return client;
  recordedClients.add(client);
  for (const [name, method] of [
    ["getText", "GET"],
    ["postText", "POST"],
  ]) {
    const request = client[name].bind(client);
    client[name] = async (url, options) => {
      const entry = {
        index: requests.length + 1,
        method,
        url: String(url),
        startedAt: new Date().toISOString(),
      };
      requests.push(entry);
      try {
        const raw = await request(url, options);
        entry.file = `requests/${entry.index}.txt`;
        writeFileSync(join(destination, entry.file), raw, { mode: 0o600 });
        entry.outcome = "received";
        return raw;
      } catch (error) {
        entry.outcome = "failed";
        entry.code = error.code ?? error.name;
        throw error;
      } finally {
        entry.completedAt = new Date().toISOString();
        save("requests.json", requests);
      }
    };
  }
  return client;
}
recordRequests(http);
const forSource = http.forSource.bind(http);
http.forSource = (source) => recordRequests(forSource(source));
const csvValue = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
try {
  const snapshot = await collector.collect(scope);
  collector.finalizeScope(snapshot, {
    ...scope,
    cutoff: new Date(
      Math.min(Date.now(), Date.parse(`${date}T23:59:59.999+08:00`)),
    ).toISOString(),
  });
  save("snapshot.json", snapshot);
  for (const packet of snapshot.packets) {
    save(`${packet.id}.json`, packet.envelope);
    const columns = Object.keys(packet.envelope.data.columns);
    const rows = packet.envelope.data.rows;
    const csv = [
      ["date", "asOf", "publishedDate", ...columns],
      ...rows.map((row) => [
        row.date,
        row.asOf,
        row.publishedDate,
        ...columns.map((key) => row.values[key]),
      ]),
    ]
      .map((row) => row.map(csvValue).join(","))
      .join("\n");
    writeFileSync(join(destination, `${packet.id}.csv`), `${csv}\n`, {
      mode: 0o600,
    });
  }
  const summary = {
    security: security.id,
    modelCalls: 0,
    networkRequests: requests.length,
    tables: snapshot.packets.map(({ id, envelope }) => ({
      id,
      title: envelope.data.title,
      provider: envelope.source.provider,
      records: envelope.data.rows.length,
      first: envelope.data.rows[0].date,
      last: envelope.data.rows.at(-1).date,
      stale: envelope.stale,
      columns: envelope.data.columns,
      latest: envelope.data.rows.at(-1).values,
      gaps: envelope.gaps,
    })),
    failures: snapshot.failures,
  };
  save("summary.json", summary);
  console.log(
    JSON.stringify(
      {
        output: destination,
        requests: requests.length,
        tables: summary.tables.map(({ id, records, first, last, stale }) => ({
          id,
          records,
          first,
          last,
          stale,
        })),
        failures: summary.failures,
      },
      null,
      2,
    ),
  );
} finally {
  await collector.close();
  await queries.close();
  await http.close();
  cache.close();
  root.close();
  rmSync(scratch, { recursive: true });
}

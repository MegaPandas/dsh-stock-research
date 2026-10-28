import assert from "node:assert/strict";
import console from "node:console";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import {
  EastmoneyMarketAdapter,
  HttpClient,
  parseLocalDate,
} from "dsh-stock-research/core";

const [inputDate, outputPath] = process.argv.slice(2);
if (process.argv.length !== 4) {
  console.error(
    "Usage: npm run check:eastmoney -- <YYYY-MM-DD> <new-output.json>",
  );
  process.exit(2);
}
const date = parseLocalDate(inputDate);
const query = {
  scope: {
    security: {
      id: "CN:002594.SZ",
      market: "CN",
      symbol: "002594.SZ",
      exchange: "SZ",
      currency: "CNY",
      timeZone: "Asia/Shanghai",
    },
    date,
    cutoff: new Date(`${date}T23:59:59.999+08:00`).toISOString(),
  },
  startDate: date,
  maxAgeMs: 86_400_000,
};
const record = {
  case: "live BYD Eastmoney single daily bar",
  target: "SZ.002594",
  startedAt: new Date().toISOString(),
  query,
  network: {
    mode: "node-native-fetch",
    environmentProxyEnabled:
      process.execArgv.includes("--use-env-proxy") ||
      process.env.NODE_USE_ENV_PROXY === "1",
    proxyConfigured: Boolean(
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy,
    ),
    noProxyConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
  },
  outcome: "pending",
  stage: "request",
  sourceCalls: 0,
  fetchCalls: 0,
  status: null,
  url: null,
  rawResponse: null,
  envelope: null,
};

// Keep structured diagnostics; arbitrary transport messages can contain proxy URLs.
function failureChain(error) {
  const chain = [];
  const seen = new Set();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const entry = {};
    for (const key of ["name", "code", "syscall"])
      if (typeof error[key] === "string" && /^[A-Za-z0-9_]+$/.test(error[key]))
        entry[key] = error[key];
    chain.push(entry);
    error = error.cause;
  }
  return chain;
}

const started = performance.now();
const http = new HttpClient({
  timeoutMs: 20_000,
  maxConcurrency: 1,
  minIntervalMs: 2_000,
});
const getText = http.getText.bind(http);
const nativeFetch = globalThis.fetch;
http.getText = async (url, options) => {
  record.sourceCalls++;
  assert.equal(record.sourceCalls, 1);
  const address = new URL(url);
  assert.equal(address.origin, "https://push2his.eastmoney.com");
  assert.equal(address.pathname, "/api/qt/stock/kline/get");
  for (const [name, value] of Object.entries({
    secid: "0.002594",
    klt: "101",
    fqt: "0",
    beg: date.replaceAll("-", ""),
    end: date.replaceAll("-", ""),
    fields1: "f1,f2",
    fields2: "f51,f52,f53,f54,f55,f56",
    lmt: "1",
  }))
    assert.equal(address.searchParams.get(name), value);
  record.url = address.href;
  const text = await getText(url, options);
  record.rawResponse = text;
  return text;
};
let output;
try {
  output = openSync(outputPath, "wx", 0o600);
  globalThis.fetch = async (...args) => {
    record.fetchCalls++;
    assert.equal(record.fetchCalls, 1);
    const response = await nativeFetch(...args);
    record.status = response.status;
    return response;
  };
  const envelope = await new EastmoneyMarketAdapter(http).query(query);
  record.envelope = envelope;
  record.stage = "acceptance";
  assert.equal(record.sourceCalls, 1);
  assert.equal(record.fetchCalls, 1);
  assert.equal(record.status, 200);
  const raw = JSON.parse(record.rawResponse);
  assert.equal(raw.rc, 0);
  assert.equal(raw.data.code, "002594");
  assert.equal(raw.data.market, 0);
  assert.equal(raw.data.klines.length, 1);
  const columns = raw.data.klines[0].split(",");
  assert.equal(columns[0], date);
  assert.match(columns[5], /^\d+(?:\.\d+)?$/);
  assert.equal(envelope.source.provider, "eastmoney");
  assert.equal(envelope.source.adapterVersion, "2");
  assert.equal(envelope.source.url, record.url);
  assert.equal(envelope.data.currency, "CNY");
  assert.equal(envelope.data.adjustment, "unadjusted");
  assert.equal(envelope.data.bars.length, 1);
  const bar = envelope.data.bars[0];
  assert.equal(bar.date, date);
  for (const field of ["open", "high", "low", "close", "volume"])
    assert.ok(Number.isFinite(bar[field]));
  assert.equal(bar.volume, Number(columns[5]) * 100);
  assert.equal(bar.availableAt, null);
  assert.equal(envelope.availableAt, null);
  assert.equal(envelope.historicalKnowledge, "unverified");
  assert.ok(envelope.gaps.some((gap) => gap.code === "unverified_time"));
  record.outcome = "passed";
} catch (cause) {
  record.outcome = "failed";
  record.failure = failureChain(cause);
  process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
  try {
    await http.close();
  } finally {
    record.durationMs = performance.now() - started;
    if (output !== undefined) {
      try {
        writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
      } finally {
        closeSync(output);
      }
    }
  }
}
console.log(
  JSON.stringify({
    target: record.target,
    outcome: record.outcome,
    stage: record.stage,
    sourceCalls: record.sourceCalls,
    fetchCalls: record.fetchCalls,
    status: record.status,
    failure: record.failure,
    durationMs: record.durationMs,
  }),
);

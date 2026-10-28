import assert from "node:assert/strict";
import console from "node:console";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL } from "node:url";
import {
  HttpClient,
  parseLocalDate,
  SinaIncomeAdapter,
} from "dsh-stock-research/core";

const [inputDate, outputPath] = process.argv.slice(2);
if (inputDate === undefined || outputPath === undefined) {
  console.error(
    "Usage: npm run check:byd-income -- <research-date> <new-output.json>",
  );
  process.exit(2);
}
const date = parseLocalDate(inputDate);
const startedAt = new Date();
const cutoff = new Date(
  Math.min(startedAt.getTime(), Date.parse(`${date}T23:59:59.999+08:00`)),
).toISOString();
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
    cutoff,
  },
  fields: ["revenue", "netIncomeToParent"],
  // Use the shipped bundle's existing fundamentals freshness policy.
  maxAgeMs: 200 * 86_400_000,
};
const record = {
  case: "live BYD latest Sina income",
  target: "SZ.002594",
  startedAt: startedAt.toISOString(),
  query,
  outcome: "pending",
  stage: "request",
  sourceCalls: 0,
  url: null,
  rawResponse: null,
  envelope: null,
};
const started = performance.now();
const http = new HttpClient({
  timeoutMs: 20_000,
  maxConcurrency: 1,
  minIntervalMs: 2000,
});
const getText = http.getText.bind(http);
http.getText = async (url, options) => {
  record.sourceCalls++;
  assert.equal(
    record.sourceCalls,
    1,
    "Only one necessary report request is authorized.",
  );
  const address = new URL(url);
  record.url = address.href;
  for (const [name, value] of Object.entries({
    paperCode: "sz002594",
    source: "lrb",
    type: "0",
    page: "1",
    num: "1",
  }))
    assert.equal(address.searchParams.get(name), value);
  const text = await getText(url, options);
  record.rawResponse = text;
  return text;
};
let output;
try {
  output = openSync(outputPath, "wx", 0o600);
  const envelope = await new SinaIncomeAdapter(http).query(query);
  record.envelope = envelope;
  record.stage = "acceptance";
  assert.equal(record.sourceCalls, 1);
  assert.equal(envelope.source.provider, "sina");
  assert.equal(envelope.source.url, record.url);
  assert.equal(envelope.data.currency, "CNY");
  assert.equal(envelope.data.basis, "year_to_date");
  assert.equal(envelope.data.consolidation, "consolidated");
  assert.equal(envelope.data.observations.length, 1);
  const observation = envelope.data.observations[0];
  assert.deepEqual(
    Object.keys(observation.values).sort(),
    [...query.fields].sort(),
  );
  for (const field of query.fields)
    assert.ok(Number.isFinite(observation.values[field]));
  assert.equal(envelope.availableAt, null);
  assert.equal(observation.availableAt, null);
  assert.equal(envelope.historicalKnowledge, "unverified");
  assert.ok(envelope.gaps.some((gap) => gap.code === "unverified_time"));
  record.outcome = "passed";
} catch (cause) {
  record.outcome = "failed";
  record.code = cause.code ?? cause.name;
  if (cause.code === "ERR_ASSERTION") record.assertion = cause.message;
  process.exitCode = 1;
} finally {
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
    case: record.case,
    target: record.target,
    outcome: record.outcome,
    stage: record.stage,
    code: record.code,
    assertion: record.assertion,
    sourceCalls: record.sourceCalls,
    periodEnd: record.envelope?.data.observations[0].periodEnd,
    historicalKnowledge: record.envelope?.historicalKnowledge,
    durationMs: record.durationMs,
  }),
);

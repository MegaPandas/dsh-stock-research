import assert from "node:assert/strict";
import console from "node:console";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { parse } from "yaml";
import { satisfies } from "semver";
import {
  HostResearchAdapter,
  parseLocalDate,
} from "@megapandas/dsh-stock-research/core";

const [installAnchor, profilePath, envPath, inputDate, outputPath] =
  process.argv.slice(2);
if (
  [installAnchor, profilePath, envPath, inputDate, outputPath].some(
    (value) => value === undefined,
  )
) {
  console.error(
    "Usage: npm run check:research -- <dsh-package.json> <profile-patch.yml> <harness-env-file> <research-date> <new-output.json>",
  );
  process.exit(2);
}
const date = parseLocalDate(inputDate);
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const cutoff = new Date(
  Math.min(Date.now(), Date.parse(`${date}T23:59:59.999+08:00`)),
).toISOString();
const require = createRequire(installAnchor);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const startedAt = performance.now();
const nativeFetch = globalThis.fetch;
const query = "比亚迪 002594 2026 三季度 业绩 公告";
const maxResults = 3;
const record = {
  case: "live host search and normalization",
  target: "SZ.002594",
  date,
  cutoff,
  query,
  maxResults,
  provider: "deepseek-search-api",
  outcome: "pending",
  stage: "configuration",
  hostCalls: 0,
  requests: 0,
  httpStatus: null,
  raw: null,
  envelope: null,
};
let ctx;
let output;

function webConfigurations(node) {
  if (node === null || typeof node !== "object") return [];
  if (node.id === "web") return [node.config];
  return Object.values(node).flatMap(webConfigurations);
}

try {
  // Reserve a new evidence file before sending any request; never replace an earlier capture.
  output = openSync(outputPath, "wx", 0o600);
  assert.ok(
    satisfies(
      require("@deepseek-ai/dsh/package.json").version,
      manifest.engines.dsh,
      { includePrerelease: true },
    ),
    "The DSH host must satisfy the declared support range.",
  );
  const webRequire = createRequire(
    require.resolve("@deepseek-ai/dsh-web/package.json"),
  );
  record.host = {
    dsh: require("@deepseek-ai/dsh/package.json").version,
    cordis: require("@deepseek-ai/cordis/package.json").version,
    web: require("@deepseek-ai/dsh-web/package.json").version,
    webZod: webRequire("zod/package.json").version,
  };
  assert.ok(
    satisfies(
      record.host.cordis,
      manifest.peerDependencies["@deepseek-ai/cordis"],
      {
        includePrerelease: true,
      },
    ),
    "Cordis must satisfy the declared peer range.",
  );
  assert.ok(
    satisfies(
      record.host.web,
      manifest.peerDependencies["@deepseek-ai/dsh-web"],
      {
        includePrerelease: true,
      },
    ),
    "The web SDK must satisfy the declared peer range.",
  );
  const patch = parse(readFileSync(profilePath, "utf8"), {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
  });
  const configurations = webConfigurations(patch);
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0].searchProvider, record.provider);
  const [cordis, web, credentials, environment, deepseek] = await Promise.all([
    load("@deepseek-ai/cordis"),
    load("@deepseek-ai/dsh-web"),
    load("@deepseek-ai/dsh-credentials-local"),
    load("@deepseek-ai/dsh-launch-environment"),
    load("@deepseek-ai/dsh-web-deepseek-api"),
  ]);
  ctx = new cordis.Context();
  ctx.provide(
    "launchEnvironment",
    environment.createLaunchEnvironmentSnapshot([
      { source: "process", values: process.env },
      {
        source: "user-env",
        path: envPath,
        values: parseEnv(readFileSync(envPath, "utf8")),
      },
    ]),
  );
  record.stage = "host";
  await ctx.plugin(credentials.LocalCredentialProvider, {
    path: join(dirname(envPath), ".credentials.yaml"),
    watch: false,
  });
  const credential = await ctx.credentials.describe("DEEPSEEK_API_KEY");
  assert.equal(credential.configured, true);
  assert.equal(credential.source, "file");
  record.credentialSource = credential.source;
  await ctx.plugin(web.default, { searchProvider: record.provider });
  await ctx.plugin(deepseek, {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    count: maxResults,
    sendOriginalQuestion: false,
  });

  globalThis.fetch = async (input, init) => {
    record.requests++;
    assert.equal(record.requests, 1, "Only one search request is authorized.");
    assert.equal(String(input), `${deepseek.DEEPSEEK_WEB_API_BASE_URL}/search`);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.query, query);
    assert.equal(body.count, maxResults);
    assert.equal(body.need_content, false);
    const response = await nativeFetch(input, init);
    record.httpStatus = response.status;
    return response;
  };
  const adapter = new HostResearchAdapter(async (request, signal) => {
    record.hostCalls++;
    const result = await ctx.web.search(request, signal);
    record.raw = result;
    return result;
  });
  record.stage = "query";
  const envelope = await adapter.query(
    {
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
      query,
      maxResults,
    },
    globalThis.AbortSignal.timeout(20_000),
  );
  record.envelope = envelope;
  record.stage = "acceptance";
  assert.equal(record.hostCalls, 1);
  assert.equal(record.requests, 1);
  assert.equal(record.httpStatus, 200);
  assert.ok(
    envelope.data.items.length > 0 && envelope.data.items.length <= maxResults,
  );
  assert.ok(
    envelope.data.items.some(
      (item) => item.title !== null && item.snippet !== null,
    ),
  );
  assert.deepEqual(
    envelope.data.items.map((item) => item.url),
    record.raw.sources.map((item) => item.url),
  );
  assert.equal(envelope.data.view, "current_search");
  assert.equal(envelope.historicalKnowledge, "unverified");
  assert.equal(envelope.availableAt, null);
  assert.equal(envelope.cutoff, cutoff);
  assert.ok(envelope.gaps.some((gap) => gap.code === "unverified_time"));
  assert.ok(
    envelope.data.items.every(
      (item) =>
        item.publishedAt === null &&
        item.availableAt === null &&
        item.location === null,
    ),
  );
  record.outcome = "passed";
} catch (cause) {
  // Provider errors can contain endpoints and transport details; output only stable diagnostics.
  record.outcome = "failed";
  record.code = cause.code ?? cause.name;
  if (cause.code === "ERR_ASSERTION") record.assertion = cause.message;
  process.exitCode = 1;
} finally {
  try {
    await ctx?.fiber.dispose();
  } finally {
    globalThis.fetch = nativeFetch;
    record.durationMs = performance.now() - startedAt;
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
    provider: record.provider,
    outcome: record.outcome,
    stage: record.stage,
    code: record.code,
    assertion: record.assertion,
    hostCalls: record.hostCalls,
    requests: record.requests,
    httpStatus: record.httpStatus,
    items: record.envelope?.data.items.length ?? null,
    durationMs: record.durationMs,
  }),
);

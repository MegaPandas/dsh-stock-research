import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

let fixture = process.argv[2];
if (fixture === undefined) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = await mkdtemp(join(tmpdir(), "dsh-research-context-"));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  const { build } = await import("tsdown");
  await build({
    config: false,
    entry: { fixture: join(root, "scripts/fixtures/research-context.ts") },
    outDir: directory,
    platform: "node",
    target: "node24",
    format: "esm",
    dts: false,
    clean: false,
    deps: { neverBundle: [/^[^./]/] },
    logLevel: "silent",
  });
  fixture = join(directory, "fixture.mjs");
}
assert.ok(isAbsolute(fixture), "fixture must be an absolute bundle path");
const { contextSample } = await import(pathToFileURL(fixture).href);
const results = [];
const date = "2024-01-03T08:00:00.000Z";
for (const mode of ["quick", "deep"]) {
  mock.timers.enable({ apis: ["Date"], now: new Date(date) });
  try {
    results.push(await contextSample(mode));
  } finally {
    mock.timers.reset();
  }
}
process.stdout.write(
  JSON.stringify(
    {
      version: 1,
      fixture,
      node: process.version,
      workload: { date, samplesPerMode: 1, realTimers: true },
      measurement: {
        unit: "serialized UTF-8 bytes",
        systemPrompt:
          "system-role messages plus optional GenerateOptions.system",
        messages: "all non-system messages",
        tools:
          "array of {name,description,parameters}; no output schema/execute",
        fieldShares:
          "serialized field value bytes / serialized tool object bytes",
      },
      results,
    },
    null,
    2,
  ) + "\n",
);

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { cpus } from "node:os";
import { isAbsolute } from "node:path";
import process from "node:process";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

assert.ok(
  process.argv[2] && isAbsolute(process.argv[2]),
  "argv[2] must be an absolute frozen fixture bundle path",
);
const samples = process.argv[3] === undefined ? 5 : Number(process.argv[3]);
assert.ok(
  Number.isInteger(samples) && samples > 0,
  "samples must be a positive integer",
);
const { sample } = await import(pathToFileURL(process.argv[2]).href);
const clock = async (mode, profile, onRunBoundary) => {
  mock.timers.enable({
    apis: ["Date"],
    now: new Date("2024-01-03T08:00:00.000Z"),
  });
  try {
    return await sample(mode, profile, onRunBoundary);
  } finally {
    mock.timers.reset();
  }
};
async function counted(mode, profile) {
  const original = fs.readFileSync;
  let active = false;
  const reads = Object.fromEntries(
    ["manifest", "input", "artifact", "evidence", "other", "total"].map(
      (key) => [key, { count: 0, bytes: 0 }],
    ),
  );
  fs.readFileSync = function (...args) {
    const value = Reflect.apply(original, this, args);
    if (!active) return value;
    const path = String(args[0]);
    const kind = path.endsWith("/manifest.json")
      ? "manifest"
      : path.includes("/inputs/")
        ? "input"
        : path.includes("/artifacts/")
          ? "artifact"
          : path.includes("/evidence/")
            ? "evidence"
            : "other";
    const bytes =
      typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    for (const key of [kind, "total"]) {
      reads[key].count++;
      reads[key].bytes += bytes;
    }
    return value;
  };
  try {
    return {
      result: await clock(mode, profile, (value) => {
        active = value;
      }),
      reads,
    };
  } finally {
    fs.readFileSync = original;
  }
}
const summarize = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    median:
      ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) / 2,
    min: ordered[0],
    max: ordered.at(-1),
  };
};
const results = [];
const semantics = {};
for (const profile of ["slow-macro", "slow-fundamentals"]) {
  for (const mode of ["quick", "deep"]) {
    const warmup = await clock(mode, profile);
    if (semantics[mode] === undefined) semantics[mode] = warmup.semantic;
    else
      assert.deepEqual(
        warmup.semantic,
        semantics[mode],
        `${mode}: profile changed semantic output`,
      );
    const rows = [];
    for (let index = 0; index < samples; index++) {
      const value = await clock(mode, profile);
      const { semantic, ...measured } = value;
      assert.deepEqual(
        semantic,
        warmup.semantic,
        `${mode}/${profile}: semantic output changed`,
      );
      rows.push(measured);
    }
    const { result, reads } = await counted(mode, profile);
    assert.deepEqual(
      result.semantic,
      warmup.semantic,
      `${mode}/${profile}: counted sample output changed`,
    );
    const statistics = Object.fromEntries(
      Object.keys(rows[0].timing).map((key) => [
        key,
        summarize(rows.map(({ timing }) => timing[key])),
      ]),
    );
    results.push({
      mode,
      profile,
      samples: rows,
      statistics,
      reads,
    });
  }
}
process.stdout.write(
  JSON.stringify(
    {
      version: 1,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        versions: process.versions,
      },
      workload: {
        warmups: 1,
        samples,
        countedSamples: 1,
        date: "2024-01-03T08:00:00.000Z",
        realTimers: true,
        realPerformanceClock: true,
        overlap: "HTTP requests overlapping the first analysis model stream",
      },
      semantics,
      results,
    },
    null,
    2,
  ) + "\n",
);

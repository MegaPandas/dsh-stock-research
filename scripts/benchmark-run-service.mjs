import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DataRoot, RunService, RunStore } from "dsh-stock-research/core";

const directory = mkdtempSync(join(tmpdir(), "dsh-run-service-bench-"));
const count = 20;
const input = {
  definition: {
    scope: {
      security: {
        id: "US:NVDA",
        market: "US",
        symbol: "NVDA",
        exchange: "NASDAQ",
        currency: "USD",
        timeZone: "America/New_York",
      },
      date: "2024-01-02",
      cutoff: "2024-01-02T21:00:00.000Z",
    },
    mode: "quick",
    tasks: Array.from({ length: count }, (_, i) => ({
      id: `analysis.${i}`,
      executor: { kind: "role", role: "analyst", specialty: "market" },
      dependsOn: [],
      inputTasks: [],
      outputKinds: ["analysis"],
      dataRequirements: [],
      instructionVersion: 1,
    })),
  },
  versions: {
    plugin: "0.1.0-dev.1",
    mode: "benchmark",
    prompts: {},
    skills: {},
    adapters: {},
    normalization: {},
  },
  inputs: [
    {
      name: "instructions",
      content: "Synthetic independent tasks; no models or network.",
    },
  ],
};
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
let root;
try {
  root = new DataRoot(directory);
  const service = new RunService(new RunStore(root), () =>
    new Date().toISOString(),
  );
  const start = performance.now();
  const { runId } = service.open("benchmark", input, "open");
  const openMs = performance.now() - start;
  const claims = [];
  const commits = [];
  const replays = [];
  const submitted = [];
  for (const task of input.definition.tasks) {
    const claimStart = performance.now();
    const claim = service.claim(
      { runId, identity: "benchmark" },
      task.id,
      `claim-${task.id}`,
    );
    claims.push(performance.now() - claimStart);
    const operation = {
      runId,
      identity: `benchmark-${task.id}`,
      taskId: task.id,
      attempt: claim.attempt,
      sessionId: null,
    };
    const content = {
      kind: "analysis",
      title: task.id,
      body: "x".repeat(1024),
      claims: [],
      inputRefs: [],
      payload: { findings: ["synthetic benchmark"] },
    };
    const commitStart = performance.now();
    service.commitArtifact(operation, [content], "submit");
    commits.push(performance.now() - commitStart);
    submitted.push({ operation, content });
  }
  for (const { operation, content } of submitted) {
    const replayStart = performance.now();
    service.commitArtifact(operation, [content], "submit");
    replays.push(performance.now() - replayStart);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        runs: 1,
        tasks: count,
        bodyBytes: 1024,
        openMs,
        claim: summarize(claims),
        submitIncludingProjections: summarize(commits),
        receiptReplayIncludingProjectionRepair: summarize(replays),
        finalStatus: service.view({ runId }).status,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    root?.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

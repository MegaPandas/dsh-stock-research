import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DataRoot, RunService, RunStore } from "dsh-stock-research/core";

const count = 20;
const directory = mkdtempSync(join(tmpdir(), "dsh-run-control-bench-"));
function task(id, dependsOn) {
  return {
    id,
    dependsOn,
    inputTasks: dependsOn,
    executor: { kind: "role", role: "analyst", specialty: "benchmark" },
    outputKinds: ["analysis"],
    dataRequirements: [],
    instructionVersion: 1,
  };
}
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
    tasks: [
      ...Array.from({ length: count }, (_, i) =>
        task(`chain.${i}`, i === 0 ? [] : [`chain.${i - 1}`]),
      ),
      task("independent", []),
    ],
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
      name: "instruction",
      content: "Synthetic chain and one independent task.",
    },
  ],
};
function timed(action) {
  const start = performance.now();
  const result = action();
  return { result, ms: performance.now() - start };
}
let root;
try {
  root = new DataRoot(directory);
  const service = new RunService(new RunStore(root), () =>
    new Date().toISOString(),
  );
  const { runId } = service.open("benchmark", input, "open");
  const operation = { runId, identity: "benchmark" };
  for (const task of input.definition.tasks) {
    const claimed = service.claim(operation, task.id, `claim-${task.id}`);
    service.commitArtifact(
      {
        ...operation,
        taskId: task.id,
        attempt: claimed.attempt,
        sessionId: null,
      },
      [
        {
          kind: "analysis",
          title: task.id,
          body: "x".repeat(1024),
          inputRefs: claimed.inputRefs,
          claims: [],
          payload: {},
        },
      ],
      `submit-${task.id}`,
    );
  }
  const redone = timed(() => service.redo(operation, "chain.0", "redo"));
  const replays = [];
  for (let i = 0; i < 20; i++)
    replays.push(timed(() => service.redo(operation, "chain.0", "redo")).ms);
  replays.sort((a, b) => a - b);
  const claimed = service.claim(operation, "chain.0", "claim-recovered");
  const recovery = timed(() =>
    service.recoverInterrupted(
      operation,
      [{ taskId: "chain.0", attempt: claimed.attempt }],
      { code: "INTERRUPTED", message: "Synthetic stopped execution" },
      "recover",
    ),
  );
  const blocked = timed(() =>
    service.block(
      operation,
      [
        {
          taskId: "chain.0",
          attempt: claimed.attempt,
          code: "WAIT",
          message: "Synthetic review",
        },
      ],
      "block",
    ),
  );
  const resumed = timed(() =>
    service.resume(
      operation,
      {
        resolvedReasonIds: blocked.result.reasonIds,
        instructions: [
          { taskId: "chain.0", instruction: "Revised synthetic instruction" },
        ],
      },
      "resume",
    ),
  );
  service.claim(operation, "chain.0", "claim-revised");
  const cancelled = timed(() => service.cancel(operation, "cancel"));
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        chainTasks: count,
        independentTasks: 1,
        bodyBytes: 1024,
        redoMs: redone.ms,
        affectedTasks: redone.result.affectedTasks.length,
        redoReplayMedianMs: replays[10],
        redoReplayP95Ms: replays[18],
        redoReplays: 20,
        recoverMs: recovery.ms,
        blockMs: blocked.ms,
        resumeIncludingInstructionMs: resumed.ms,
        cancelMs: cancelled.ms,
        stopAttempts: cancelled.result.stopAttempts.length,
        finalStatus: service.view(operation).status,
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

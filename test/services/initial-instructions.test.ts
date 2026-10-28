import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchArtifactInput } from "../../src/contracts/artifact-payloads.js";
import type {
  DigestModelInput,
  GenerateDigest,
} from "../../src/contracts/digests.js";
import type {
  OpenRunInput,
  RunState,
  TaskInstructionSnapshot,
  TaskOperation,
} from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { DigestService } from "../../src/services/digests.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

const cleanups: (() => void | Promise<void>)[] = [];
const analystInstruction = "Analyze only the fixed market inputs.";
const digestInstruction = "Summarize only fixed upstream findings.";

function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-initial-instructions-"));
  const root = new DataRoot(directory);
  cleanups.push(() => {
    try {
      root.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const store = new RunStore<RunState>(root);
  const clock = { value: "2024-01-04T00:00:00.000Z" };
  const runs = new RunService(store, () => clock.value);
  const artifacts = new ArtifactService(runs, new NumberService(runs));
  const input: OpenRunInput = {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T22:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        {
          id: "analysis",
          executor: { kind: "role", role: "analyst", specialty: "market" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 3,
        },
        {
          id: "digest",
          executor: { kind: "service", service: "digest" },
          dependsOn: ["analysis"],
          inputTasks: ["analysis"],
          outputKinds: ["digest"],
          dataRequirements: [],
          instructionVersion: 5,
        },
        {
          id: "finalize",
          executor: { kind: "service", service: "finalize" },
          dependsOn: ["digest"],
          inputTasks: ["digest"],
          outputKinds: ["decision", "report"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    },
    versions: {
      plugin: "1",
      mode: "quick-1",
      prompts: { analyst: "3", digest: "5" },
      skills: { research: "1" },
      adapters: {},
      normalization: {},
    },
    inputs: [
      { name: "prompt:analyst", content: { text: "Frozen analyst prompt" } },
    ],
    instructions: [
      { taskId: "analysis", instruction: analystInstruction },
      { taskId: "digest", instruction: digestInstruction },
    ],
  };
  return { root, store, clock, runs, artifacts, input };
}
function analysis(): ResearchArtifactInput {
  return {
    kind: "analysis",
    title: "Fixed analysis",
    body: "Qualitative fixed finding.",
    inputRefs: [],
    claims: [],
    payload: {
      findings: [
        { text: "Qualitative fixed finding", evidence: [], numbers: [] },
      ],
      risks: [],
      gaps: [],
    },
  };
}
function taskOperation(claim: ReturnType<RunService["claim"]>): TaskOperation {
  return { ...claim, identity: "analyst-worker", sessionId: null };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("initial task instructions", () => {
  it("pins initial role and digest instructions to their declared versions and catalog entries", () => {
    const f = setup();
    const { runId } = f.runs.open("owner", f.input, "open");
    const operation = { runId, identity: "owner" };
    const definition = f.store.read(runId).definitionRef;
    const catalog = f.runs.inputCatalog(runId);
    expect(catalog.versions).toEqual(f.input.versions);
    const prompt = catalog.inputs.find(
      (entry) => entry.name === "prompt:analyst",
    )!;
    expect(f.runs.readInput(runId, prompt.ref)).toEqual({
      text: "Frozen analyst prompt",
    });
    const role = f.runs.claim(operation, "analysis", "claim-analysis");
    expect(role).toMatchObject({
      instructionVersion: 3,
      instructionRef: catalog.inputs.find(
        (entry) => entry.instruction?.taskId === "analysis",
      )!.ref,
    });
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(runId, role.instructionRef!),
    ).toEqual({
      taskId: "analysis",
      instruction: analystInstruction,
      version: 3,
      previous: null,
      baseDefinition: definition,
      recordedAt: f.clock.value,
    });
    f.artifacts.submitArtifact(taskOperation(role), [analysis()], "analysis");
    const digest = f.runs.claimService(
      operation,
      "digest",
      "digest",
      "claim-digest",
    );
    expect(digest).toMatchObject({
      instructionVersion: 5,
      instructionRef: catalog.inputs.find(
        (entry) => entry.instruction?.taskId === "digest",
      )!.ref,
    });
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(runId, digest.instructionRef!),
    ).toEqual({
      taskId: "digest",
      instruction: digestInstruction,
      version: 5,
      previous: null,
      baseDefinition: definition,
      recordedAt: f.clock.value,
    });
    expect(
      catalog.inputs
        .filter((entry) => entry.instruction !== undefined)
        .map((entry) => entry.instruction),
    ).toEqual([
      { taskId: "analysis", version: 3 },
      { taskId: "digest", version: 5 },
    ]);
  });

  it("isolates caller inputs and returned catalogs and detects changed initial instructions on open replay", () => {
    const f = setup();
    const original = structuredClone(f.input);
    const opened = f.runs.open("owner", f.input, "open");
    const expected = f.runs.inputCatalog(opened.runId);
    f.input.instructions![0]!.instruction = "Mutated caller instruction";
    f.input.definition.tasks[0]!.instructionVersion = 99;
    f.input.versions.prompts.analyst = "mutated";
    f.input.inputs[0]!.content = "Mutated caller payload";
    const returned = f.runs.inputCatalog(opened.runId);
    returned.versions.prompts.analyst = "mutated-return";
    returned.inputs[0]!.name = "mutated-name";
    returned.inputs[0]!.ref = { kind: "input", id: "mutated-ref" };
    returned.inputs.find(
      (entry) => entry.instruction?.taskId === "analysis",
    )!.instruction!.version = 99;
    returned.inputs.pop();
    expect(f.runs.inputCatalog(opened.runId)).toEqual(expected);
    const definition = f.runs.readDefinition(opened.runId);
    definition.scope.security.id = "mutated-return";
    definition.tasks[0]!.dependsOn.push("mutated-return");
    expect(f.runs.readDefinition(opened.runId)).toEqual(original.definition);
    const claim = f.runs.claim(
      { runId: opened.runId, identity: "owner" },
      "analysis",
      "claim",
    );
    expect(claim.instructionVersion).toBe(3);
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(
        opened.runId,
        claim.instructionRef!,
      ).instruction,
    ).toBe(analystInstruction);
    expect(f.runs.readInput(opened.runId, expected.inputs[0]!.ref)).toEqual({
      text: "Frozen analyst prompt",
    });
    expect(f.runs.open("owner", original, "open")).toEqual(opened);
    const changed = structuredClone(original);
    changed.instructions![0]!.instruction =
      "Changed initial instruction for the same request";
    expect(() => f.runs.open("owner", changed, "open")).toThrowError(
      expect.objectContaining({ code: "REQUEST_CONFLICT" }),
    );
    expect(f.store.list()).toHaveLength(1);
  });

  it.each(["unknown", "duplicate"] as const)(
    "rejects an %s initial task instruction without publishing a run",
    (problem) => {
      const f = setup();
      const invalid = structuredClone(f.input);
      invalid.instructions =
        problem === "unknown"
          ? [{ taskId: "missing", instruction: "Unknown task" }]
          : [
              { taskId: "analysis", instruction: "First" },
              { taskId: "analysis", instruction: "Duplicate" },
            ];
      expect(() => f.runs.open("owner", invalid, "open")).toThrowError(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      expect(f.store.list()).toEqual([]);
      f.runs.open("owner", f.input, "open");
      expect(f.store.list()).toHaveLength(1);
    },
  );

  it("retains the initial revision chain and copies only effective instructions into a new replay run", () => {
    const f = setup();
    const { runId } = f.runs.open("owner", f.input, "open");
    const operation = { runId, identity: "owner" };
    const initialDefinition = f.store.read(runId).definitionRef;
    const first = f.runs.claim(operation, "analysis", "first");
    const initial = f.runs.readInput<TaskInstructionSnapshot>(
      runId,
      first.instructionRef!,
    );
    f.runs.failAttempt(
      taskOperation(first),
      { code: "MODEL_FAILED", message: "Synthetic role failure" },
      "fail-first",
    );
    f.clock.value = "2024-01-04T01:00:00.000Z";
    f.runs.resume(
      operation,
      {
        resolvedReasonIds: [],
        instructions: [
          { taskId: "analysis", instruction: "Revised analysis instruction" },
        ],
      },
      "resume",
    );
    const second = f.runs.claim(operation, "analysis", "second");
    expect(f.runs.readDefinition(runId).tasks[0]!.instructionVersion).toBe(4);
    expect(second).toMatchObject({ attempt: 2, instructionVersion: 4 });
    expect(second.instructionRef).not.toEqual(first.instructionRef);
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(runId, second.instructionRef!),
    ).toEqual({
      taskId: "analysis",
      instruction: "Revised analysis instruction",
      version: 4,
      previous: first.instructionRef,
      baseDefinition: initialDefinition,
      recordedAt: f.clock.value,
    });
    expect(f.runs.readInput(runId, first.instructionRef!)).toEqual(initial);
    expect(f.runs.readAttempt(first)).toMatchObject({
      instructionVersion: 3,
      instructionRef: first.instructionRef,
      status: "failed",
    });
    const sourceCatalog = f.runs.inputCatalog(runId);
    const sourceDefinition = f.store.read(runId).definitionRef;
    const replay = f.runs.open(
      "owner",
      { replay: { runId }, versions: f.input.versions },
      "replay",
    );
    const replayDefinition = f.store.read(replay.runId).definitionRef;
    expect(replayDefinition).not.toEqual(initialDefinition);
    expect(replayDefinition).not.toEqual(sourceDefinition);
    const copied = f.runs.claim(
      { runId: replay.runId, identity: "owner" },
      "analysis",
      "copied",
    );
    expect(copied).toMatchObject({ attempt: 1, instructionVersion: 4 });
    expect(copied.instructionRef).not.toEqual(second.instructionRef);
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(
        replay.runId,
        copied.instructionRef!,
      ),
    ).toEqual({
      taskId: "analysis",
      instruction: "Revised analysis instruction",
      version: 4,
      previous: null,
      baseDefinition: replayDefinition,
      recordedAt: f.clock.value,
    });
    const copiedCatalog = f.runs.inputCatalog(replay.runId);
    expect(
      copiedCatalog.inputs
        .filter((entry) => entry.instruction !== undefined)
        .map((entry) => entry.instruction),
    ).toEqual([
      { taskId: "analysis", version: 4 },
      { taskId: "digest", version: 5 },
    ]);
    for (const entry of copiedCatalog.inputs)
      expect(
        sourceCatalog.inputs.map((source) => source.ref),
      ).not.toContainEqual(entry.ref);
    const copiedDigest = copiedCatalog.inputs.find(
      (entry) => entry.instruction?.taskId === "digest",
    )!;
    expect(
      f.runs.readInput<TaskInstructionSnapshot>(replay.runId, copiedDigest.ref),
    ).toMatchObject({
      instruction: digestInstruction,
      version: 5,
      previous: null,
      baseDefinition: replayDefinition,
    });
    expect(f.runs.inputCatalog(runId)).toEqual(sourceCatalog);
    expect(f.runs.readInput(runId, first.instructionRef!)).toEqual(initial);
  });

  it("passes the initial digest instruction to the model and commits against real upstream artifacts", async () => {
    const f = setup();
    const { runId } = f.runs.open("owner", f.input, "open");
    const operation = { runId, identity: "owner" };
    const role = f.runs.claim(operation, "analysis", "analysis");
    const upstream = f.artifacts.submitArtifact(
      taskOperation(role),
      [analysis()],
      "analysis",
    );
    const seen: DigestModelInput[] = [];
    const generate: GenerateDigest = async (
      context,
      signal,
      _operation,
      submit,
    ) => {
      signal.throwIfAborted();
      seen.push(structuredClone(context));
      const refs = context.artifacts.map((artifact) => artifact.ref);
      return submit({
        title: "Digest",
        body: "Fixed summary",
        inputRefs: refs,
        facts: [
          { text: "Qualitative fixed finding", inputRefs: refs, numbers: [] },
        ],
        disagreements: [],
        riskSummaries: [],
      });
    };
    const digests = new DigestService(f.runs, f.artifacts, generate);
    cleanups.push(() => digests.close());
    const result = await digests.makeDigest(operation, "digest", "digest");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskId: "digest",
      instructionVersion: 5,
      instruction: digestInstruction,
    });
    expect(seen[0]!.artifacts.map((artifact) => artifact.ref)).toEqual(
      upstream.refs,
    );
    const catalogEntry = f.runs
      .inputCatalog(runId)
      .inputs.find((entry) => entry.instruction?.taskId === "digest")!;
    expect(f.runs.readAttempt(result)).toMatchObject({
      status: "succeeded",
      instructionVersion: 5,
      instructionRef: catalogEntry.ref,
    });
    expect(f.runs.readArtifact(result.refs[0]!).content).toMatchObject({
      kind: "digest",
      inputRefs: upstream.refs,
    });
  });
});

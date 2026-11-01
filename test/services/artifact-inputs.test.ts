import { expect, it, vi } from "vitest";
import type { ResearchArtifactVersion } from "../../src/contracts/artifact-payloads.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import { ArtifactInputs } from "../../src/services/artifact-inputs.js";

function artifact(
  id: string,
  revision: number,
  inputRefs: ArtifactRef[] = [],
): ResearchArtifactVersion {
  return {
    ref: { runId: "run", artifactId: id, revision },
    taskId: id,
    attempt: 1,
    producerSessionId: null,
    createdAt: "2024-07-01T12:00:00.000Z",
    schemaVersion: 1,
    content: {
      kind: "analysis",
      title: id,
      body: id,
      inputRefs,
      claims: [],
      payload: { findings: [], risks: [], gaps: [] },
    },
  };
}

function reader(versions: ResearchArtifactVersion[]) {
  return {
    readArtifact: vi.fn((ref: ArtifactRef) =>
      versions.find(
        (version) =>
          version.ref.runId === ref.runId &&
          version.ref.artifactId === ref.artifactId &&
          version.ref.revision === ref.revision,
      )!,
    ),
    readEvidence: vi.fn(),
    readInputs: vi.fn(),
    numberContext: vi.fn(),
  };
}

it("traverses multiple roots and shared dependencies once while retaining distinct fixed revisions", () => {
  const leaf = artifact("leaf", 1);
  const first = artifact("shared", 1, [leaf.ref]);
  const second = artifact("shared", 2, [leaf.ref]);
  const a = artifact("a", 1, [first.ref]);
  const b = artifact("b", 1, [second.ref, first.ref]);
  const runs = reader([leaf, first, second, a, b]);
  const inputs = new ArtifactInputs(runs);
  const expected = [a.ref, b.ref, first.ref, second.ref, leaf.ref];
  expect(inputs.closure([a.ref, b.ref, a.ref]).map(({ ref }) => ref)).toEqual(
    expected,
  );
  expect(runs.readArtifact).toHaveBeenCalledTimes(5);
  expect(inputs.closure([b.ref, a.ref]).map(({ ref }) => ref)).toEqual([
    b.ref,
    a.ref,
    second.ref,
    first.ref,
    leaf.ref,
  ]);
  expect(runs.readArtifact).toHaveBeenCalledTimes(5);
  new ArtifactInputs(runs).closure([a.ref, b.ref]);
  expect(runs.readArtifact).toHaveBeenCalledTimes(10);
});

it("uses the captured pending version together with fixed upstream versions", () => {
  const saved = artifact("saved", 1);
  const pending = artifact("pending", 1, [saved.ref]);
  const runs = reader([saved]);
  const inputs = new ArtifactInputs(runs, [pending]);
  expect(inputs.closure([pending.ref])).toEqual([pending, saved]);
  expect(runs.readArtifact).toHaveBeenCalledTimes(1);
});

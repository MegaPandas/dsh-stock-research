import { expect, it, vi } from "vitest";
import type { ResearchArtifactVersion } from "../../src/contracts/artifact-payloads.js";
import type { ArtifactRef } from "../../src/contracts/data.js";
import type { ContentRef } from "../../src/contracts/storage.js";
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
    readInputs: <T>(runId: string, refs: readonly ContentRef[]): T[] =>
      refs.map((ref) =>
        versions.find(
          (version) =>
            version.ref.runId === runId &&
            version.ref.artifactId === ref.id &&
            ref.kind === "artifact" &&
            version.ref.revision === ref.revision,
        ),
      ) as T[],
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
  expect(inputs.closure([b.ref, a.ref]).map(({ ref }) => ref)).toEqual([
    b.ref,
    a.ref,
    second.ref,
    first.ref,
    leaf.ref,
  ]);
  expect(
    new ArtifactInputs(runs).closure([a.ref, b.ref]).map(({ ref }) => ref),
  ).toEqual(expected);
});

it("uses the captured pending version together with fixed upstream versions", () => {
  const saved = artifact("saved", 1);
  const pending = artifact("pending", 1, [saved.ref]);
  const runs = reader([saved]);
  const inputs = new ArtifactInputs(runs, [pending]);
  expect(inputs.closure([pending.ref])).toEqual([pending, saved]);
});

it("keeps artifacts in different runs distinct and reuses captured roots", () => {
  const first = artifact("shared", 1);
  const second = artifact("shared", 1);
  second.ref = { ...second.ref, runId: "other-run" };
  second.content.title = "Other run";
  const a = artifact("a", 1, [first.ref, second.ref]);
  const b = artifact("b", 1, [second.ref, first.ref]);
  b.ref = { ...b.ref, runId: "other-run" };
  const inputs = new ArtifactInputs(reader([a, b, first, second]));
  expect(inputs.artifact(a.ref)).toEqual(a);
  expect(inputs.closure([a.ref, b.ref])).toEqual([a, b, first, second]);
});

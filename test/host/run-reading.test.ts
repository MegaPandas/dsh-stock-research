import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, expect, it, vi } from "vitest";
import { SessionBindings } from "../../src/host/bindings.js";
import { createRunReadOperations } from "../../src/host/run-reading.js";
import { decisionFixture } from "../fixtures/decision.js";

const fixtures: ReturnType<typeof decisionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const f = decisionFixture();
  fixtures.push(f);
  const agent = { id: "reader" } as Agent;
  const bindings = new SessionBindings();
  bindings.bind(agent, { kind: "coordinator", runIds: [f.operation.runId] });
  const reads = createRunReadOperations(f.runs, bindings);
  const caller = { agent, signal: new AbortController().signal };
  return { ...f, reads, bindings, caller };
}

it("reads a typed run id and fixed artifact reference through the host capability", () => {
  const c = setup();
  expect(c.reads.readRun(c.operation.runId, c.caller)).toEqual(
    c.runs.view(c.operation),
  );
  expect(c.reads.readArtifact(c.analysisRef, c.caller)).toEqual(
    c.runs.readArtifact(c.analysisRef),
  );
});

it("rejects unbound objects and unauthorized runs before storage access", () => {
  const c = setup();
  const view = vi.spyOn(c.runs, "view");
  const read = vi.spyOn(c.runs, "readArtifact");
  for (const agent of [undefined, { id: c.caller.agent.id } as Agent]) {
    const caller = { ...c.caller, agent };
    expect(() => c.reads.readRun(c.operation.runId, caller)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    expect(() => c.reads.readArtifact(c.analysisRef, caller)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  }
  expect(() => c.reads.readRun("other-run", c.caller)).toThrowError(
    expect.objectContaining({ code: "ACCESS_DENIED" }),
  );
  expect(() =>
    c.reads.readArtifact({ ...c.analysisRef, runId: "other-run" }, c.caller),
  ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("checks cancellation before bindings or storage for direct host calls", () => {
  const c = setup();
  const require = vi.spyOn(c.bindings, "require");
  const view = vi.spyOn(c.runs, "view");
  const read = vi.spyOn(c.runs, "readArtifact");
  const reason = new Error("stop reading");
  const caller = { signal: AbortSignal.abort(reason) };
  expect(() => c.reads.readRun(c.operation.runId, caller)).toThrow(reason);
  expect(() => c.reads.readArtifact(c.analysisRef, caller)).toThrow(reason);
  expect(require).not.toHaveBeenCalled();
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

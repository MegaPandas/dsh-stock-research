import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, expect, it, vi } from "vitest";
import { createResearchReadTools } from "../../src/app/research-read-tools.js";
import { SessionBindings } from "../../src/host/bindings.js";
import { createRunReadOperations } from "../../src/host/run-reading.js";
import { DecisionService } from "../../src/services/decisions.js";
import { decisionFixture } from "../fixtures/decision.js";

const fixtures: ReturnType<typeof decisionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const f = decisionFixture();
  fixtures.push(f);
  const agent = { id: "coordinator" } as Agent;
  const bindings = new SessionBindings();
  bindings.bind(agent, { kind: "coordinator", runIds: [f.operation.runId] });
  const tools = createResearchReadTools(
    createRunReadOperations(f.runs, bindings),
  );
  const call = (
    name: string,
    value: unknown,
    signal = new AbortController().signal,
  ) =>
    tools
      .find((tool) => tool.name === name)!
      .execute(value, {
        agent,
        signal,
        callId: "read",
      } as ToolRunContext);
  return { ...f, call };
}

it("presents the current output catalog with its authorized run view", async () => {
  const f = setup();
  const view = f.runs.view(f.operation);
  const result = await f.call("stock_read_run", { runId: f.operation.runId });
  expect(result).toMatchObject({
    kind: "run_view",
    view,
    reportCatalog: expect.arrayContaining([
      {
        ref: f.analysisRef,
        taskId: "analysis",
        kind: "analysis",
        title: "Market analysis",
        summary: null,
      },
      {
        ref: f.draftRef,
        taskId: "manager",
        kind: "decision_draft",
        title: "Manager decision",
        summary: null,
      },
    ]),
  });
});

it("presents final report text while preserving its complete stored artifact", async () => {
  const f = setup();
  const result = new DecisionService(f.runs, f.now).decide(
    f.operation,
    "final",
    "finalize",
  );
  const ref = result.refs[1]!;
  const saved = f.runs.readArtifact(ref);
  const { kind, title, body } = saved.content;
  expect(await f.call("stock_read_artifact", { ref })).toEqual({
    kind: "artifact",
    artifact: { ...saved, content: { kind, title, body } },
  });
  expect(f.runs.readArtifact(ref)).toEqual(saved);
});

it("rejects run and artifact reads outside the coordinator binding", async () => {
  const f = setup();
  await expect(
    f.call("stock_read_run", { runId: "another-run" }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    f.call("stock_read_artifact", {
      ref: { ...f.analysisRef, runId: "another-run" },
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

it("validates closed arguments and references before reading storage", async () => {
  const f = setup();
  const view = vi.spyOn(f.runs, "view");
  const read = vi.spyOn(f.runs, "readArtifact");
  for (const [name, value] of [
    ["stock_read_run", { runId: f.operation.runId, cutoff: f.scope.cutoff }],
    ["stock_read_run", { runId: "" }],
    ["stock_read_artifact", { ref: { ...f.analysisRef, sessionId: "forged" } }],
    ["stock_read_artifact", { ref: { ...f.analysisRef, revision: 0 } }],
  ] as const)
    await expect(f.call(name, value)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("checks cancellation before parsing tool arguments", async () => {
  const f = setup();
  const view = vi.spyOn(f.runs, "view");
  const read = vi.spyOn(f.runs, "readArtifact");
  const reason = new Error("stop reading");
  for (const name of ["stock_read_run", "stock_read_artifact"])
    await expect(f.call(name, {}, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
  expect(view).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

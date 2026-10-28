import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import type { ResearchScope } from "../../src/contracts/data.js";
import {
  authorizeRun,
  SessionBindings,
  taskOperation,
  type ResearchBinding,
} from "../../src/host/bindings.js";

// Bindings consume only external Agent identity, without starting its runtime.
function agent(id = "session-1"): Agent {
  return { id: SessionId(id) } satisfies Pick<Agent, "id"> as Agent;
}

function scope(): ResearchScope {
  return {
    security: {
      id: "US:TEST",
      market: "US",
      symbol: "TEST",
      exchange: "NASDAQ",
      currency: "USD",
      timeZone: "America/New_York",
    },
    date: "2026-01-02",
    cutoff: "2026-01-02T21:00:00.000Z",
  };
}

const task: ResearchBinding = {
  kind: "task",
  runId: "run-1",
  taskId: "task-1",
  attempt: 2,
};
const accessDenied = { code: "ACCESS_DENIED" };

describe("SessionBindings", () => {
  it("captures independent copies of nested binding inputs", () => {
    const bindings = new SessionBindings();
    const coordinator = agent("coordinator");
    const reviewer = agent("reviewer");
    const runIds = ["run-1"];
    const originalScope = scope();
    const expectedScope = scope();
    bindings.bind(coordinator, { kind: "coordinator", runIds });
    bindings.bind(reviewer, {
      kind: "review",
      runId: "run-1",
      scope: originalScope,
    });

    runIds.push("run-2");
    originalScope.security.symbol = "CHANGED";
    originalScope.cutoff = "2027-01-01T00:00:00.000Z";

    expect(bindings.require(coordinator).binding).toEqual({
      kind: "coordinator",
      runIds: ["run-1"],
    });
    expect(bindings.require(reviewer).binding).toEqual({
      kind: "review",
      runId: "run-1",
      scope: expectedScope,
    });
  });

  it("rejects rebinding the same Agent and preserves its binding", () => {
    const bindings = new SessionBindings();
    const caller = agent();
    bindings.bind(caller, task);

    expect(() =>
      bindings.bind(caller, { kind: "coordinator", runIds: ["run-2"] }),
    ).toThrowError(expect.objectContaining(accessDenied));
    expect(bindings.require(caller).binding).toEqual(task);
  });

  it("does not grant a different Agent the binding of the same session id", () => {
    const bindings = new SessionBindings();
    bindings.bind(agent(), task);

    expect(() => bindings.require(agent())).toThrowError(
      expect.objectContaining(accessDenied),
    );
  });

  it("disposes only the binding of its original Agent object", () => {
    const bindings = new SessionBindings();
    const original = agent();
    const sameId = agent();
    const dispose = bindings.bind(original, task);
    const other = { kind: "coordinator", runIds: ["run-2"] } as const;
    bindings.bind(sameId, other);

    dispose();

    expect(() => bindings.require(original)).toThrowError(
      expect.objectContaining(accessDenied),
    );
    expect(bindings.require(sameId).binding).toEqual(other);
  });

  it("does not let an old disposer remove a newer binding", () => {
    const bindings = new SessionBindings();
    const caller = agent();
    const disposeOld = bindings.bind(caller, task);
    disposeOld();
    const replacement = { kind: "coordinator", runIds: ["run-2"] } as const;
    const disposeNew = bindings.bind(caller, replacement);

    disposeOld();
    disposeOld();
    expect(bindings.require(caller).binding).toEqual(replacement);
    disposeNew();
    expect(() => bindings.require(caller)).toThrowError(
      expect.objectContaining(accessDenied),
    );
  });
});

describe("taskOperation", () => {
  it("takes task coordinates from the binding and identity from Agent.id", () => {
    const bindings = new SessionBindings();
    const caller = agent("trusted-session");
    bindings.bind(caller, task);

    expect(taskOperation(bindings.require(caller))).toEqual({
      runId: "run-1",
      taskId: "task-1",
      attempt: 2,
      identity: "trusted-session",
      sessionId: "trusted-session",
    });
  });

  it("rejects every non-task role", () => {
    const nonTasks: ResearchBinding[] = [
      { kind: "coordinator", runIds: ["run-1"] },
      { kind: "review", runId: "run-1", scope: scope() },
      { kind: "ask", scope: scope() },
    ];
    for (const binding of nonTasks) {
      expect(() => taskOperation({ agent: agent(), binding })).toThrowError(
        expect.objectContaining(accessDenied),
      );
    }
  });
});

describe("authorizeRun", () => {
  it("allows only the coordinator's explicitly listed runs", () => {
    const binding: ResearchBinding = {
      kind: "coordinator",
      runIds: ["run-1", "run-2"],
    };
    expect(() => authorizeRun(binding, "run-1")).not.toThrow();
    expect(() => authorizeRun(binding, "run-2")).not.toThrow();
    expect(() => authorizeRun(binding, "run-3")).toThrowError(
      expect.objectContaining(accessDenied),
    );
  });

  it("confines task and review to their run and grants ask no run access", () => {
    const review: ResearchBinding = {
      kind: "review",
      runId: "run-1",
      scope: scope(),
    };
    for (const binding of [task, review]) {
      expect(() => authorizeRun(binding, "run-1")).not.toThrow();
      expect(() => authorizeRun(binding, "run-2")).toThrowError(
        expect.objectContaining(accessDenied),
      );
    }
    expect(() =>
      authorizeRun({ kind: "ask", scope: scope() }, "run-1"),
    ).toThrowError(expect.objectContaining(accessDenied));
  });
});

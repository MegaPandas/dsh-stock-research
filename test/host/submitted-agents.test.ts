import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { expect, it } from "vitest";
import {
  SubmittedAgents,
  type SubmittedAgentRequest,
} from "../../src/host/submitted-agents.js";
import { US_SECURITY } from "../fixtures/market.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function request<Result>(result: () => Result): SubmittedAgentRequest<Result> {
  return {
    options: { sessionId: SessionId("submitted-agent") },
    binding: {
      kind: "ask",
      scope: {
        security: US_SECURITY,
        date: "2024-01-03",
        cutoff: "2024-01-03T22:00:00.000Z",
      },
    },
    tools: [],
    message: createUserMessage({
      content: [{ type: "text", text: "Synthetic input" }],
      source: { kind: "user" },
    }),
    result,
  };
}
const agent = { followup() {}, async whenIdle() {}, cancel() {} } as Agent;

it("retains setup commit and both execution and release failures", async () => {
  const primary = new Error("Submission failed");
  const cleanup = new Error("Agent release failed");
  const commit = { commit() {} };
  let setupResult: unknown;
  const owner = new SubmittedAgents(async (options) => {
    setupResult = await options.setup?.(
      { on: () => () => {} } as unknown as Context,
      agent,
    );
    return {
      agent,
      async dispose() {
        throw cleanup;
      },
    };
  }, "review");
  const prepared = request(() => {
    throw primary;
  });
  prepared.options = { ...prepared.options, setup: () => commit };
  const result = await owner
    .run(new AbortController().signal, async () => prepared)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  expect(result).toMatchObject({
    error: {
      cause: primary,
      errors: [primary, cleanup],
      message: "Review execution cleanup failed.",
    },
  });
  expect(setupResult).toBe(commit);
  await owner.close();
});

it("waits for a late-created Agent to release without starting a cancelled turn", async () => {
  const creation = deferred<AgentHandle>();
  const started = deferred<void>();
  const disposing = deferred<void>();
  const release = deferred<void>();
  let turns = 0;
  let results = 0;
  let disposed = false;
  const owner = new SubmittedAgents(async () => {
    started.resolve();
    return creation.promise;
  }, "ask");
  const work = owner
    .run(new AbortController().signal, async () => request(() => ++results))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await started.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  creation.resolve({
    agent: {
      ...agent,
      followup() {
        turns++;
      },
    } as Agent,
    async dispose() {
      disposing.resolve();
      await release.promise;
      disposed = true;
    },
  });
  await disposing.promise;
  expect(closed).toBe(false);
  expect(disposed).toBe(false);
  release.resolve();
  await expect(work).resolves.toMatchObject({ error: { name: "AbortError" } });
  await closing;
  expect(disposed).toBe(true);
  expect(turns).toBe(0);
  expect(results).toBe(0);
  expect(() =>
    owner.run(new AbortController().signal, async () => request(() => 1)),
  ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
});

import { expect, it } from "vitest";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import type {
  RememberInput,
  RememberOperation,
} from "../../src/contracts/memory-service.js";
import type {
  PriceReturnsQuery,
  QueryResponse,
} from "../../src/contracts/query.js";
import {
  ReviewSession,
  type ReviewSessionPorts,
} from "../../src/app/review-session.js";
import { withPriceReturn } from "../../src/services/query/calculations.js";
import { MARKET_FIXTURE, US_SECURITY } from "../fixtures/market.js";

type Response = QueryResponse<PriceReturnsQuery>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const scope = {
  security: US_SECURITY,
  date: "2024-01-08",
  cutoff: MARKET_FIXTURE.cutoff,
};
const request: PriceReturnsQuery = {
  dataset: "returns",
  provider: "yahoo",
  parameters: {
    historyStartDate: "2024-01-02",
    startDate: "2024-01-02",
    endDate: "2024-01-08",
    maxAgeMs: 0,
    comparable: true,
  },
};
const envelope = withPriceReturn(MARKET_FIXTURE, request.parameters);
const report: AgentReport<"review"> = {
  summary: "Synthetic review",
  content: {
    comparisons: [
      {
        original: "Original assumption",
        observed: "Synthetic observation",
        implication: "Continue observing",
      },
    ],
    lessons: ["Synthetic lesson"],
    followUp: ["Next observation"],
  },
};
function setup(queryReturns: ReviewSessionPorts["queryReturns"]) {
  const saved: {
    operation: RememberOperation;
    content: RememberInput;
    captured: Response | undefined;
  }[] = [];
  const session = new ReviewSession({ runId: "run-a", scope }, [], {
    queryReturns,
    memory: {
      read() {
        throw new Error("Unexpected memory read");
      },
      async remember(operation, content, _requestId, _signal, captured) {
        saved.push({ operation, content, captured });
        return { entryId: "review", revision: saved.length };
      },
    },
  });
  return { session, saved };
}
const signal = new AbortController().signal;

it("rejects a pending explicit query and saves its captured response after completion", async () => {
  const pending = deferred<Response>();
  const { session, saved } = setup(() => pending.promise);
  const query = session.queryReturns(request, signal);
  await expect(
    session.submit(report, "reviewer", "submit", signal),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "The explicit returns query has not completed.",
  });
  expect(saved).toEqual([]);
  pending.resolve(envelope);
  await query;
  await session.submit(report, "reviewer", "submit", signal);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    operation: { runId: "run-a", scope, identity: "reviewer" },
    content: {
      previous: null,
      outcome: report.summary,
      evidence: [],
      returns: { kind: "query", request },
    },
    captured: envelope,
  });
});

it("keeps the latest failed query after an older query completes later", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  let calls = 0;
  const { session, saved } = setup(() =>
    ++calls === 1 ? older.promise : newer.promise,
  );
  const oldQuery = session.queryReturns(request, signal);
  const newQuery = session.queryReturns(
    {
      ...request,
      parameters: { ...request.parameters, startDate: "2024-01-03" },
    },
    signal,
  );
  const failure = new Error("Latest query unavailable");
  const rejected = expect(newQuery).rejects.toBe(failure);
  newer.reject(failure);
  await rejected;
  older.resolve(envelope);
  await oldQuery;
  await session.submit(report, "reviewer", "submit", signal);
  expect(saved[0]!.content.returns).toEqual({
    kind: "unavailable",
    gaps: [
      { code: "missing", field: "returns", detail: "Latest query unavailable" },
    ],
  });
  expect(saved[0]!.captured).toBeUndefined();
  expect(calls).toBe(2);
});

import { afterEach, expect, it } from "vitest";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import ApprovalService, {
  setApprovalPolicy,
} from "@deepseek-ai/dsh-user-approval";
import { requestBackgroundApproval } from "../../src/host/approval-turn.js";
import {
  deferred,
  runtimeHost,
  textResponse,
} from "../fixtures/runtime-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(options: Parameters<typeof runtimeHost>[0] = {}) {
  const h = await runtimeHost(options);
  cleanups.push(h.close);
  if (h.ctx.get("approval") === undefined)
    await h.ctx.plugin(ApprovalService, {});
  const agent = h.outside.agent;
  return {
    ...h,
    agent,
    request: (signal = new AbortController().signal) => ({
      agent,
      toolName: "stock_search_public",
      reason: "Background public search",
      signal,
    }),
  };
}
function question(text: string) {
  return createUserMessage({
    source: { kind: "user" },
    content: [{ type: "text", text }],
  });
}

it("keeps concurrent background decisions in separate owner turns", async () => {
  const h = await setup();
  h.ctx.on("approval/request", async (request) =>
    request.reason === "first" ? "rejected" : "allowed-once",
  );
  await expect(
    Promise.all(
      ["first", "second"].map((reason) =>
        requestBackgroundApproval(h.ctx.approval, { ...h.request(), reason }),
      ),
    ),
  ).resolves.toEqual(["rejected", "allowed-once"]);
  await h.agent.whenIdle();
  const events = h.agent.session.snapshotEvents();
  expect(events.filter(({ type }) => type === "turn/start")).toHaveLength(2);
  expect(events.filter(({ type }) => type === "approval/asked")).toHaveLength(
    2,
  );
  expect(
    events.filter(({ type }) => type === "approval/decided"),
  ).toMatchObject([
    { data: { outcome: "rejected" } },
    { data: { outcome: "allowed-once" } },
  ]);
  expect(h.adapter.requests).toHaveLength(0);
});

it("respects the owner's native never policy without contacting an answerer", async () => {
  const h = await setup();
  setApprovalPolicy(h.agent.session, "never");
  let prompts = 0;
  h.ctx.on("approval/request", async () => {
    prompts += 1;
    return "allowed-once";
  });
  await expect(
    requestBackgroundApproval(h.ctx.approval, h.request()),
  ).resolves.toBe("rejected");
  await h.agent.whenIdle();
  expect(prompts).toBe(0);
  expect(h.adapter.requests).toHaveLength(0);
});

it("withdraws an approval queued behind the owner's active turn and retains the cancellation cause", async () => {
  const started = deferred<void>();
  const released = deferred<void>();
  const h = await setup({
    respond: async function* () {
      started.resolve();
      await released.promise;
      yield* textResponse("Ordinary answer");
    },
  });
  cleanups.push(() => released.resolve());
  h.agent.followup(question("Ordinary question"));
  await started.promise;
  const controller = new AbortController();
  const reason = new Error("Research was cancelled while waiting");
  const work = requestBackgroundApproval(
    h.ctx.approval,
    h.request(controller.signal),
  );
  const checked = expect(work).rejects.toBe(reason);
  controller.abort(reason);
  await checked;
  released.resolve();
  await h.agent.whenIdle();
  expect(h.adapter.requests).toHaveLength(1);
  expect(h.agent.inbox.nextTurn).toEqual([]);
  expect(
    h.agent.session
      .snapshotEvents()
      .some(({ type }) => type === "approval/asked"),
  ).toBe(false);
});

it("closes an active native approval audit before the cancelled owner turn ends", async () => {
  const h = await setup();
  const started = deferred<void>();
  const answer = deferred<ApprovalOutcome>();
  cleanups.push(() => answer.resolve("allowed-once"));
  h.ctx.on("approval/request", async () => {
    started.resolve();
    return answer.promise;
  });
  const work = requestBackgroundApproval(h.ctx.approval, h.request());
  await started.promise;
  h.agent.cancel({ kind: "user" });
  await expect(work).resolves.toBe("cancelled");
  await h.agent.whenIdle();
  const events = h.agent.session.snapshotEvents();
  const asked = events.findIndex(({ type }) => type === "approval/asked");
  const decided = events.findIndex(({ type }) => type === "approval/decided");
  const end = events.findIndex(({ type }) => type === "turn/end");
  expect(asked).toBeGreaterThanOrEqual(0);
  expect(decided).toBeGreaterThan(asked);
  expect(end).toBeGreaterThan(decided);
  expect(events[decided]).toMatchObject({ data: { outcome: "cancelled" } });
  expect(h.adapter.requests).toHaveLength(0);
});

it("preserves ordinary input claimed with an approval when the external audit request fails", async () => {
  const h = await setup();
  const released = deferred<void>();
  cleanups.push(() => released.resolve());
  const maintenance = h.agent.runMaintenance(() => released.promise);
  h.agent.inject(question("Keep this ordinary question"));
  const failure = new Error("Native audit storage failed");
  const work = requestBackgroundApproval(
    {
      request: async () => {
        throw failure;
      },
    },
    h.request(),
  );
  const checked = expect(work).rejects.toBe(failure);
  released.resolve();
  await maintenance;
  await checked;
  await h.agent.whenIdle();
  expect(h.adapter.requests).toHaveLength(1);
  const messages = h.adapter.requests[0]!.messages;
  expect(
    messages.some(({ content }) =>
      content.some(
        (block) =>
          block.type === "text" && block.text === "Keep this ordinary question",
      ),
    ),
  ).toBe(true);
  expect(messages.some(({ source }) => source?.kind === "stock-approval")).toBe(
    false,
  );
});

it("settles a claimed approval if another host hook blocks its turn", async () => {
  const h = await setup();
  h.agent.ctx.on("agent/pre-step", async () => ({ kind: "reject" }));
  await expect(
    requestBackgroundApproval(h.ctx.approval, h.request()),
  ).resolves.toBe("cancelled");
  await h.agent.whenIdle();
  expect(h.adapter.requests).toHaveLength(0);
  expect(h.agent.inbox.nextTurn).toEqual([]);
});

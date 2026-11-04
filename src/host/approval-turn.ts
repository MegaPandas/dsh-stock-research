import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalService,
} from "@deepseek-ai/dsh-user-approval";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "stock-approval": { kind: "stock-approval" } & ContextFormed;
  }
}

const ownerTurns = new WeakMap<Agent, Promise<void>>();

/** Background work borrows a real owner turn for the native durable audit pair. */
export function requestBackgroundApproval(
  approval: Pick<ApprovalService, "request">,
  request: ApprovalRequest & { signal: AbortSignal },
): Promise<ApprovalOutcome> {
  const { agent, signal } = request;
  signal.throwIfAborted();
  const previous = ownerTurns.get(agent) ?? agent.whenIdle();
  let onAbort!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(resolve, reject);
  }).finally(() => signal.removeEventListener("abort", onAbort));
  const work = ready.then(() => requestApprovalTurn(approval, request));
  // Rejected pre-steps park pending turns in the SDK. Send the next control only
  // after its predecessor's driver drains, while returning its decision promptly.
  const drained = Promise.allSettled([previous, work]).then(() =>
    agent.whenIdle(),
  );
  ownerTurns.set(agent, drained);
  const release = () => {
    if (ownerTurns.get(agent) === drained) ownerTurns.delete(agent);
  };
  void drained.then(release, release);
  return work;
}

function requestApprovalTurn(
  approval: Pick<ApprovalService, "request">,
  request: ApprovalRequest & { signal: AbortSignal },
): Promise<ApprovalOutcome> {
  const { agent, signal } = request;
  signal.throwIfAborted();
  const message = createUserMessage({
    source: { kind: "stock-approval" },
    content: [{ type: "text", text: "Background public search approval." }],
  });
  let claimedTurn: number | undefined;
  let releaseStep!: () => void;
  let releaseDiscard!: () => void;
  let releaseClaim!: () => void;
  let releaseEnd!: () => void;
  let releaseError!: () => void;
  let onAbort!: () => void;
  const work = new Promise<ApprovalOutcome>((resolve, reject) => {
    releaseStep = agent.ctx.on("agent/pre-step", async (payload, next) => {
      if (!payload.messages.some(({ id }) => id === message.id)) return next();
      try {
        const outcome = await approval.request({
          ...request,
          signal: AbortSignal.any([signal, payload.signal]),
        });
        resolve(outcome);
      } catch (cause) {
        reject(cause);
      }
      if (payload.messages.every(({ id }) => id === message.id))
        return { kind: "reject" };
      const decision = await next();
      if (decision.kind === "reject") return decision;
      const messages = decision.messages.filter(({ id }) => id !== message.id);
      return messages.length === 0
        ? { kind: "reject" }
        : { ...decision, messages };
    });
    releaseDiscard = agent.ctx.on("agent/inbox/discarded", (payload) => {
      if (payload.message.id === message.id) resolve("cancelled");
    });
    releaseClaim = agent.ctx.on("agent/inbox/claimed", (payload) => {
      if (payload.message.id === message.id) claimedTurn = payload.turn;
    });
    releaseEnd = agent.ctx.on("session/event", (session, event) => {
      if (
        session === agent.session &&
        event.type === "turn/end" &&
        event.data.turn === claimedTurn
      )
        resolve("cancelled");
    });
    releaseError = agent.ctx.on("agent/error", (payload) => {
      if (payload.turn === claimedTurn) reject(payload.error);
    });
    onAbort = () => {
      if (claimedTurn === undefined) reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    agent.followup(message);
  });
  return work.finally(() => {
    releaseStep();
    releaseDiscard();
    releaseClaim();
    releaseEnd();
    releaseError();
    signal.removeEventListener("abort", onAbort);
    agent.inbox.remove(message.id);
  });
}

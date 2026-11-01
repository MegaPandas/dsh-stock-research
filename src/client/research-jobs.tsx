import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { IJobs } from "@deepseek-ai/dsh-api-job-controller/client";
import type {
  ConversationMatch,
  ConversationNodeDefinitionInput,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatNodeViewProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import { JobId } from "@deepseek-ai/dsh-jobs/brand";
import type { JobRegisteredData, JobSettledData } from "@deepseek-ai/dsh-jobs";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { ResearchCardView } from "./ResearchCardView.js";
import { researchLog } from "./research-log.js";
import { RESEARCH_JOB_KIND } from "../contracts/research-progress.js";

export interface ResearchCardData {
  readonly anchorSeq: number;
  readonly jobId: JobId;
  readonly registration?: JobRegisteredData;
  readonly settlement?: JobSettledData;
}

declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap {
    "stock-research-job": ResearchCardData;
  }
}

function applyEvent(
  previous: ResearchCardData | undefined,
  event: ConversationMatch["event"],
): ResearchCardData {
  const anchorSeq = previous?.anchorSeq ?? event.seq;
  switch (event.type) {
    case "job/registered":
      return {
        ...previous,
        anchorSeq,
        jobId: event.data.jobId,
        registration: event.data,
      };
    case "job/settled":
      return {
        ...previous,
        anchorSeq,
        jobId: event.data.jobId,
        settlement: event.data,
      };
    default:
      throw new Error(`Unexpected research card event: ${event.type}`);
  }
}

export const researchJobDefinition: ConversationNodeDefinitionInput<ResearchCardData> =
  {
    kind: "stock-research-job",
    target: "chat",
    match(event) {
      if (
        (event.type === "job/registered" || event.type === "job/settled") &&
        event.data.kind === RESEARCH_JOB_KIND
      )
        return { id: String(event.data.jobId), role: "start" };
      return null;
    },
    start: (_context, match) => applyEvent(undefined, match.event),
    update: (context, match) => applyEvent(context.state, match.event),
    buildViewNode(context) {
      if (context.state === undefined) return null;
      return {
        key: context.key,
        id: context.id,
        kind: "stock-research-job",
        target: "chat",
        anchorSeq: context.state.anchorSeq,
        location: { kind: "session" },
        visibility: "visible",
        data: context.state,
      };
    },
  };

export interface ResearchJobCardProps {
  data: ResearchCardData;
  sessionId: SessionId;
  jobs: IJobs;
}

function elapsed(startedAt: number, finishedAt: number): string {
  const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function OperationObservation({
  jobs,
  sessionId,
  jobId,
}: {
  jobs: Pick<IJobs, "observe">;
  sessionId: SessionId;
  jobId: JobId;
}) {
  useEffect(() => jobs.observe(sessionId, jobId), [jobs, sessionId, jobId]);
  return null;
}

export function ResearchJobCard({
  data,
  sessionId,
  jobs,
}: ResearchJobCardProps) {
  const snapshot = useSyncExternalStore(
    (listener) => jobs.state.subscribe(listener),
    () => jobs.state.getSnapshot(),
  );
  const owner = data.registration?.owner ?? data.settlement?.owner;
  const owned = owner === sessionId;
  const rows = owned ? (snapshot.rows[sessionId] ?? []) : [];
  const row = rows.find(({ id }) => id === data.jobId);
  const parentText = owned ? (snapshot.observed[data.jobId]?.text ?? "") : "";
  const output = useMemo(() => researchLog(parentText), [parentText]);
  const progress = output.progress;
  const state = progress?.state;
  const operationIds = state?.operationIds.map(JobId) ?? [];
  const observedIds = operationIds.filter((id) =>
    rows.some((row) => row.id === id),
  );
  const liveRows = rows.filter((job) => operationIds.includes(job.id));
  const observations = owned
    ? [data.jobId, ...operationIds].flatMap((id) => {
        const observation = snapshot.observed[id];
        return observation === undefined ? [] : [observation];
      })
    : [];
  const nativeStatus = data.settlement?.status ?? row?.status;
  const terminal =
    nativeStatus === "completed" ||
    nativeStatus === "killed" ||
    nativeStatus === "failed";
  const status =
    terminal || nativeStatus === "stopping"
      ? nativeStatus
      : nativeStatus === "running" && state?.status === "completed"
        ? "finishing"
        : nativeStatus === "running" && state?.status === "cancelled"
          ? "stopping"
          : (state?.status ?? nativeStatus ?? "reconnecting");
  const running =
    status === "running" ||
    status === "finishing" ||
    status === "stopping" ||
    status === "preparing" ||
    status === "active" ||
    status === "blocked";
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();

  useEffect(() => {
    if (!owned) return;
    return jobs.watchRows(sessionId);
  }, [jobs, sessionId, owned]);
  const parentPresent = row !== undefined;
  useEffect(() => {
    if (!owned || !parentPresent) return;
    return jobs.observe(sessionId, data.jobId);
  }, [jobs, sessionId, owned, parentPresent, data.jobId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const title =
    data.registration?.label ??
    data.settlement?.label ??
    row?.label ??
    "股票研究";
  const startedAt =
    data.registration?.startedAt ??
    data.settlement?.startedAt ??
    row?.startedAt;
  const finishedAt = data.settlement?.finishedAt ?? row?.finishedAt;
  const detail = data.settlement?.detail ?? row?.detail;
  async function cancel() {
    setCancelling(true);
    setCancelError(undefined);
    try {
      const result = await jobs.kill(sessionId, data.jobId);
      if (!result.ok) setCancelError(result.error.message);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      {observedIds.map((id) => (
        <OperationObservation
          key={id}
          jobs={jobs}
          sessionId={sessionId}
          jobId={id}
        />
      ))}
      <ResearchCardView
        title={title}
        status={status}
        state={state}
        progress={
          terminal && state?.phase.kind !== "ended"
            ? undefined
            : (progress?.text ?? row?.progress)
        }
        elapsed={
          startedAt === undefined
            ? undefined
            : elapsed(startedAt, finishedAt ?? now)
        }
        detail={detail}
        canCancel={owned && running && status !== "finishing"}
        cancelling={cancelling}
        cancelError={cancelError}
        cancel={() => void cancel()}
        operations={liveRows}
        observations={observations}
        parentLog={{ jobId: data.jobId, output }}
      />
    </>
  );
}

export function registerResearchJobs(ctx: Context): void {
  // The SDK merges server JobRegistry and client IJobs onto the same Context.
  // This registration runs in the browser and consumes the native client service.
  const jobs = ctx.jobs as unknown as IJobs;
  ctx.effect(() => ctx.uiConversation.events.register(researchJobDefinition));
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      {
        name: "conversation.chat.node",
        key: "stock-research-job",
        inject: (sessionId) => ({ taskSessionId: sessionId as SessionId }),
      },
      ({
        node,
        taskSessionId,
      }: Pick<ChatNodeViewProps<"stock-research-job">, "node"> & {
        taskSessionId: SessionId;
      }) => (
        <ResearchJobCard
          data={node.data}
          sessionId={taskSessionId}
          jobs={jobs}
        />
      ),
    ),
  );
}

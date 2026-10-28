import { useEffect, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { IJobs } from "@deepseek-ai/dsh-api-job-controller/client";
import type {
  ConversationMatch,
  ConversationNodeDefinitionInput,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatNodeViewProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { JobId } from "@deepseek-ai/dsh-jobs/brand";
import type { JobRegisteredData, JobSettledData } from "@deepseek-ai/dsh-jobs";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { CommandExecution } from "@deepseek-ai/dsh-commands";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { ResearchCardView } from "./ResearchCardView.js";
import {
  RESEARCH_JOB_KIND,
  type ResearchActivity,
  type ResearchJobResult,
} from "../app/research-job.js";

export interface ResearchCardData {
  readonly anchorSeq: number;
  readonly jobId: JobId;
  readonly registration?: JobRegisteredData;
  readonly settlement?: JobSettledData;
  readonly result?: ResearchJobResult;
  readonly activity?: ResearchActivity;
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
    case "stock-research/result":
      return {
        ...previous,
        anchorSeq,
        jobId: event.data.jobId,
        result: event.data,
      };
    case "stock-research/activity":
      return {
        ...previous,
        anchorSeq,
        jobId: event.data.jobId,
        activity: event.data,
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
      if (
        event.type === "stock-research/result" ||
        event.type === "stock-research/activity"
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
  cancelRun(sessionId: SessionId, runId: string): Promise<void>;
}

function elapsed(startedAt: number, finishedAt: number): string {
  const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function ResearchJobCard({
  data,
  sessionId,
  jobs,
  cancelRun,
}: ResearchJobCardProps) {
  const snapshot = useSyncExternalStore(
    (listener) => jobs.state.subscribe(listener),
    () => jobs.state.getSnapshot(),
  );
  const activity = data.activity;
  const owner =
    activity?.owner ?? data.registration?.owner ?? data.settlement?.owner;
  const owned = owner === sessionId;
  const row = owned
    ? snapshot.rows[sessionId]?.find(({ id }) => id === data.jobId)
    : undefined;
  const operationIds = activity?.operationIds ?? [data.jobId];
  const operationKey = operationIds.join("\n");
  const liveRows = owned
    ? (snapshot.rows[sessionId] ?? []).filter((job) =>
        operationIds.includes(job.id),
      )
    : [];
  const observations = owned
    ? operationIds.flatMap((id) => {
        const observation = snapshot.observed[id];
        return observation === undefined ? [] : [observation];
      })
    : [];
  const status =
    (activity?.status === "preparing" && row?.status === "stopping"
      ? "stopping"
      : activity?.status) ??
    data.settlement?.status ??
    (data.result === undefined
      ? (row?.status ?? "reconnecting")
      : data.result.outcome === "success"
        ? "completed"
        : "failed");
  const running =
    status === "running" ||
    status === "stopping" ||
    status === "preparing" ||
    status === "active" ||
    status === "blocked";
  const shouldObserve = running || status === "reconnecting";
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();

  useEffect(() => {
    if (!owned || !shouldObserve || operationIds.length === 0) return;
    const unwatch = jobs.watchRows(sessionId);
    const unobserve = operationIds.map((id) => jobs.observe(sessionId, id));
    return () => {
      for (const release of unobserve) release();
      unwatch();
    };
  }, [jobs, sessionId, owned, shouldObserve, operationKey]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const title =
    activity?.label ??
    data.registration?.label ??
    data.settlement?.label ??
    row?.label ??
    "股票研究";
  const startedAt =
    activity?.startedAt ??
    data.registration?.startedAt ??
    data.settlement?.startedAt ??
    row?.startedAt;
  const finishedAt =
    activity === undefined
      ? (data.settlement?.finishedAt ?? row?.finishedAt)
      : activity.finishedAt;
  const detail =
    activity === undefined
      ? (data.settlement?.detail ?? row?.detail)
      : undefined;
  const progress =
    activity?.status === "preparing"
      ? (row?.progress ?? activity.progress)
      : (activity?.progress ?? row?.progress);
  async function cancel() {
    setCancelling(true);
    setCancelError(undefined);
    try {
      if (activity?.runId !== undefined)
        await cancelRun(sessionId, activity.runId);
      else {
        const result = await jobs.kill(sessionId, data.jobId);
        if (!result.ok) setCancelError(result.error.message);
      }
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <ResearchCardView
      title={title}
      status={status}
      progress={progress}
      elapsed={
        startedAt === undefined
          ? undefined
          : elapsed(startedAt, finishedAt ?? now)
      }
      detail={detail}
      result={data.result?.text}
      canCancel={owned && running}
      cancelling={cancelling}
      cancelError={cancelError}
      cancel={() => void cancel()}
      operations={activity && activity.status !== "preparing" ? liveRows : []}
      observations={observations}
    />
  );
}

export function registerResearchJobs(ctx: Context): void {
  const jobs = ctx.jobs as unknown as IJobs;
  const remote = ctx.remote as unknown as {
    commands: {
      execute(
        sessionId: SessionId,
        line: string,
        attachments: readonly [],
      ): Promise<RemoteResult<CommandExecution | undefined>>;
    };
  };
  const cancelRun = async (
    sessionId: SessionId,
    runId: string,
  ): Promise<void> => {
    const result = await remote.commands.execute(
      sessionId,
      `/stock-cancel ${runId}`,
      [],
    );
    if (!result.ok) throw result.error;
    if (result.value === undefined) throw new Error("取消研究命令不可用。");
    if (result.value.result.kind === "error")
      throw new Error(result.value.result.text);
  };
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
          cancelRun={cancelRun}
        />
      ),
    ),
  );
}

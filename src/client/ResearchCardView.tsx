import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ObservedJob } from "@deepseek-ai/dsh-api-job-controller/client";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";
import { researchCardStyles } from "./research-card-styles.js";
import { collectionCounts } from "./research-log.js";
import { ResearchDetails } from "./ResearchDetails.js";
import { ResearchChives } from "./ResearchChives.js";

export type ResearchCardStatus =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed"
  | "reconnecting"
  | "preparing"
  | "active"
  | "blocked"
  | "cancelled";

interface ResearchCardViewProps {
  title: string;
  status: ResearchCardStatus;
  progress: string | undefined;
  elapsed: string | undefined;
  detail: string | undefined;
  result: string | undefined;
  canCancel: boolean;
  cancelling: boolean;
  cancelError: string | undefined;
  cancel(): void;
  operations: readonly JobView[];
  observations: readonly ObservedJob[];
}

const labels: Record<ResearchCardStatus, string> = {
  running: "进行中",
  stopping: "正在取消",
  completed: "已完成",
  killed: "已取消",
  failed: "执行失败",
  reconnecting: "正在连接",
  preparing: "准备数据",
  active: "进行中",
  blocked: "需要处理",
  cancelled: "已取消",
};

function Icon({
  kind,
  size = 16,
}: {
  kind:
    "research" | "check" | "close" | "warning" | "chevron" | "clock" | "pause";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "research" && (
        <>
          <path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h3" />
          <path d="M3 8h2M3 12h2M3 16h2" />
        </>
      )}
      {kind === "check" && <path d="m6 12 4 4 8-8" />}
      {kind === "close" && <path d="m7 7 10 10M17 7 7 17" />}
      {kind === "warning" && (
        <>
          <path d="m12 4 9 16H3L12 4Z" />
          <path d="M12 9v4M12 16h.01" />
        </>
      )}
      {kind === "chevron" && <path d="m9 5 7 7-7 7" />}
      {kind === "clock" && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </>
      )}
      {kind === "pause" && <path d="M9 7v10M15 7v10" />}
    </svg>
  );
}

const stageNames: Record<string, string> = {
  analysis: "分析报告",
  "digest.analysis": "分析摘要",
  "debate.1": "第一轮多空讨论",
  "digest.debate.1": "第一轮讨论摘要",
  "debate.2": "第二轮多空讨论",
  "digest.debate.2": "第二轮讨论摘要",
  "manager.research": "研究计划",
  "digest.plan": "计划摘要",
  risk: "风险评估",
  "digest.risk": "风险摘要",
  "manager.decision": "投资决策",
};
function displayProgress(progress: string | undefined) {
  return progress?.replace(
    /(等待主\s*Agent\s*验收[：:]\s*)([\w.]+)/,
    (_whole, prefix: string, stage: string) =>
      `${prefix}${stageNames[stage] ?? stage}`,
  );
}

const RESULT_PREVIEW_LINES = 6;

function ResearchResult({ text }: { text: string }) {
  const id = useId();
  const content = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = content.current!;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      setOverflowing(
        element.scrollHeight > lineHeight * RESULT_PREVIEW_LINES + 1,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="sr-research-result">
      <pre
        ref={content}
        id={id}
        className="sr-research-result-text"
        style={
          expanded ? undefined : { maxHeight: `${RESULT_PREVIEW_LINES}lh` }
        }
      >
        {text}
      </pre>
      {overflowing && (
        <button
          type="button"
          className="sr-research-action sr-research-expand"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起结果" : "展开结果"}
          <Icon kind="chevron" size={12} />
        </button>
      )}
    </div>
  );
}

export function ResearchCardView(props: ResearchCardViewProps) {
  const {
    title,
    status,
    progress,
    elapsed,
    detail,
    result,
    canCancel,
    cancelling,
    cancelError,
    operations,
    observations,
  } = props;
  const heading =
    /^(.+?)\s*·\s*(快速研究|深度研究|Quick|Deep)\s*·\s*(\d{4}-\d{2}-\d{2})$/.exec(
      title,
    );
  const stopping = status === "stopping" || (canCancel && cancelling);
  const waiting =
    !stopping &&
    (status === "active" || status === "running") &&
    /等待.*验收/.test(progress ?? "");
  const live =
    !stopping &&
    !waiting &&
    (status === "active" || status === "running" || status === "preparing");
  const tone =
    stopping || status === "killed" || status === "cancelled"
      ? "neutral"
      : status === "completed"
        ? "success"
        : status === "failed"
          ? "danger"
          : status === "blocked" || waiting
            ? "warning"
            : "accent";
  const icon =
    stopping || status === "cancelled" || status === "killed"
      ? "close"
      : status === "completed"
        ? "check"
        : status === "failed" || status === "blocked"
          ? "warning"
          : waiting
            ? "pause"
            : status === "reconnecting"
              ? "clock"
              : "research";
  const counts = collectionCounts(progress);
  const primaryProgress = counts ? "采集研究数据" : displayProgress(progress);
  const technicalProgress =
    counts !== undefined || primaryProgress !== progress;
  const hasDetails =
    technicalProgress ||
    operations.length > 0 ||
    observations.some((entry) => entry.text || entry.gapBefore);
  const mode =
    heading?.[2] === "Quick"
      ? "快速研究"
      : heading?.[2] === "Deep"
        ? "深度研究"
        : heading?.[2];
  const hasBody =
    primaryProgress ||
    detail ||
    result ||
    cancelError ||
    observations.some((entry) => entry.error);

  return (
    <section
      aria-label={`调研任务：${title}`}
      className="sr-research-card"
      data-tone={tone}
      data-live={live}
    >
      <style>{researchCardStyles}</style>
      <header className="sr-research-header">
        <div className="sr-research-masthead">
          <span className="sr-research-eyebrow">
            <Icon kind="research" size={15} />
            股票研究
          </span>
          <span role="status" aria-live="polite" className="sr-research-status">
            {live ? (
              <span className="sr-research-signal" />
            ) : (
              <Icon kind={icon} size={13} />
            )}
            {stopping ? labels.stopping : waiting ? "等待验收" : labels[status]}
          </span>
        </div>
        <div className="sr-research-overview">
          <div className="sr-research-identity">
            <h3 className="sr-research-title">{heading?.[1] ?? title}</h3>
            {(mode || heading?.[3]) && (
              <div className="sr-research-meta">
                {mode && <span className="sr-research-mode">{mode}</span>}
                {heading?.[3] && (
                  <time dateTime={heading[3]}>{heading[3]}</time>
                )}
              </div>
            )}
          </div>
          <ResearchChives growing={live} />
          {elapsed && (
            <span className="sr-research-elapsed">用时 {elapsed}</span>
          )}
        </div>
      </header>
      {hasBody && (
        <div className="sr-research-body">
          {primaryProgress && (
            <div className="sr-research-progress-heading">
              <span className="sr-research-progress-label">
                {primaryProgress}
              </span>
              {counts && (
                <span className="sr-research-count">
                  <strong>{counts.completed}</strong>
                  <span> / {counts.total} 项</span>
                </span>
              )}
            </div>
          )}
          {counts && (
            <>
              <div
                role="progressbar"
                aria-label="数据采集进度"
                aria-valuemin={0}
                aria-valuemax={counts.total}
                aria-valuenow={counts.completed}
                aria-valuetext={`已处理 ${counts.completed} / ${counts.total} 项`}
                className="sr-research-track"
              >
                <div
                  className="sr-research-fill"
                  style={{
                    transform: `scaleX(${counts.completed / counts.total})`,
                  }}
                />
              </div>
              <div className="sr-research-stats">
                {counts.succeeded !== undefined && (
                  <span>
                    <Icon kind="check" size={13} />
                    {counts.succeeded} 项已就绪
                  </span>
                )}
                {counts.missing !== undefined && counts.missing > 0 && (
                  <span className="sr-research-missing">
                    <Icon kind="warning" size={13} />
                    {counts.missing} 项缺失
                  </span>
                )}
              </div>
            </>
          )}
          {detail && <p className="sr-research-detail">{detail}</p>}
          {cancelError && (
            <p role="alert" className="sr-research-alert">
              取消失败：{cancelError}
            </p>
          )}
          {observations
            .filter((entry) => entry.error)
            .map((entry) => (
              <p role="alert" className="sr-research-alert" key={entry.jobId}>
                任务进度连接失败：{entry.error}
              </p>
            ))}
          {result && <ResearchResult text={result} />}
        </div>
      )}
      {(hasDetails || canCancel) && (
        <footer className="sr-research-footer">
          {hasDetails && (
            <details className="sr-research-details">
              <summary className="sr-research-action">
                <Icon kind="chevron" size={12} />
                查看详情
              </summary>
              <ResearchDetails
                progress={technicalProgress ? progress : undefined}
                operations={operations}
                observations={observations}
              />
            </details>
          )}
          {canCancel && (
            <button
              type="button"
              className="sr-research-action sr-research-cancel"
              disabled={stopping}
              onClick={props.cancel}
            >
              <Icon kind="close" size={13} />
              {stopping ? "正在取消…" : "取消调研"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

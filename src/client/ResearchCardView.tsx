import type { CSSProperties } from "react";
import type { ObservedJob } from "@deepseek-ai/dsh-api-job-controller/client";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";

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
const color = {
  primary: "var(--dsw-alias-label-primary, #20242c)",
  secondary: "var(--dsw-alias-label-secondary, #656d7c)",
  tertiary: "var(--dsw-alias-label-tertiary, #8b919c)",
  border: "var(--dsw-alias-border-l2, #e7e9ee)",
  background: "var(--dsw-alias-bg-base, #fff)",
  layer: "var(--dsw-alias-bg-layer-1, #f7f8fa)",
  accent: "var(--dsw-alias-label-deep-diving, #4d6bfe)",
};
const styles = {
  root: {
    width: "100%",
    maxWidth: 780,
    boxSizing: "border-box",
    marginBlock: 12,
    border: `1px solid ${color.border}`,
    borderRadius: 14,
    background: color.background,
    color: color.primary,
    font: "inherit",
    fontSize: "var(--dsh-content-font-size-secondary, 13px)",
    lineHeight: 1.55,
    minWidth: 0,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "18px 18px 0",
  },
  icon: {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: 11,
    display: "grid",
    placeItems: "center",
    color: color.accent,
    background: `color-mix(in srgb, ${color.accent} 8%, transparent)`,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "5px 8px",
  },
  title: {
    font: "inherit",
    fontSize: "calc(15px + var(--dsh-content-font-delta, 0px))",
    fontWeight: 650,
    letterSpacing: ".01em",
    margin: 0,
    overflowWrap: "anywhere",
  },
  mode: {
    fontSize: ".82em",
    fontWeight: 500,
    color: color.secondary,
    border: `1px solid ${color.border}`,
    borderRadius: 5,
    padding: "0 6px",
    lineHeight: "20px",
    whiteSpace: "nowrap",
  },
  meta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0 8px",
    marginTop: 4,
    color: color.tertiary,
    fontSize: ".88em",
    fontVariantNumeric: "tabular-nums",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginLeft: "auto",
    flexShrink: 0,
    padding: "3px 8px",
    borderRadius: 6,
    fontSize: ".85em",
    whiteSpace: "nowrap",
    color: color.secondary,
    background: color.layer,
  },
  body: { padding: "17px 18px 15px" },
  progressHeading: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "4px 12px",
    marginBottom: 9,
  },
  caption: {
    fontSize: ".92em",
    color: color.secondary,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  track: {
    height: 5,
    borderRadius: 999,
    background: color.layer,
    overflow: "hidden",
  },
  stats: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "5px 16px",
    marginTop: 9,
    fontSize: ".9em",
    color: color.secondary,
  },
  dot: {
    width: 6,
    height: 6,
    flexShrink: 0,
    borderRadius: "50%",
    display: "inline-block",
  },
  footer: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    padding: "10px 18px",
    borderTop: `1px solid ${color.border}`,
  },
  summary: {
    width: "fit-content",
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: color.secondary,
    listStyle: "none",
    cursor: "pointer",
    paddingBlock: 2,
    fontSize: ".9em",
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    background: "transparent",
    border: 0,
    padding: "2px 0 2px 8px",
    color: color.secondary,
    font: "inherit",
    fontSize: ".9em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  pre: {
    margin: "10px 0 0",
    padding: "10px 12px",
    borderRadius: 8,
    background: color.layer,
    color: color.secondary,
    fontSize: ".87em",
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  alert: {
    margin: "10px 0 0",
    padding: "9px 11px",
    borderRadius: 8,
    background: "color-mix(in srgb, #e05252 7%, transparent)",
    border: "1px solid color-mix(in srgb, #e05252 20%, transparent)",
    fontSize: ".92em",
    overflowWrap: "anywhere",
  },
} satisfies Record<string, CSSProperties>;

function Icon({
  kind,
  size = 18,
}: {
  kind: "research" | "check" | "close" | "warning" | "chevron";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "research" && (
        <>
          <path d="M4 19V5M4 19h16" />
          <path d="m8 14 4-5 3 2 5-6" />
          <path d="M16 5h4v4" />
        </>
      )}
      {kind === "check" && <path d="m6 12 4 4 8-8" />}
      {kind === "close" && (
        <>
          <path d="m7 7 10 10" />
          <path d="m17 7-10 10" />
        </>
      )}
      {kind === "warning" && (
        <>
          <path d="m12 4 9 16H3L12 4Z" />
          <path d="M12 9v4M12 16h.01" />
        </>
      )}
      {kind === "chevron" && <path d="m9 5 7 7-7 7" />}
    </svg>
  );
}

function collectionCounts(progress: string | undefined) {
  const match =
    /^采集数据\s+(\d+)\/(\d+)(?:\s*·\s*成功\s*(\d+)[，,]\s*缺失\s*(\d+))?/.exec(
      progress ?? "",
    );
  if (match === null || Number(match[2]) === 0) return undefined;
  return {
    completed: Number(match[1]),
    total: Number(match[2]),
    succeeded: match[3] === undefined ? undefined : Number(match[3]),
    missing: match[4] === undefined ? undefined : Number(match[4]),
  };
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
  const counts = collectionCounts(progress);
  const waiting =
    (status === "active" || status === "running") &&
    /等待.*验收/.test(progress ?? "");
  const tone =
    status === "completed"
      ? "#22976b"
      : status === "failed"
        ? "#da5656"
        : status === "blocked" || waiting
          ? "#bd8a2c"
          : status === "killed" || status === "cancelled"
            ? color.tertiary
            : color.accent;
  const icon =
    status === "completed"
      ? "check"
      : status === "failed" || status === "blocked"
        ? "warning"
        : status === "cancelled" || status === "killed"
          ? "close"
          : "research";
  const primaryProgress = counts ? "采集研究数据" : displayProgress(progress);
  const technicalProgress =
    counts !== undefined || primaryProgress !== progress;
  const hasDetails =
    technicalProgress ||
    operations.length > 0 ||
    observations.some((entry) => entry.text);
  const mode =
    heading?.[2] === "Quick"
      ? "快速研究"
      : heading?.[2] === "Deep"
        ? "深度研究"
        : heading?.[2];

  return (
    <section aria-label={`调研任务：${title}`} style={styles.root}>
      <header style={styles.header}>
        <span
          style={{
            ...styles.icon,
            color: tone,
            background: `color-mix(in srgb, ${tone} 8%, transparent)`,
          }}
        >
          <Icon kind={icon} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={styles.titleRow}>
            <h3 style={styles.title}>{heading?.[1] ?? title}</h3>
            {mode && <span style={styles.mode}>{mode}</span>}
          </div>
          <div style={styles.meta}>
            {heading?.[3] && <span>{heading[3]}</span>}
            {heading?.[3] && elapsed && <span aria-hidden="true">·</span>}
            {elapsed && <span>用时 {elapsed}</span>}
          </div>
        </div>
        <span role="status" aria-live="polite" style={styles.badge}>
          <span style={{ ...styles.dot, background: tone }} />
          {waiting ? "等待验收" : labels[status]}
        </span>
      </header>
      <div style={styles.body}>
        {primaryProgress && (
          <div style={styles.progressHeading}>
            <span style={{ fontWeight: 500 }}>{primaryProgress}</span>
            {counts && (
              <span style={styles.caption}>
                {counts.completed}{" "}
                <span style={{ color: color.tertiary }}>
                  / {counts.total} 项
                </span>
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
              style={styles.track}
            >
              <div
                style={{
                  height: "100%",
                  width: `${(counts.completed / counts.total) * 100}%`,
                  borderRadius: "inherit",
                  background: color.accent,
                }}
              />
            </div>
            <div style={styles.stats}>
              {counts.succeeded !== undefined && (
                <span>
                  <span
                    style={{
                      ...styles.dot,
                      background: "#22976b",
                      marginRight: 6,
                    }}
                  />
                  {counts.succeeded} 项已就绪
                </span>
              )}
              {counts.missing !== undefined && counts.missing > 0 && (
                <span>
                  <span
                    style={{
                      ...styles.dot,
                      background: "#bd8a2c",
                      marginRight: 6,
                    }}
                  />
                  {counts.missing} 项缺失
                </span>
              )}
              <span style={{ color: color.tertiary }}>
                采集完成后由主 Agent 检查数据覆盖
              </span>
            </div>
          </>
        )}
        {detail && (
          <p
            style={{
              margin: "8px 0 0",
              color: color.secondary,
              overflowWrap: "anywhere",
            }}
          >
            {detail}
          </p>
        )}
        {cancelError && (
          <p role="alert" style={styles.alert}>
            取消失败：{cancelError}
          </p>
        )}
        {observations
          .filter((observation) => observation.error)
          .map((observation) => (
            <p role="alert" style={styles.alert} key={observation.jobId}>
              任务进度连接失败：{observation.error}
            </p>
          ))}
        {result && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              font: "inherit",
              lineHeight: 1.7,
              margin: "12px 0 0",
            }}
          >
            {result}
          </pre>
        )}
      </div>
      {(hasDetails || canCancel) && (
        <footer style={styles.footer}>
          {hasDetails ? (
            <details style={{ minWidth: 0, flex: 1 }}>
              <summary style={styles.summary}>
                <Icon kind="chevron" size={12} />
                查看详情
              </summary>
              <div
                style={{
                  paddingBlock: "8px 4px",
                  color: color.secondary,
                  overflowWrap: "anywhere",
                }}
              >
                {technicalProgress && (
                  <p style={{ margin: 0, fontSize: ".9em" }}>{progress}</p>
                )}
                {operations.map((operation) => (
                  <p
                    key={operation.id}
                    style={{ margin: "6px 0 0", fontSize: ".9em" }}
                  >
                    {operation.label}
                    {operation.progress ? ` · ${operation.progress}` : ""}
                  </p>
                ))}
                {observations.some((observation) => observation.gapBefore) && (
                  <p style={{ margin: "8px 0 0", fontSize: ".9em" }}>
                    这里只显示最近的日志。
                  </p>
                )}
                {observations.some((observation) => observation.text) && (
                  <pre style={styles.pre}>
                    {observations
                      .map((observation) => observation.text)
                      .join("\n")}
                  </pre>
                )}
              </div>
            </details>
          ) : (
            <span />
          )}
          {canCancel && (
            <button
              type="button"
              disabled={status === "stopping" || cancelling}
              onClick={props.cancel}
              style={{
                ...styles.button,
                opacity: status === "stopping" || cancelling ? 0.55 : 1,
                cursor:
                  status === "stopping" || cancelling ? "default" : "pointer",
              }}
            >
              <Icon kind="close" size={13} />
              {status === "stopping" || cancelling ? "正在取消…" : "取消调研"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

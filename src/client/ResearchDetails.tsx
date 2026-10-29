import { useId, useMemo, useState } from "react";
import type { ObservedJob } from "@deepseek-ai/dsh-api-job-controller/client";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";
import { researchLog, type ResearchLogEntry } from "./research-log.js";

const LOG_PREVIEW_ENTRIES = 6;
const operationLabels: Record<JobView["status"], string> = {
  running: "进行中",
  stopping: "正在取消",
  completed: "已完成",
  killed: "已取消",
  failed: "执行失败",
};

function LogEntry({ entry }: { entry: ResearchLogEntry }) {
  return (
    <li className="sr-log-entry" data-kind={entry.kind}>
      <span className="sr-log-mark" aria-hidden="true">
        {entry.kind === "diagnostic"
          ? "!"
          : entry.kind === "record"
            ? "↳"
            : "·"}
      </span>
      <div className="sr-log-entry-body">
        {entry.kind === "diagnostic" ? (
          <>
            <div className="sr-log-entry-heading">
              <span className="sr-log-category">来源诊断</span>
              <span className="sr-log-source">{entry.source}</span>
              {entry.datasets.length > 1 && (
                <span className="sr-log-occurrences">
                  {entry.datasets.length} 条
                </span>
              )}
            </div>
            <div className="sr-log-datasets">
              {entry.datasets.map((dataset, index) => (
                <code key={index}>{dataset}</code>
              ))}
            </div>
            <p className="sr-log-description">{entry.message}</p>
          </>
        ) : entry.kind === "record" ? (
          <>
            <span className="sr-log-category">采集记录</span>
            <code className="sr-log-path">{entry.path}</code>
          </>
        ) : (
          <p className="sr-log-message">{entry.text}</p>
        )}
      </div>
    </li>
  );
}

function LogStream({
  observation,
  label,
  raw,
}: {
  observation: ObservedJob;
  label: string | undefined;
  raw: boolean;
}) {
  const { collection, entries } = useMemo(
    () => researchLog(observation.text),
    [observation.text],
  );
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const earlierCount = Math.max(0, entries.length - LOG_PREVIEW_ENTRIES);
  const firstEntry = expanded ? 0 : earlierCount;
  return (
    <div className="sr-log-stream">
      {label && <p className="sr-log-stream-name">{label}</p>}
      {observation.gapBefore && (
        <p className="sr-log-notice">这里只显示最近的日志。</p>
      )}
      {raw ? (
        <pre
          className="sr-log-raw"
          tabIndex={0}
          aria-label={label ? `${label}原始日志` : "原始日志"}
        >
          {observation.text}
        </pre>
      ) : (
        <>
          {collection && (
            <div className="sr-log-collection">
              <div className="sr-log-collection-heading">
                <span>数据采集</span>
                <span>最近一次输出</span>
              </div>
              <dl className="sr-log-metrics">
                <div>
                  <dt>已处理</dt>
                  <dd>
                    {collection.completed}
                    <small> / {collection.total}</small>
                  </dd>
                </div>
                {collection.succeeded !== undefined && (
                  <div>
                    <dt>已就绪</dt>
                    <dd>{collection.succeeded}</dd>
                  </div>
                )}
                {collection.missing !== undefined && (
                  <div>
                    <dt>缺失</dt>
                    <dd>{collection.missing}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
          {earlierCount > 0 && (
            <button
              type="button"
              className="sr-research-action sr-log-earlier"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起较早记录" : `显示更早的 ${earlierCount} 条记录`}
            </button>
          )}
          <ol
            className="sr-log-entries"
            id={listId}
            aria-label={label ? `${label}运行记录` : "运行记录"}
          >
            {entries.slice(firstEntry).map((entry, index) => (
              <LogEntry key={firstEntry + index} entry={entry} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function ResearchDetails({
  progress,
  operations,
  observations,
}: {
  progress: string | undefined;
  operations: readonly JobView[];
  observations: readonly ObservedJob[];
}) {
  const [raw, setRaw] = useState(false);
  const streams = observations.filter((entry) => entry.text || entry.gapBefore);
  return (
    <div className="sr-research-inspector">
      {progress && (
        <div className="sr-detail-context">
          <span>当前进展</span>
          <p>{progress}</p>
        </div>
      )}
      <div
        className="sr-detail-grid"
        data-columns={
          operations.length > 0 && streams.length > 0 ? "two" : "one"
        }
      >
        {operations.length > 0 && (
          <section className="sr-detail-tasks" aria-label="研究任务">
            <div className="sr-detail-section-heading">
              <h4>研究任务</h4>
              <span className="sr-detail-count">{operations.length}</span>
            </div>
            <ul className="sr-detail-task-list">
              {operations.map((operation) => (
                <li key={operation.id} data-status={operation.status}>
                  <span className="sr-task-mark" aria-hidden="true" />
                  <div className="sr-task-content">
                    <div className="sr-task-heading">
                      <strong>{operation.label}</strong>
                      <span>{operationLabels[operation.status]}</span>
                    </div>
                    {operation.progress && <p>{operation.progress}</p>}
                    {operation.detail && <p>{operation.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {streams.length > 0 && (
          <section className="sr-detail-output" aria-label="执行记录">
            <div className="sr-detail-section-heading">
              <h4>执行记录</h4>
              <div className="sr-log-view" role="group" aria-label="日志视图">
                <button
                  type="button"
                  className="sr-research-action"
                  aria-pressed={!raw}
                  onClick={() => setRaw(false)}
                >
                  整理视图
                </button>
                <button
                  type="button"
                  className="sr-research-action"
                  aria-pressed={raw}
                  onClick={() => setRaw(true)}
                >
                  原始日志
                </button>
              </div>
            </div>
            {streams.map((observation, index) => (
              <LogStream
                key={observation.jobId}
                observation={observation}
                raw={raw}
                label={
                  operations.find(
                    (operation) => operation.id === observation.jobId,
                  )?.label ??
                  (streams.length > 1 ? `任务日志 ${index + 1}` : undefined)
                }
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  DEFAULT_PUBLIC_SEARCH_LIMIT,
  type ApplicationConfig,
} from "../../contracts/settings.js";
import type { ModelCatalog, ModelRoute } from "../settings-types.js";
import { ModelEditor } from "./ModelEditor.js";
import { at, useSettingsDraft } from "./draft.js";
import {
  datasetLabels,
  sources,
  xueqiuCookieFields,
  xueqiuCookieValue,
} from "./fields.js";
import { validateSettingsDraft } from "./validation.js";
import { styles } from "./styles.js";

export interface SettingsPageProps {
  form: ConfigForm<ApplicationConfig>;
  loadCatalog: () => Promise<ModelCatalog>;
  inheritedModel?: ModelRoute;
}

export function SettingsPage({
  form,
  loadCatalog,
  inheritedModel,
}: SettingsPageProps) {
  const section = useRef<HTMLElement>(null);
  const draftState = useSettingsDraft(form);
  const {
    snapshot,
    draft,
    revision,
    dirty,
    error,
    saved,
    saving,
    setError,
    edit,
    reset,
    refreshDraft,
    discard,
    resetAll,
  } = draftState;
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    let live = true;
    void loadCatalog().then(
      (value) => {
        if (live) {
          setCatalog(value);
          setCatalogError("");
        }
      },
      (cause: unknown) => {
        if (live)
          setCatalogError(
            cause instanceof Error ? cause.message : String(cause),
          );
      },
    );
    return () => {
      live = false;
    };
  }, [loadCatalog]);

  if (snapshot.status === "loading" || (snapshot.status === "ready" && !draft))
    return <p role="status">正在加载股票研究设置…</p>;
  if (snapshot.status === "unavailable" || !draft)
    return <p role="status">当前宿主未提供股票研究设置。</p>;
  const disabled = saving || !snapshot.writable;
  const base = snapshot.base as ApplicationConfig | undefined;
  const marker = (path: string[]) =>
    at(snapshot.user, path) !== undefined ? (
      <span className="sr-badge">已覆盖</span>
    ) : null;
  const numberField = (
    label: string,
    path: string[],
    unit: string,
    divisor = 1,
    min = 0,
    integer = false,
  ) => (
    <div className="sr-field" key={path.join(".")}>
      <label>
        {label} {marker(path)}
        <span className="sr-number">
          <input
            aria-label={label}
            type="number"
            min={min}
            step={integer ? 1 : "any"}
            value={
              Number.isFinite(at(draft, path))
                ? Number(at(draft, path)) / divisor
                : ""
            }
            onChange={(event) =>
              edit(
                path,
                event.target.value === ""
                  ? NaN
                  : Number(event.target.value) * divisor,
              )
            }
          />
          <span>{unit}</span>
        </span>
      </label>
      <button
        type="button"
        className="sr-link"
        disabled={at(base, path) === undefined}
        onClick={() => reset(path)}
      >
        恢复默认
      </button>
    </div>
  );
  const save = async () => {
    const failure = validateSettingsDraft(draft, catalog, inheritedModel);
    if (failure) {
      setError(failure.message);
      const target = [
        ...section.current!.querySelectorAll<HTMLElement>("[aria-label]"),
      ].find((node) => node.getAttribute("aria-label") === failure.field)!;
      for (
        let parent = target.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      target.focus();
      return;
    }
    await draftState.save();
  };
  return (
    <section ref={section} className="sr-settings" aria-label="股票研究设置">
      <style>{styles}</style>
      <header>
        <span className="sr-eyebrow">STOCK RESEARCH</span>
        <h2>股票研究</h2>
        <p className="sr-muted">
          主 Agent 使用当前 DSH 会话模型。下方配置用于下一次研究的子 Agent
          与数据。
        </p>
      </header>
      {!snapshot.writable && (
        <p role="status" className="sr-notice">
          当前配置只读，无法保存修改。
        </p>
      )}
      {catalogError && (
        <p role="alert" className="sr-error">
          模型目录加载失败：{catalogError}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={disabled} className="sr-outer">
          <ModelEditor
            label="研究模型"
            value={draft.model}
            inherited={inheritedModel}
            catalog={catalog}
            disabled={disabled}
            onChange={(value) => edit(["model"], value)}
            onReset={() => edit(["model"], {})}
          />
          <p className="sr-muted">
            研究模型与思考强度用于研究子 Agent，默认继承主 Agent 的会话设置。
          </p>
          {!inheritedModel && catalog?.default && (
            <p className="sr-muted">
              宿主默认模型：{catalog.default.provider} / {catalog.default.model}
              。实际继承值在运行时随调用会话解析。
            </p>
          )}
          <fieldset className="sr-card">
            <legend>调研 Agents</legend>
            <label>
              免审批搜索次数上限 {marker(["publicSearchLimit"])}
              <span className="sr-number">
                <input
                  aria-label="免审批搜索次数上限"
                  type="number"
                  min={0}
                  step={1}
                  value={
                    Number.isFinite(
                      draft.publicSearchLimit ?? DEFAULT_PUBLIC_SEARCH_LIMIT,
                    )
                      ? (draft.publicSearchLimit ?? DEFAULT_PUBLIC_SEARCH_LIMIT)
                      : ""
                  }
                  onChange={(event) =>
                    edit(
                      ["publicSearchLimit"],
                      event.target.value === ""
                        ? NaN
                        : Number(event.target.value),
                    )
                  }
                />
                <span>次</span>
              </span>
            </label>
            <p className="sr-muted">
              每次调研尝试独立计数，超过后每次搜索申请权限；0 表示每次均需批准。
            </p>
            <button
              type="button"
              className="sr-link"
              onClick={() =>
                reset(
                  ["publicSearchLimit"],
                  base?.publicSearchLimit ?? DEFAULT_PUBLIC_SEARCH_LIMIT,
                )
              }
            >
              恢复默认
            </button>
          </fieldset>
          <details>
            <summary>
              数据来源<span>控制固定采集与公开信息来源</span>
            </summary>
            <div className="sr-sources">
              {sources.map(([id, label, description]) => (
                <label className="sr-source" key={id}>
                  <input
                    type="checkbox"
                    checked={draft.runtime.enabledSources.includes(id)}
                    onChange={(event) =>
                      edit(
                        ["runtime", "enabledSources"],
                        event.target.checked
                          ? [...draft.runtime.enabledSources, id]
                          : draft.runtime.enabledSources.filter(
                              (item) => item !== id,
                            ),
                      )
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            {draft.runtime.enabledSources.includes("xueqiu") && (
              <fieldset className="sr-card">
                <legend>雪球请求配置</legend>
                {xueqiuCookieFields.map(({ name, label, type }) => (
                  <label key={name}>
                    {label}
                    <input
                      type={type}
                      aria-label={`雪球 ${name}`}
                      autoComplete="off"
                      spellCheck={false}
                      value={xueqiuCookieValue(
                        draft.runtime.xueqiuCookie,
                        name,
                      )}
                      placeholder={
                        name === "xq_is_login"
                          ? "1"
                          : "粘贴对应 Cookie 的 Value"
                      }
                      onChange={(event) =>
                        edit(
                          ["runtime", "xueqiuCookie"],
                          xueqiuCookieFields
                            .map(
                              (field) =>
                                `${field.name}=${field.name === name ? event.target.value : xueqiuCookieValue(draft.runtime.xueqiuCookie, field.name)}`,
                            )
                            .join("; "),
                        )
                      }
                    />
                  </label>
                ))}
                <p className="sr-muted">只填各项的 Value，不含名称前缀。</p>
              </fieldset>
            )}
            {draft.runtime.enabledSources.includes("sec") && (
              <fieldset className="sr-card">
                <legend>SEC 请求配置</legend>
                <label>
                  请求身份与联系方式
                  <input
                    aria-label="SEC 请求身份与联系方式"
                    value={draft.runtime.secUserAgent ?? ""}
                    placeholder="项目名称及可用联系邮箱"
                    onChange={(event) =>
                      edit(["runtime", "secUserAgent"], event.target.value)
                    }
                  />
                </label>
                <p className="sr-muted">
                  股票使用内部 ID，例如 US:NVDA；CIK 为经确认的十位发行人编号。
                </p>
                {Object.entries(draft.runtime.policy.secCiks).map(
                  ([security, cik], index) => (
                    <div className="sr-cik" key={index}>
                      <label>
                        股票 ID
                        <input
                          aria-label={`SEC 股票 ID ${index + 1}`}
                          value={security}
                          onChange={(event) => {
                            if (
                              event.target.value !== security &&
                              Object.hasOwn(
                                draft.runtime.policy.secCiks,
                                event.target.value,
                              )
                            ) {
                              setError(
                                "该股票 ID 已存在，请修改已有发行人的 CIK。",
                              );
                              return;
                            }
                            const entries = Object.entries(
                              draft.runtime.policy.secCiks,
                            );
                            entries[index] = [event.target.value, cik];
                            edit(
                              ["runtime", "policy", "secCiks"],
                              Object.fromEntries(entries),
                            );
                          }}
                        />
                      </label>
                      <label>
                        CIK
                        <input
                          aria-label={`SEC CIK ${index + 1}`}
                          value={cik}
                          onChange={(event) =>
                            edit(
                              ["runtime", "policy", "secCiks", security],
                              event.target.value,
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...draft.runtime.policy.secCiks };
                          delete next[security];
                          edit(["runtime", "policy", "secCiks"], next);
                        }}
                      >
                        移除
                      </button>
                    </div>
                  ),
                )}
                <button
                  type="button"
                  aria-label="添加发行人"
                  onClick={() =>
                    edit(["runtime", "policy", "secCiks"], {
                      ...draft.runtime.policy.secCiks,
                      "": "",
                    })
                  }
                >
                  添加发行人
                </button>
              </fieldset>
            )}
            <button
              type="button"
              className="sr-link"
              disabled={at(base, ["runtime", "enabledSources"]) === undefined}
              onClick={() => reset(["runtime", "enabledSources"])}
            >
              恢复默认来源
            </button>
          </details>
          <details>
            <summary>
              高级设置<span>存储、网络、缓存与数据质量</span>
            </summary>
            <fieldset className="sr-card">
              <legend>数据目录</legend>
              <label>
                保存位置 {marker(["runtime", "dataRoot"])}
                <input
                  aria-label="数据目录"
                  value={draft.runtime.dataRoot}
                  onChange={(event) =>
                    edit(["runtime", "dataRoot"], event.target.value)
                  }
                />
              </label>
              <button
                type="button"
                className="sr-link"
                disabled={at(base, ["runtime", "dataRoot"]) === undefined}
                onClick={() => reset(["runtime", "dataRoot"])}
              >
                恢复默认目录
              </button>
            </fieldset>
            <fieldset className="sr-card">
              <legend>网络</legend>
              <div className="sr-grid">
                {numberField(
                  "请求超时",
                  ["runtime", "http", "timeoutMs"],
                  "秒",
                  1000,
                  0.001,
                )}
                {numberField(
                  "最大并发",
                  ["runtime", "http", "maxConcurrency"],
                  "个",
                  1,
                  1,
                  true,
                )}
                {numberField(
                  "请求最小间隔",
                  ["runtime", "http", "minIntervalMs"],
                  "秒",
                  1000,
                )}
              </div>
            </fieldset>
            <fieldset className="sr-card">
              <legend>缓存</legend>
              <p className="sr-muted">
                有效期控制缓存复用，不删除已保存的研究记录。
              </p>
              {numberField(
                "缓存容量",
                ["runtime", "cache", "maxEntries"],
                "条",
                1,
                1,
                true,
              )}
              <div className="sr-grid">
                {(
                  Object.keys(datasetLabels) as (keyof typeof datasetLabels)[]
                ).map((key) =>
                  numberField(
                    `${datasetLabels[key]}缓存有效期`,
                    ["runtime", "cache", "ttl", key],
                    "小时",
                    3600000,
                  ),
                )}
              </div>
            </fieldset>
            <fieldset className="sr-card">
              <legend>数据新鲜度</legend>
              <p className="sr-muted">
                超过阈值的数据会标记为陈旧；行情按已完成周期衡量。
              </p>
              <div className="sr-grid">
                {(["market", "fundamentals", "macro"] as const).map((key) =>
                  numberField(
                    `${datasetLabels[key]}新鲜度阈值`,
                    ["runtime", "policy", "freshness", key],
                    "天",
                    86400000,
                  ),
                )}
              </div>
            </fieldset>
          </details>
        </fieldset>
        <div className="sr-feedback" aria-live="polite">
          {error && (
            <p role="alert" className="sr-error">
              {error}
            </p>
          )}
          {error && snapshot.revision !== revision && (
            <button type="button" disabled={saving} onClick={refreshDraft}>
              保留草稿，采用最新版本
            </button>
          )}
          {saved && (
            <p role="status" className="sr-success">
              已保存，新建任务使用新设置。
            </p>
          )}
          {dirty && !saved && <p className="sr-muted">有未保存修改</p>}
        </div>
        <footer>
          <button type="button" disabled={disabled || !dirty} onClick={discard}>
            放弃修改
          </button>
          <button
            type="button"
            disabled={disabled || base === undefined}
            onClick={resetAll}
          >
            恢复全部默认
          </button>
          <button
            type="submit"
            className="sr-primary"
            disabled={disabled || !dirty}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
        <p className="sr-muted sr-note">
          模型与搜索额度设置对新任务生效。数据目录、来源、网络与缓存修改需在研究任务空闲时保存。
        </p>
      </form>
    </section>
  );
}

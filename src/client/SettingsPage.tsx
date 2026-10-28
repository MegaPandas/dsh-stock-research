import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import { ModelSelect } from "./ModelSelect.js";
import type {
  ModelCatalog,
  ModelOverride,
  ModelRoute,
  SettingsValue,
} from "./settings-types.js";

export interface SettingsPageProps {
  form: ConfigForm<SettingsValue>;
  loadCatalog: () => Promise<ModelCatalog>;
  inheritedModel?: ModelRoute;
}

type Value =
  string | number | boolean | null | Value[] | { [key: string]: Value };
type Operation =
  { op: "set"; path: string[]; value: Value } | { op: "unset"; path: string[] };
interface RetainedDraft {
  draft: SettingsValue;
  original: SettingsValue;
  revision: number | undefined;
  resets: string[];
}
// Settings navigation unmounts pages without a before-leave hook.
const retainedDrafts = new WeakMap<ConfigForm<SettingsValue>, RetainedDraft>();
const sources = [
  ["yahoo", "Yahoo 行情", "美股行情与部分市场基准"],
  ["eastmoney-market", "东方财富行情", "A 股行情、估值与固定采集"],
  ["tencent", "腾讯行情", "行情查询与日线备用来源"],
  ["eastmoney-income", "东方财富财务", "A 股财务指标与报表"],
  ["sina", "新浪财经", "财务查询、行情均线及个股、指数、部分国际基准备用"],
  ["xueqiu", "雪球", "默认关闭，配置 Cookie 后作为 A 股行情与财务备用来源"],
  ["china-macro", "中国宏观", "国内宏观固定采集"],
  ["benchmarks", "市场基准", "指数、汇率、黄金与国债"],
  ["fred", "FRED", "美国宏观序列"],
  ["dsh-web", "公开信息搜索", "复用 DSH 搜索服务"],
  ["sec", "SEC", "美国发行人标准财务字段"],
] as const;
const datasetLabels = {
  market: "行情",
  fundamentals: "财务",
  macro: "宏观",
  research: "公开研究",
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function at(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node === undefined || node === null
        ? undefined
        : Reflect.get(node as object, key),
    value,
  );
}
function changed(
  value: SettingsValue,
  path: string[],
  replacement: unknown,
): SettingsValue {
  const copy = structuredClone(value);
  let node: Record<string, unknown> = copy as unknown as Record<
    string,
    unknown
  >;
  for (const key of path.slice(0, -1)) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  const key = path.at(-1)!;
  if (replacement === undefined) delete node[key];
  else node[key] = replacement;
  return copy;
}
function differences(
  before: unknown,
  after: unknown,
  path: string[] = [],
): Operation[] {
  if (equal(before, after)) return [];
  if (after === undefined) return [{ op: "unset", path }];
  const model =
    path.join(".") === "model" || path.join(".") === "runtime.digestModel";
  if (
    !model &&
    after !== null &&
    typeof after === "object" &&
    !Array.isArray(after)
  ) {
    const keys = new Set([
      ...Object.keys((before as object | undefined) ?? {}),
      ...Object.keys(after),
    ]);
    return [...keys].flatMap((key) =>
      differences(at(before, [key]), at(after, [key]), [...path, key]),
    );
  }
  return [{ op: "set", path, value: after as Value }];
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ModelEditor({
  label,
  value,
  inherited,
  catalog,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: ModelOverride | undefined;
  inherited: ModelRoute | undefined;
  catalog: ModelCatalog | undefined;
  disabled: boolean;
  onChange: (value: ModelOverride) => void;
  onReset: () => void;
}) {
  const custom = value?.provider !== undefined;
  const route = custom ? value : (inherited ?? catalog?.default);
  const group = catalog?.groups.find(({ id }) => id === route?.provider);
  const model = group?.models.find(({ id }) => id === route?.model);
  const efforts = model?.reasoning?.efforts ?? [];
  const effort =
    value?.reasoningEffort === null
      ? "default"
      : value?.reasoningEffort === undefined
        ? "inherit"
        : `effort:${value.reasoningEffort}`;
  return (
    <fieldset className="sr-card" disabled={disabled}>
      <legend>{label}</legend>
      <label>
        {label}模式
        <select
          aria-label={`${label}模式`}
          value={custom ? "custom" : "inherit"}
          onChange={(event) => {
            onChange(
              event.target.value === "inherit"
                ? {}
                : { provider: "", model: "" },
            );
          }}
        >
          <option value="inherit">
            {label === "摘要模型" ? "继承研究模型" : "继承当前会话"}
          </option>
          <option value="custom">自定义</option>
        </select>
      </label>
      {!custom && (
        <p className="sr-muted">
          {inherited
            ? `继承：${inherited.provider} / ${inherited.model}`
            : "运行时由调用会话决定"}
        </p>
      )}
      {custom && (
        <>
          <label>
            {label}提供方
            <select
              aria-label={`${label}提供方`}
              value={value.provider}
              onChange={(event) => {
                onChange({ provider: event.target.value, model: "" });
              }}
            >
              <option value="">选择提供方</option>
              {catalog?.groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <ModelSelect
            key={value.provider}
            label={`${label}名称`}
            models={group?.models ?? []}
            value={value.model ?? ""}
            disabled={disabled || !value.provider}
            onChange={(model) => onChange({ provider: value.provider!, model })}
          />
        </>
      )}
      <label>
        {label}思考强度
        <select
          aria-label={`${label}思考强度`}
          value={effort}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value === "inherit") delete next.reasoningEffort;
            else
              next.reasoningEffort =
                event.target.value === "default"
                  ? null
                  : event.target.value.slice(7);
            onChange(next);
          }}
        >
          <option value="inherit">{custom ? "模型默认" : "继承"}</option>
          {!custom && <option value="default">模型默认</option>}
          {custom && effort === "default" && (
            <option value="default">模型默认</option>
          )}
          {efforts.map((item) => (
            <option key={item.id} value={`effort:${item.id}`}>
              {item.name}
            </option>
          ))}
          {value?.reasoningEffort &&
            !efforts.some(({ id }) => id === value.reasoningEffort) && (
              <option value={`effort:${value.reasoningEffort}`}>
                {value.reasoningEffort}（需要重新确认模型支持）
              </option>
            )}
        </select>
      </label>
      {!custom && !inherited && catalog?.default && (
        <p className="sr-muted">
          思考强度选项依据宿主默认模型预览；运行时按调用会话的实际模型验证。
        </p>
      )}
      {model && efforts.length === 0 && (
        <p className="sr-muted">该模型不支持思考强度配置。</p>
      )}
      {value?.reasoningEffort && (
        <p className="sr-muted">
          {efforts.find(({ id }) => id === value.reasoningEffort)?.description}
        </p>
      )}
      <button type="button" className="sr-link" onClick={onReset}>
        恢复{label}继承
      </button>
    </fieldset>
  );
}

export function SettingsPage({
  form,
  loadCatalog,
  inheritedModel,
}: SettingsPageProps) {
  const section = useRef<HTMLElement>(null);
  const snapshot = useSyncExternalStore(
    (listener) => form.subscribe(listener),
    () => form.getSnapshot(),
  );
  const [draft, setDraft] = useState<SettingsValue | undefined>(
    () => retainedDrafts.get(form)?.draft,
  );
  const [original, setOriginal] = useState<SettingsValue | undefined>(
    () => retainedDrafts.get(form)?.original,
  );
  const [revision, setRevision] = useState<number | undefined>(
    () => retainedDrafts.get(form)?.revision,
  );
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resets, setResets] = useState<string[]>(
    () => retainedDrafts.get(form)?.resets ?? [],
  );
  const dirty =
    draft !== undefined && (!equal(draft, original) || resets.length > 0);
  useEffect(() => {
    if (draft && original)
      retainedDrafts.set(form, { draft, original, revision, resets });
  }, [form, draft, original, revision, resets]);
  useEffect(() => {
    if (!dirty && snapshot.value) {
      setDraft(structuredClone(snapshot.value));
      setOriginal(structuredClone(snapshot.value));
      setRevision(snapshot.revision);
    }
  }, [snapshot, dirty]);
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
        if (live) setCatalogError(errorMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [loadCatalog]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (snapshot.status === "loading" || (snapshot.status === "ready" && !draft))
    return <p role="status">正在加载股票研究设置…</p>;
  if (snapshot.status === "unavailable" || !draft)
    return <p role="status">当前宿主未提供股票研究设置。</p>;
  const disabled = saving || !snapshot.writable;
  const base = snapshot.base as SettingsValue | undefined;
  const edit = (path: string[], value: unknown) => {
    setDraft((current) => changed(current!, path, value));
    setResets((current) =>
      current.filter(
        (reset) =>
          reset === "" ||
          !(
            path.join(".") === reset ||
            path.join(".").startsWith(`${reset}.`) ||
            reset.startsWith(`${path.join(".")}.`)
          ),
      ),
    );
    setError("");
    setSaved(false);
  };
  const reset = (path: string[]) => {
    setDraft((current) => changed(current!, path, at(base, path)));
    setResets((current) => [
      ...current.filter((item) => !item.startsWith(path.join("."))),
      path.join("."),
    ]);
    setError("");
    setSaved(false);
  };
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
  const validate = (): { message: string; field: string } | undefined => {
    const publicSearchLimit = draft.publicSearchLimit ?? 8;
    if (!Number.isSafeInteger(publicSearchLimit) || publicSearchLimit < 0)
      return {
        message: "免审批搜索次数上限须为非负安全整数。",
        field: "免审批搜索次数上限",
      };
    for (const [label, value, inherited] of [
      ["研究模型", draft.model, inheritedModel ?? catalog?.default],
      [
        "摘要模型",
        draft.runtime.digestModel,
        draft.model?.provider
          ? (draft.model as ModelRoute)
          : (inheritedModel ?? catalog?.default),
      ],
    ] as const) {
      if (value?.provider !== undefined) {
        if (!value.provider.trim() || !value.model?.trim())
          return {
            message: `请选择${label}提供方和模型。`,
            field: `${label}${value.provider.trim() ? "名称" : "提供方"}`,
          };
        const item = catalog?.groups
          .find(({ id }) => id === value.provider)
          ?.models.find(({ id }) => id === value.model);
        if (!item)
          return {
            message: `${label}不在宿主当前可用模型列表中，请重新选择。`,
            field: `${label}名称`,
          };
      }
      const route = value?.provider ? value : inherited;
      const item = catalog?.groups
        .find(({ id }) => id === route?.provider)
        ?.models.find(({ id }) => id === route?.model);
      if (
        value?.reasoningEffort &&
        item &&
        !item.reasoning?.efforts.some(({ id }) => id === value.reasoningEffort)
      )
        return {
          message: `${label}不支持所选思考强度，请重新选择。`,
          field: `${label}思考强度`,
        };
    }
    if (!draft.runtime.dataRoot.trim())
      return { message: "请填写数据目录。", field: "数据目录" };
    const numeric: [string, number, number, boolean, number][] = [
      ["请求超时", draft.runtime.http.timeoutMs, 1, true, 2147483647],
      [
        "最大并发",
        draft.runtime.http.maxConcurrency,
        1,
        true,
        Number.MAX_SAFE_INTEGER,
      ],
      ["请求最小间隔", draft.runtime.http.minIntervalMs, 0, true, 2147483647],
      [
        "缓存容量",
        draft.runtime.cache.maxEntries,
        1,
        true,
        Number.MAX_SAFE_INTEGER,
      ],
      ...Object.entries(draft.runtime.cache.ttl).map(
        ([key, value]): [string, number, number, boolean, number] => [
          `${datasetLabels[key as keyof typeof datasetLabels]}缓存有效期`,
          value,
          0,
          false,
          Infinity,
        ],
      ),
      ...Object.entries(draft.runtime.policy.freshness).map(
        ([key, value]): [string, number, number, boolean, number] => [
          `${datasetLabels[key as keyof typeof datasetLabels]}新鲜度阈值`,
          value,
          0,
          false,
          Infinity,
        ],
      ),
    ];
    const invalidNumber = numeric.find(
      ([, value, min, integer, max]) =>
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isSafeInteger(value)),
    );
    if (invalidNumber)
      return {
        message: "请填写有效的网络、缓存和新鲜度参数；容量和并发须为正整数。",
        field: invalidNumber[0],
      };
    if (
      draft.runtime.enabledSources.includes("xueqiu") &&
      !draft.runtime.xueqiuCookie?.trim()
    )
      return {
        message: "启用雪球前请填写 Cookie。",
        field: "雪球 Cookie",
      };
    if (draft.runtime.enabledSources.includes("sec")) {
      if (!draft.runtime.secUserAgent?.trim())
        return {
          message: "启用 SEC 前请填写请求身份与联系方式。",
          field: "SEC 请求身份与联系方式",
        };
      const entries = Object.entries(draft.runtime.policy.secCiks);
      if (
        entries.length === 0 ||
        entries.some(
          ([security, cik]) =>
            !security.trim() || !/^(?!0000000000)\d{10}$/.test(cik),
        )
      )
        return {
          message: "启用 SEC 前请填写股票与有效的十位 CIK 映射。",
          field:
            entries.length === 0
              ? "添加发行人"
              : `SEC CIK ${entries.findIndex(([security, cik]) => !security.trim() || !/^(?!0000000000)\d{10}$/.test(cik)) + 1}`,
        };
    }
  };
  const save = async () => {
    const failure = validate();
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
    setSaving(true);
    setError("");
    setSaved(false);
    const resetOps: Operation[] = resets.map((path) => ({
      op: "unset",
      path: path === "" ? [] : path.split("."),
    }));
    const starting = resets.includes("") ? base! : original;
    const ops = [
      ...resetOps,
      ...differences(starting, draft).filter(
        (op) =>
          !resets.some(
            (path) =>
              path !== "" &&
              (op.path.join(".") === path ||
                op.path.join(".").startsWith(`${path}.`)),
          ),
      ),
    ];
    try {
      if (!(await form.mutate(ops, revision))) {
        setError(
          "保存未被宿主接受，可能配置已被其他窗口修改或研究任务正在运行。草稿已保留，请核对后重试。",
        );
        return;
      }
      const accepted = form.getSnapshot();
      retainedDrafts.set(form, {
        draft: accepted.value ?? draft,
        original: accepted.value ?? draft,
        revision: accepted.revision,
        resets: [],
      });
      setDraft(structuredClone(accepted.value ?? draft));
      setOriginal(structuredClone(accepted.value ?? draft));
      setRevision(accepted.revision);
      setResets([]);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const effectiveResearch =
    draft.model?.provider && draft.model.model
      ? {
          provider: draft.model.provider,
          model: draft.model.model,
          ...(draft.model.reasoningEffort
            ? { reasoningEffort: draft.model.reasoningEffort }
            : {}),
        }
      : inheritedModel;
  const refreshDraft = () => {
    const current = form.getSnapshot();
    let rebased = structuredClone(current.value!);
    for (const operation of differences(original, draft))
      rebased = changed(
        rebased,
        operation.path,
        operation.op === "set" ? operation.value : undefined,
      );
    setDraft(rebased);
    setOriginal(structuredClone(current.value!));
    setRevision(current.revision);
    setError("");
  };
  return (
    <section ref={section} className="sr-settings" aria-label="股票研究设置">
      <style>{styles}</style>
      <header>
        <span className="sr-eyebrow">STOCK RESEARCH</span>
        <h2>股票研究</h2>
        <p className="sr-muted">
          主 Agent 使用当前 DSH 会话模型。下方配置用于下一次研究的子
          Agent、摘要与数据。
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
          <details>
            <summary>
              旧版摘要模型与思考强度<span>用于旧版研究的摘要任务</span>
            </summary>
            <ModelEditor
              label="摘要模型"
              value={draft.runtime.digestModel}
              inherited={effectiveResearch}
              catalog={catalog}
              disabled={disabled}
              onChange={(value) => edit(["runtime", "digestModel"], value)}
              onReset={() => edit(["runtime", "digestModel"], {})}
            />
          </details>
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
                    Number.isFinite(draft.publicSearchLimit ?? 8)
                      ? (draft.publicSearchLimit ?? 8)
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
              onClick={() => {
                setDraft((current) =>
                  changed(
                    current!,
                    ["publicSearchLimit"],
                    base?.publicSearchLimit ?? 8,
                  ),
                );
                setResets((current) => [
                  ...current.filter((path) => path !== "publicSearchLimit"),
                  "publicSearchLimit",
                ]);
                setError("");
                setSaved(false);
              }}
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
                <label>
                  Cookie
                  <input
                    type="password"
                    aria-label="雪球 Cookie"
                    autoComplete="off"
                    value={draft.runtime.xueqiuCookie ?? ""}
                    placeholder="xq_a_token=你的值; u=你的用户ID; xq_is_login=1"
                    onChange={(event) =>
                      edit(["runtime", "xueqiuCookie"], event.target.value)
                    }
                  />
                </label>
                <p className="sr-muted">
                  格式：xq_a_token=你的值; u=你的用户ID; xq_is_login=1
                </p>
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
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => {
              const current = form.getSnapshot();
              setDraft(structuredClone(current.value!));
              setOriginal(structuredClone(current.value!));
              setRevision(current.revision);
              setResets([]);
              setError("");
              setSaved(false);
            }}
          >
            放弃修改
          </button>
          <button
            type="button"
            disabled={disabled || base === undefined}
            onClick={() => {
              setDraft(structuredClone(base!));
              setResets([""]);
              setError("");
              setSaved(false);
            }}
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

const styles = `
.sr-model-field{position:relative;margin-bottom:14px}.sr-model-field>label{margin-bottom:6px}.sr-model-control{position:relative}.sr-settings .sr-model-control input{padding-right:42px}.sr-settings button.sr-model-toggle{position:absolute;right:1px;top:1px;bottom:1px;width:38px;padding:0;border:0;background:transparent;font-size:20px}.sr-model-options{position:absolute;z-index:30;top:100%;left:0;right:0;max-height:240px;overflow-y:auto;overscroll-behavior:contain;list-style:none;margin:6px 0 0;padding:4px;border:1px solid var(--dsw-color-border,#ccd7df);border-radius:8px;background:var(--dsw-color-background-secondary,#fff);box-shadow:0 8px 24px #20304020}.sr-model-options li{display:flex;flex-direction:column;gap:2px;padding:9px 10px;border-radius:5px;cursor:pointer;font-size:13px;overflow-wrap:anywhere}.sr-model-options small{font:11px/1.4 ui-monospace,monospace;color:var(--dsw-color-text-secondary,#647381)}.sr-model-options [aria-selected=true]{font-weight:650}.sr-model-options .sr-model-active{background:var(--dsw-color-background-tertiary,#e8f4f0)}.sr-model-options .sr-model-empty{cursor:default;color:var(--dsw-color-text-secondary,#647381)}
.sr-settings{max-width:860px;margin:0 auto;padding:24px;color:var(--dsw-color-text-primary,#202b37);font:14px/1.55 system-ui,sans-serif}.sr-settings *{box-sizing:border-box}.sr-settings h2{font-size:27px;letter-spacing:-.6px;margin:4px 0 8px}.sr-eyebrow{font-size:10px;letter-spacing:2px;color:var(--dsw-color-text-secondary,#607582);font-weight:700}.sr-muted{color:var(--dsw-color-text-secondary,#647381);font-size:12px;margin:8px 0 12px}.sr-settings fieldset{min-width:0}.sr-outer{border:0;padding:0;margin:20px 0 0}.sr-card{border:1px solid var(--dsw-color-border,#dce3e7);border-radius:12px;padding:16px 18px;margin:12px 0 18px;background:var(--dsw-color-background-primary,transparent)}.sr-card legend{padding:0 7px;font-weight:650;font-size:14px}.sr-settings label{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;font-size:12px;font-weight:550}.sr-settings input,.sr-settings select{font:inherit;color:inherit;background:var(--dsw-color-background-secondary,#fff);border:1px solid var(--dsw-color-border,#ccd7df);border-radius:7px;padding:9px 10px;min-height:38px;width:100%}.sr-settings input:focus,.sr-settings select:focus{outline:2px solid #208b83;outline-offset:2px}.sr-settings button{font:inherit;color:inherit;border:1px solid var(--dsw-color-border,#d1dbe1);border-radius:7px;padding:8px 13px;background:var(--dsw-color-background-secondary,#fff);cursor:pointer}.sr-settings button:disabled{opacity:.5;cursor:default}.sr-settings button.sr-primary{background:#167b73;border-color:#167b73;color:white}.sr-settings button.sr-link{padding:0;border:0;background:transparent;color:#14857c;font-size:12px}.sr-settings details{border-bottom:1px solid var(--dsw-color-border,#dce3e7);padding:15px 0}.sr-settings summary{cursor:pointer;font-weight:650;line-height:1.8}.sr-settings summary span{display:block;margin-left:16px;font-weight:400;color:var(--dsw-color-text-secondary,#6b7c86);font-size:12px}.sr-sources{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:16px 0}.sr-source{flex-direction:row!important;align-items:start;padding:9px;border:1px solid var(--dsw-color-border,#e2e8ec);border-radius:8px;margin:0!important}.sr-source input{width:16px;min-height:16px;margin:4px 4px 0 0;accent-color:#167b73}.sr-source strong,.sr-source small{display:block}.sr-source small{font-weight:400;color:var(--dsw-color-text-secondary,#6b7c86);margin-top:3px}.sr-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px}.sr-number{display:flex;align-items:center;gap:9px}.sr-number input{max-width:180px}.sr-number>span{color:var(--dsw-color-text-secondary,#647381);white-space:nowrap}.sr-cik{display:flex;gap:10px;align-items:center}.sr-cik label{flex:1}.sr-cik button{margin-top:9px}.sr-badge{font-size:10px;font-weight:400;color:#177e74;background:#e8f4f0;padding:1px 5px;border-radius:4px;align-self:start}.sr-feedback{min-height:38px;padding-top:10px}.sr-error,.sr-notice{background:var(--dsw-color-background-secondary,#fff1ee);color:#ad3d31;border:1px solid #eec5bb;padding:10px 12px;border-radius:8px;font-size:12px}.sr-success{color:#167b73;font-size:12px}.sr-settings footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 0;border-top:1px solid var(--dsw-color-border,#dce3e7)}.sr-note{text-align:right}.sr-settings:has(fieldset:disabled) input,.sr-settings:has(fieldset:disabled) select{opacity:.75}@media(max-width:600px){.sr-settings{padding:15px}.sr-grid,.sr-sources{grid-template-columns:1fr}.sr-card{padding:12px}.sr-cik{flex-wrap:wrap}.sr-cik label{min-width:120px}.sr-settings footer{flex-wrap:wrap}.sr-note{text-align:left}}
`;

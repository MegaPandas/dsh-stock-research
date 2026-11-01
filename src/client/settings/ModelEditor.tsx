import type { ModelConfig } from "../../contracts/settings.js";
import type { ModelCatalog, ModelRoute } from "../settings-types.js";
import { ModelSelect } from "../ModelSelect.js";

export function ModelEditor({
  label,
  value,
  inherited,
  catalog,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: ModelConfig | undefined;
  inherited: ModelRoute | undefined;
  catalog: ModelCatalog | undefined;
  disabled: boolean;
  onChange: (value: ModelConfig) => void;
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
          <option value="inherit">继承当前会话</option>
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

import {
  DEFAULT_PUBLIC_SEARCH_LIMIT,
  type ApplicationConfig,
} from "../../contracts/settings.js";
import type { ModelCatalog, ModelRoute } from "../settings-types.js";
import {
  datasetLabels,
  xueqiuCookieFields,
  xueqiuCookieValue,
} from "./fields.js";

export function validateSettingsDraft(
  draft: ApplicationConfig,
  catalog: ModelCatalog | undefined,
  inheritedModel: ModelRoute | undefined,
): { message: string; field: string } | undefined {
  const publicSearchLimit =
    draft.publicSearchLimit ?? DEFAULT_PUBLIC_SEARCH_LIMIT;
  if (!Number.isSafeInteger(publicSearchLimit) || publicSearchLimit < 0)
    return {
      message: "免审批搜索次数上限须为非负安全整数。",
      field: "免审批搜索次数上限",
    };
  const value = draft.model;
  if (value?.provider !== undefined) {
    if (!value.provider.trim() || !value.model?.trim())
      return {
        message: "请选择研究模型提供方和模型。",
        field: `研究模型${value.provider.trim() ? "名称" : "提供方"}`,
      };
    const item = catalog?.groups
      .find(({ id }) => id === value.provider)
      ?.models.find(({ id }) => id === value.model);
    if (!item)
      return {
        message: "研究模型不在宿主当前可用模型列表中，请重新选择。",
        field: "研究模型名称",
      };
  }
  const route = value?.provider ? value : (inheritedModel ?? catalog?.default);
  const item = catalog?.groups
    .find(({ id }) => id === route?.provider)
    ?.models.find(({ id }) => id === route?.model);
  if (
    value?.reasoningEffort &&
    item &&
    !item.reasoning?.efforts.some(({ id }) => id === value.reasoningEffort)
  )
    return {
      message: "研究模型不支持所选思考强度，请重新选择。",
      field: "研究模型思考强度",
    };
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
  if (draft.runtime.enabledSources.includes("xueqiu")) {
    const missing = xueqiuCookieFields.find(
      ({ name }) => !xueqiuCookieValue(draft.runtime.xueqiuCookie, name).trim(),
    );
    if (missing)
      return {
        message: `请填写雪球 ${missing.name} 的 Value。`,
        field: `雪球 ${missing.name}`,
      };
  }
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
}

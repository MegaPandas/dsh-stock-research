// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigForm,
  ConfigFormSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import { SettingsPage } from "../../src/client/SettingsPage.js";
import type {
  ModelCatalog,
  SettingsValue,
} from "../../src/client/settings-types.js";

afterEach(cleanup);

function settings(): SettingsValue {
  return {
    runtime: {
      dataRoot: "/tmp/stock-settings-fixture",
      enabledSources: ["yahoo", "tencent"],
      http: { timeoutMs: 15000, maxConcurrency: 1, minIntervalMs: 2000 },
      cache: {
        maxEntries: 1000,
        ttl: {
          market: 3600000,
          fundamentals: 86400000,
          macro: 86400000,
          research: 3600000,
        },
      },
      policy: {
        freshness: {
          market: 86400000,
          fundamentals: 17280000000,
          macro: 3888000000,
        },
        secCiks: {},
      },
    },
  };
}
const catalog: ModelCatalog = {
  default: { provider: "fixture", model: "reasoner" },
  groups: [
    {
      id: "fixture",
      name: "测试提供方",
      models: [
        {
          id: "reasoner",
          name: "推理模型",
          reasoning: {
            efforts: [
              { id: "short", name: "简短思考" },
              { id: "deep", name: "深入思考", description: "适用于复杂研究。" },
            ],
          },
        },
        { id: "plain", name: "普通模型" },
      ],
    },
    {
      id: "second",
      name: "其他提供方",
      models: [{ id: "other", name: "其他模型" }],
    },
  ],
};
const loadCatalog = async () => catalog;

function fixture(
  value = settings(),
  changes: Partial<ConfigFormSnapshot<SettingsValue>> = {},
) {
  let snapshot: ConfigFormSnapshot<SettingsValue> = {
    status: "ready",
    value,
    base: settings(),
    user: {},
    revision: 7,
    writable: true,
    ...changes,
  };
  const listeners = new Set<() => void>();
  const mutate = vi.fn<ConfigForm<SettingsValue>["mutate"]>(async () => true);
  const form: ConfigForm<SettingsValue> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mutate,
    set: async () => true,
    unset: async () => true,
  };
  function update(changes: Partial<ConfigFormSnapshot<SettingsValue>>) {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  }
  return { form, mutate, update };
}
function chooseCustom(label = "研究模型") {
  fireEvent.change(screen.getByLabelText(`${label}模式`), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText(`${label}提供方`), {
    target: { value: "fixture" },
  });
  chooseModel(label);
}
function chooseModel(label = "研究模型", name = "推理模型 reasoner") {
  fireEvent.click(screen.getByRole("combobox", { name: `${label}名称` }));
  fireEvent.click(screen.getByRole("option", { name }));
}
async function ready() {
  await screen.findByRole("combobox", { name: "研究模型思考强度" });
  await waitFor(() =>
    expect(
      within(screen.getByLabelText("研究模型思考强度")).getByRole("option", {
        name: "深入思考",
      }),
    ).toBeDefined(),
  );
}

describe("stock research settings page", () => {
  it("starts inherited, offers adapter-owned efforts, and saves an independent effort with the draft revision", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    expect(
      screen.getByText(
        "主 Agent 使用当前 DSH 会话模型。下方配置用于下一次研究的子 Agent、摘要与数据。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "研究模型与思考强度用于研究子 Agent，默认继承主 Agent 的会话设置。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "继承研究模型" })).toBeTruthy();
    expect(
      (screen.getByLabelText("研究模型模式") as HTMLSelectElement).value,
    ).toBe("inherit");
    expect(
      within(screen.getByRole("group", { name: "研究模型" })).getByText(
        "运行时由调用会话决定",
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText("研究模型提供方")).toBeNull();
    fireEvent.change(screen.getByLabelText("研究模型思考强度"), {
      target: { value: "effort:deep" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [{ op: "set", path: ["model"], value: { reasoningEffort: "deep" } }],
        7,
      ),
    );
    expect(
      await screen.findByText("已保存，新建任务使用新设置。"),
    ).toBeDefined();
  });

  it("resets thought strength after changing models and clears the model after changing providers", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    chooseCustom();
    fireEvent.change(screen.getByLabelText("研究模型思考强度"), {
      target: { value: "effort:deep" },
    });
    chooseModel();
    expect(
      (screen.getByLabelText("研究模型思考强度") as HTMLSelectElement).value,
    ).toBe("effort:deep");
    chooseModel("研究模型", "普通模型 plain");
    expect(
      (screen.getByLabelText("研究模型思考强度") as HTMLSelectElement).value,
    ).toBe("inherit");
    expect(
      within(screen.getByRole("group", { name: "研究模型" })).getByText(
        "该模型不支持思考强度配置。",
      ),
    ).toBeDefined();
    expect(
      within(screen.getByLabelText("研究模型思考强度")).queryByRole("option", {
        name: "深入思考",
      }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("研究模型提供方"), {
      target: { value: "second" },
    });
    expect(
      (
        screen.getByRole("combobox", {
          name: "研究模型名称",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "请选择研究模型提供方和模型。",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "研究模型名称" }),
    );
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("searches configured models and saves a separate digest route", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    chooseCustom("摘要模型");
    const model = screen.getByRole("combobox", { name: "摘要模型名称" });
    fireEvent.click(model);
    const options = screen.getByRole("listbox", { name: "摘要模型名称" });
    expect(within(options).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(model, {
      target: { value: "推理" },
    });
    expect(
      within(options).queryByRole("option", {
        name: "普通模型 plain",
      }),
    ).toBeNull();
    fireEvent.click(
      within(options).getByRole("option", { name: "推理模型 reasoner" }),
    );
    expect(screen.queryByLabelText("搜索摘要模型")).toBeNull();
    fireEvent.change(screen.getByLabelText("摘要模型思考强度"), {
      target: { value: "effort:short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          {
            op: "set",
            path: ["runtime", "digestModel"],
            value: {
              provider: "fixture",
              model: "reasoner",
              reasoningEffort: "short",
            },
          },
        ],
        7,
      ),
    );
  });

  it("selects a model with the keyboard without submitting the settings form", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    chooseCustom();
    const model = screen.getByRole("combobox", { name: "研究模型名称" });
    fireEvent.keyDown(model, { key: "ArrowDown" });
    expect(model.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(model, { key: "End" });
    expect(
      document.getElementById(model.getAttribute("aria-activedescendant")!)!
        .textContent,
    ).toContain("普通模型");
    fireEvent.keyDown(model, { key: "Home" });
    fireEvent.keyDown(model, { key: "ArrowDown" });
    fireEvent.keyDown(model, { key: "ArrowUp" });
    fireEvent.keyDown(model, { key: "ArrowDown" });
    fireEvent.keyDown(model, { key: "Enter" });
    expect(model.getAttribute("aria-expanded")).toBe("false");
    expect((model as HTMLInputElement).value).toBe("普通模型");
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          {
            op: "set",
            path: ["model"],
            value: { provider: "fixture", model: "plain" },
          },
        ],
        7,
      ),
    );
  });

  it("filters by model ID, handles no matches, and cancels searches without changing the selection", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    chooseCustom();
    const model = screen.getByRole("combobox", { name: "研究模型名称" });
    fireEvent.click(model);
    fireEvent.change(model, { target: { value: "missing-model" } });
    expect(screen.getByText("没有匹配的模型")).toBeDefined();
    fireEvent.keyDown(model, { key: "Enter" });
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(model, { key: "Escape" });
    expect(model.getAttribute("aria-expanded")).toBe("false");
    expect((model as HTMLInputElement).value).toBe("推理模型");
    fireEvent.click(model);
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(2);
    fireEvent.change(model, { target: { value: "REAS" } });
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("option", { name: "推理模型 reasoner" }),
    ).toBeDefined();
    fireEvent.pointerDown(screen.getByRole("heading", { name: "股票研究" }));
    expect(model.getAttribute("aria-expanded")).toBe("false");
    expect((model as HTMLInputElement).value).toBe("推理模型");
  });

  it("clears the model search when switching providers and offers only the new provider's models", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    chooseCustom();
    const model = screen.getByRole("combobox", { name: "研究模型名称" });
    fireEvent.click(model);
    fireEvent.change(model, { target: { value: "REAS" } });
    fireEvent.change(screen.getByLabelText("研究模型提供方"), {
      target: { value: "second" },
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    chooseModel("研究模型", "其他模型 other");
    expect(
      (
        screen.getByRole("combobox", {
          name: "研究模型名称",
        }) as HTMLInputElement
      ).value,
    ).toBe("其他模型");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          {
            op: "set",
            path: ["model"],
            value: { provider: "second", model: "other" },
          },
        ],
        7,
      ),
    );
  });

  it("clears inherited effort explicitly when model default is selected", async () => {
    const h = fixture();
    render(
      <SettingsPage
        form={h.form}
        loadCatalog={loadCatalog}
        inheritedModel={{
          provider: "fixture",
          model: "reasoner",
          reasoningEffort: "deep",
        }}
      />,
    );
    await ready();
    fireEvent.change(screen.getByLabelText("研究模型思考强度"), {
      target: { value: "default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [{ op: "set", path: ["model"], value: { reasoningEffort: null } }],
        7,
      ),
    );
  });

  it("preserves a rejected draft and its original revision while exposing the conflict", async () => {
    const h = fixture();
    h.mutate.mockImplementation(async () => {
      act(() => h.update({ revision: 8 }));
      return false;
    });
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    fireEvent.change(screen.getByLabelText("研究模型思考强度"), {
      target: { value: "effort:deep" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("草稿已保留"),
    );
    expect(
      (screen.getByLabelText("研究模型思考强度") as HTMLSelectElement).value,
    ).toBe("effort:deep");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(2));
    expect(h.mutate.mock.calls[1]![1]).toBe(7);
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(
      (screen.getByLabelText("研究模型思考强度") as HTMLSelectElement).value,
    ).toBe("inherit");
  });

  it("keeps edits visible on transport failure", async () => {
    const h = fixture();
    h.mutate.mockRejectedValue(new Error("宿主连接中断"));
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    fireEvent.change(screen.getByLabelText("请求超时"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "宿主连接中断",
    );
    expect((screen.getByLabelText("请求超时") as HTMLInputElement).value).toBe(
      "30",
    );
  });

  it("keeps a dirty draft across settings navigation and explicitly rebases edited fields", async () => {
    const h = fixture();
    const first = render(
      <SettingsPage form={h.form} loadCatalog={loadCatalog} />,
    );
    await ready();
    fireEvent.change(screen.getByLabelText("请求超时"), {
      target: { value: "30" },
    });
    first.unmount();
    const latest = settings();
    latest.runtime.cache.maxEntries = 2000;
    act(() => h.update({ value: latest, revision: 8 }));
    h.mutate.mockResolvedValue(false);
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    expect((screen.getByLabelText("请求超时") as HTMLInputElement).value).toBe(
      "30",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(h.mutate.mock.calls[0]![1]).toBe(7);
    fireEvent.click(
      screen.getByRole("button", { name: "保留草稿，采用最新版本" }),
    );
    expect((screen.getByLabelText("缓存容量") as HTMLInputElement).value).toBe(
      "2000",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(2));
    expect(h.mutate.mock.calls[1]).toEqual([
      [{ op: "set", path: ["runtime", "http", "timeoutMs"], value: 30000 }],
      8,
    ]);
  });

  it("requires three Cookie values, masks credentials and saves the joined header", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    fireEvent.click(screen.getByText("数据来源"));
    const xueqiu = screen.getByRole("checkbox", { name: /雪球/ });
    expect((xueqiu as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("group", { name: "雪球请求配置" })).toBeNull();
    fireEvent.click(xueqiu);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "请填写雪球 xq_a_token 的 Value。",
    );
    const group = screen.getByRole("group", { name: "雪球请求配置" });
    expect(group.querySelectorAll("input")).toHaveLength(3);
    const token = screen.getByLabelText("雪球 xq_a_token");
    const user = screen.getByLabelText("雪球 u");
    const login = screen.getByLabelText("雪球 xq_is_login");
    expect(token.getAttribute("type")).toBe("password");
    expect(user.getAttribute("type")).toBe("password");
    expect(document.activeElement).toBe(token);
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.change(token, { target: { value: "fixture-session==" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "请填写雪球 u 的 Value。",
    );
    expect(document.activeElement).toBe(user);
    fireEvent.change(user, { target: { value: "fixture-user" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "请填写雪球 xq_is_login 的 Value。",
    );
    expect(document.activeElement).toBe(login);
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.change(login, { target: { value: "1" } });
    fireEvent.click(xueqiu);
    expect(screen.queryByRole("group", { name: "雪球请求配置" })).toBeNull();
    fireEvent.click(xueqiu);
    expect(
      (screen.getByLabelText("雪球 xq_a_token") as HTMLInputElement).value,
    ).toBe("fixture-session==");
    expect((screen.getByLabelText("雪球 u") as HTMLInputElement).value).toBe(
      "fixture-user",
    );
    expect(
      (screen.getByLabelText("雪球 xq_is_login") as HTMLInputElement).value,
    ).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          {
            op: "set",
            path: ["runtime", "enabledSources"],
            value: ["yahoo", "tencent", "xueqiu"],
          },
          {
            op: "set",
            path: ["runtime", "xueqiuCookie"],
            value:
              "xq_a_token=fixture-session==; u=fixture-user; xq_is_login=1",
          },
        ],
        7,
      ),
    );
  });

  it("validates SEC identity and mapping, preserving fields when the source is disabled", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    const sec = screen.getByRole("checkbox", { name: /SEC/ });
    fireEvent.click(sec);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "启用 SEC 前请填写请求身份与联系方式。",
    );
    fireEvent.change(screen.getByLabelText("SEC 请求身份与联系方式"), {
      target: { value: "Fixture research (contact@example.org)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加发行人" }));
    fireEvent.change(screen.getByLabelText("SEC 股票 ID 1"), {
      target: { value: "US:NVDA" },
    });
    fireEvent.change(screen.getByLabelText("SEC CIK 1"), {
      target: { value: "0000000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "启用 SEC 前请填写股票与有效的十位 CIK 映射。",
    );
    fireEvent.change(screen.getByLabelText("SEC CIK 1"), {
      target: { value: "0001045810" },
    });
    fireEvent.click(sec);
    expect(screen.queryByLabelText("SEC 请求身份与联系方式")).toBeNull();
    fireEvent.click(sec);
    expect(
      (screen.getByLabelText("SEC 请求身份与联系方式") as HTMLInputElement)
        .value,
    ).toBe("Fixture research (contact@example.org)");
    expect((screen.getByLabelText("SEC CIK 1") as HTMLInputElement).value).toBe(
      "0001045810",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
  });

  it("converts readable units to milliseconds and resets fields through inheritance", async () => {
    const initial = settings();
    initial.runtime.http.timeoutMs = 25000;
    const h = fixture(initial, {
      user: { runtime: { http: { timeoutMs: 25000 } } },
    });
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    const timeout = screen.getByLabelText("请求超时");
    expect((timeout as HTMLInputElement).value).toBe("25");
    fireEvent.click(
      within(timeout.closest(".sr-field") as HTMLElement).getByRole("button", {
        name: "恢复默认",
      }),
    );
    fireEvent.change(screen.getByLabelText("行情缓存有效期"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          { op: "unset", path: ["runtime", "http", "timeoutMs"] },
          {
            op: "set",
            path: ["runtime", "cache", "ttl", "market"],
            value: 7200000,
          },
        ],
        7,
      ),
    );
  });

  it("restores all defaults in the draft and protects unsaved browser navigation", async () => {
    const h = fixture();
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    fireEvent.change(screen.getByLabelText("请求超时"), {
      target: { value: "30" },
    });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "恢复全部默认" }));
    expect((screen.getByLabelText("请求超时") as HTMLInputElement).value).toBe(
      "15",
    );
    expect(h.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith([{ op: "unset", path: [] }], 7),
    );
  });

  it("saves a new value after restoring one field without retaining the old reset", async () => {
    const initial = settings();
    initial.runtime.http.timeoutMs = 25000;
    const h = fixture(initial);
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    const timeout = screen.getByLabelText("请求超时");
    fireEvent.click(
      within(timeout.closest(".sr-field") as HTMLElement).getByRole("button", {
        name: "恢复默认",
      }),
    );
    fireEvent.change(timeout, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [{ op: "set", path: ["runtime", "http", "timeoutMs"], value: 40000 }],
        7,
      ),
    );
  });

  it("restores defaults and then applies subsequent field edits in the same save", async () => {
    const initial = settings();
    initial.runtime.http.timeoutMs = 25000;
    initial.runtime.cache.maxEntries = 2000;
    const h = fixture(initial);
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "恢复全部默认" }));
    fireEvent.change(screen.getByLabelText("请求超时"), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [
          { op: "unset", path: [] },
          { op: "set", path: ["runtime", "http", "timeoutMs"], value: 40000 },
        ],
        7,
      ),
    );
  });

  it("does not invent composition defaults when the host has no base layer", async () => {
    const h = fixture(settings(), { base: undefined });
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    expect(
      (
        screen.getByRole("button", {
          name: "恢复全部默认",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "恢复默认目录",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "恢复研究模型继承" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        [{ op: "set", path: ["model"], value: {} }],
        7,
      ),
    );
  });

  it.each([2, 0])(
    "saves the public search approval limit %s while displaying the default for old configurations",
    async (limit) => {
      const h = fixture();
      render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
      await ready();
      const input = screen.getByLabelText("免审批搜索次数上限");
      expect((input as HTMLInputElement).value).toBe("8");
      fireEvent.change(input, { target: { value: String(limit) } });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() =>
        expect(h.mutate).toHaveBeenCalledWith(
          [{ op: "set", path: ["publicSearchLimit"], value: limit }],
          7,
        ),
      );
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid public search approval limit %s",
    async (limit) => {
      const h = fixture();
      render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
      await ready();
      const input = screen.getByLabelText("免审批搜索次数上限");
      fireEvent.change(input, { target: { value: String(limit) } });
      fireEvent.submit(input.closest("form")!);
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "免审批搜索次数上限须为非负安全整数。",
      );
      expect(document.activeElement).toBe(input);
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 5])(
    "restores the public search limit from composition or its schema default: %s",
    async (limit) => {
      const initial = settings();
      initial.publicSearchLimit = 2;
      const base = settings();
      if (limit !== undefined) base.publicSearchLimit = limit;
      const h = fixture(initial, { base });
      render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
      await ready();
      const input = screen.getByLabelText("免审批搜索次数上限");
      fireEvent.click(
        within(input.closest("fieldset")!).getByRole("button", {
          name: "恢复默认",
        }),
      );
      expect((input as HTMLInputElement).value).toBe(String(limit ?? 8));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() =>
        expect(h.mutate).toHaveBeenCalledWith(
          [{ op: "unset", path: ["publicSearchLimit"] }],
          7,
        ),
      );
    },
  );

  it.each(["loading", "unavailable"] as const)(
    "shows the %s state without editable controls",
    (status) => {
      const h = fixture(settings(), { status, value: undefined });
      render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
      expect(screen.getByRole("status").textContent).toContain(
        status === "loading" ? "正在加载" : "未提供",
      );
      expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    },
  );

  it("shows a read-only form without writes", async () => {
    const h = fixture(settings(), { writable: false });
    render(<SettingsPage form={h.form} loadCatalog={loadCatalog} />);
    await ready();
    expect(screen.getByText("当前配置只读，无法保存修改。")).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "保存",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("研究模型模式") as HTMLSelectElement).closest(
        "fieldset",
      )?.disabled,
    ).toBe(true);
  });
});

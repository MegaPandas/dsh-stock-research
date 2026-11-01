import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ApplicationConfig } from "../../contracts/settings.js";

type Operation = Parameters<ConfigForm<ApplicationConfig>["mutate"]>[0][number];
type SettingValue = Extract<Operation, { op: "set" }>["value"];
interface RetainedDraft {
  draft: ApplicationConfig;
  original: ApplicationConfig;
  revision: number | undefined;
  resets: string[];
}
// Settings navigation unmounts pages without a before-leave hook.
const retainedDrafts = new WeakMap<
  ConfigForm<ApplicationConfig>,
  RetainedDraft
>();
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function at(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node === undefined || node === null
        ? undefined
        : Reflect.get(node as object, key),
    value,
  );
}
function changed(
  value: ApplicationConfig,
  path: string[],
  replacement: unknown,
): ApplicationConfig {
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
  const model = path.join(".") === "model";
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
  return [{ op: "set", path, value: after as SettingValue }];
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSettingsDraft(form: ConfigForm<ApplicationConfig>) {
  const snapshot = useSyncExternalStore(
    (listener) => form.subscribe(listener),
    () => form.getSnapshot(),
  );
  const [draft, setDraft] = useState<ApplicationConfig | undefined>(
    () => retainedDrafts.get(form)?.draft,
  );
  const [original, setOriginal] = useState<ApplicationConfig | undefined>(
    () => retainedDrafts.get(form)?.original,
  );
  const [revision, setRevision] = useState<number | undefined>(
    () => retainedDrafts.get(form)?.revision,
  );
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
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const base = snapshot.base as ApplicationConfig | undefined;
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
  const reset = (path: string[], replacement: unknown = at(base, path)) => {
    setDraft((current) => changed(current!, path, replacement));
    setResets((current) => [
      ...current.filter((item) => !item.startsWith(path.join("."))),
      path.join("."),
    ]);
    setError("");
    setSaved(false);
  };
  const save = async () => {
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
        draft: accepted.value ?? draft!,
        original: accepted.value ?? draft!,
        revision: accepted.revision,
        resets: [],
      });
      setDraft(structuredClone(accepted.value ?? draft!));
      setOriginal(structuredClone(accepted.value ?? draft!));
      setRevision(accepted.revision);
      setResets([]);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
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
  const discard = () => {
    const current = form.getSnapshot();
    setDraft(structuredClone(current.value!));
    setOriginal(structuredClone(current.value!));
    setRevision(current.revision);
    setResets([]);
    setError("");
    setSaved(false);
  };
  const resetAll = () => {
    setDraft(structuredClone(base!));
    setResets([""]);
    setError("");
    setSaved(false);
  };
  return {
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
    save,
    refreshDraft,
    discard,
    resetAll,
  };
}

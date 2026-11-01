import assert from "node:assert/strict";
import console from "node:console";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";

// Build scripts/fixtures/research-card.ts with the same options for each frozen version.
const { ResearchJobCard } = await import(
  pathToFileURL(resolve(process.argv[2])).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const previousGlobals = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import("react-dom/client");
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeNow = Date.now;
let clock = 2000;
const timers = new Map();
let timerId = 0;
globalThis.setInterval = (callback) => {
  timers.set(++timerId, callback);
  return timerId;
};
globalThis.clearInterval = (id) => timers.delete(id);
Date.now = () => clock;

const owner = "synthetic-session";
const parent = "research";
const initialIds = ["market", "finance"];
const message =
  JSON.stringify({
    type: "research/message",
    text: "人工固定日志，保留来源与研究限制。".repeat(16),
  }) + "\n";
const body = message.repeat(Math.floor((128 * 1024 - 2048) / message.length));
const parentText = (ids, revision) =>
  body +
  JSON.stringify({
    type: "research/progress",
    progress: {
      text: `人工研究进度 ${revision}`,
      state: {
        status: "active",
        phase: { kind: "tasks", completed: 0, total: 12, currentTaskIds: [] },
        operationIds: ids,
      },
    },
  }) +
  "\n";
const observation = (jobId, text) => ({
  jobId,
  text,
  gapBefore: false,
  streaming: true,
});
const rows = [parent, ...initialIds, "risk"].map((id) => ({
  id,
  kind: id === parent ? "stock-research" : "stock-research-step",
  owner,
  label: id,
  status: "running",
  startedAt: 1000,
  output: { total: 0, earliest: 0 },
}));
const data = {
  anchorSeq: 0,
  jobId: parent,
  registration: {
    jobId: parent,
    owner,
    kind: "stock-research",
    label: "人工研究",
    startedAt: 1000,
  },
};
const batches = 5;
const iterations = 20;

function measure(label) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const listeners = new Set();
  const active = new Map();
  let watches = 0;
  let acquired = 0;
  let released = 0;
  let revision = 0;
  let observed = {
    [parent]: observation(parent, parentText(initialIds, revision)),
    market: observation("market", message.repeat(12)),
    finance: observation("finance", message.repeat(12)),
    risk: observation("risk", message.repeat(12)),
  };
  let snapshot = { rows: { [owner]: rows }, observed };
  const jobs = {
    state: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    watchRows() {
      watches++;
      return () => watches--;
    },
    observe(_owner, id) {
      acquired++;
      active.set(id, (active.get(id) ?? 0) + 1);
      return () => {
        released++;
        active.set(id, active.get(id) - 1);
      };
    },
    kill: async () => ({ ok: true, value: { outcome: "requested" } }),
  };
  function update(id, text) {
    observed = { ...observed, [id]: observation(id, text) };
    snapshot = { ...snapshot, observed };
    act(() => {
      for (const listener of listeners) listener();
    });
  }
  function action() {
    if (label === "parent-text")
      update(parent, parentText(initialIds, ++revision));
    else if (label === "child-text")
      update(
        "finance",
        message.repeat(12) +
          JSON.stringify({
            type: "research/message",
            text: `人工子任务 ${++revision}`,
          }),
      );
    else if (label === "clock-tick") {
      clock += 1000;
      act(() => {
        for (const callback of timers.values()) callback();
      });
    } else {
      for (const ids of [
        ["market"],
        ["market", "risk"],
        ["risk", "market"],
        initialIds,
      ])
        update(parent, parentText(ids, ++revision));
    }
  }
  try {
    act(() =>
      root.render(
        createElement(ResearchJobCard, { data, sessionId: owner, jobs }),
      ),
    );
    for (let i = 0; i < 10; i++) action();
    const samples = [];
    for (let batch = 0; batch < batches; batch++) {
      const started = performance.now();
      for (let i = 0; i < iterations; i++) action();
      samples.push((performance.now() - started) / iterations);
    }
    acquired = 0;
    released = 0;
    const parse = JSON.parse;
    let parsedRecords = 0;
    let parsedCharacters = 0;
    JSON.parse = (text, ...args) => {
      if (typeof text === "string" && text.startsWith('{"type":"research/')) {
        parsedRecords++;
        parsedCharacters += text.length;
      }
      return parse(text, ...args);
    };
    try {
      action();
    } finally {
      JSON.parse = parse;
    }
    assert.match(
      container.querySelector('[role="status"]').textContent,
      /进行中/,
    );
    assert.deepEqual(
      [...active]
        .filter(([, count]) => count > 0)
        .map(([id]) => id)
        .sort(),
      [parent, ...initialIds].sort(),
    );
    assert.equal(watches, 1);
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      label,
      batches,
      iterations,
      medianMs: sorted[2],
      minMs: sorted[0],
      maxMs: sorted.at(-1),
      batchMeansMs: samples,
      acquired,
      released,
      parsedRecords,
      parsedCharacters,
    };
  } finally {
    act(() => root.unmount());
    container.remove();
    assert.equal(watches, 0);
    assert.ok([...active.values()].every((count) => count === 0));
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
  }
}

try {
  const measurements = [
    "parent-text",
    "child-text",
    "clock-tick",
    "operation-set",
  ].map(measure);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        inputCharacters: parentText(initialIds, 0).length,
        workload:
          "React and jsdom, synthetic native Jobs snapshots, bounded parent log, two child streams; no network or model; controlled interval ticks",
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  Date.now = nativeNow;
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
}

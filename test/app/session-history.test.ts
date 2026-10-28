import fs from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quickHost, researchCommands } from "../fixtures/quick-host.js";
import { workflowModel } from "../fixtures/research-workflow.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2024-01-03T08:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              sz002594: {
                day: [["2024-01-03", "190", "192", "193", "189", "100"]],
              },
            },
          }),
        ),
    ),
  );
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("durable research chat history", () => {
  it("reopens a completed research chat with the native persistence reader after restart", async () => {
    const model = workflowModel();
    const h = await quickHost(model.respond);
    cleanups.push(h.close);
    const id = SessionId("research-restart");
    const events: SessionEvent[] = [];
    h.ctx.on("session/event", (session, event) => {
      if (session.id === id) events.push(event);
    });
    const main = await h.ctx.agents.create(h.agentOptions(id));
    cleanups.push(() => main.dispose());
    const commands = researchCommands(h.ctx, main.agent);
    expect((await commands.executeAndWait())?.result.kind).toBe("success");
    expect(events.some(({ type }) => type === "job/registered")).toBe(true);
    expect(events.some(({ type }) => type.startsWith("stock-research/"))).toBe(
      false,
    );
    const researchJob = events.find(
      (event): event is SessionEvent<"job/registered"> =>
        event.type === "job/registered" && event.data.kind === "stock-research",
    )!;
    expect(
      events.find(
        (event) =>
          event.type === "job/settled" &&
          event.data.jobId === researchJob.data.jobId,
      ),
    ).toMatchObject({ data: { status: "completed" } });
    const root = join(h.directory, "session-history");
    const writerContext = new Context();
    const writer = writerContext.plugin(Jsonl, { root, compression: "zstd" });
    await writer;
    try {
      const handle = await writerContext.sessionPersistence.create(
        main.agent.session.header,
      );
      try {
        await handle.append(events);
        await handle.flush();
      } finally {
        await handle.close();
      }
    } finally {
      await writer.dispose();
    }
    const readerContext = new Context();
    const reader = readerContext.plugin(Jsonl, { root, compression: "zstd" });
    await reader;
    try {
      const handle = await readerContext.sessionPersistence.open(id, "read");
      try {
        const restored = await handle.read();
        expect(restored.events).toEqual(events);
        expect(restored.events.at(-1)!.type).toBe("turn/end");
      } finally {
        await handle.close();
      }
    } finally {
      await reader.dispose();
      fs.rmSync(root, { recursive: true });
    }
  });
});

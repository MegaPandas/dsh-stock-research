import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftFile, taskDraftFile } from "../../src/host/draft-file.js";
import { draftFileTools } from "../../src/tools/draft-file.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(format: "markdown" | "json" = "markdown") {
  const directory = await mkdtemp(join(tmpdir(), "stock-draft-"));
  const ctx = new Context();
  cleanups.push(async () => {
    try {
      await ctx.fiber.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await ctx.plugin(LocalFileSystem, { cwd: directory });
  const file = new DraftFile(ctx.fs, join(directory, "drafts", "task.md"));
  const signal = new AbortController().signal;
  const tools = draftFileTools(file, format);
  const call = (name: string, args: unknown) =>
    tools
      .find((tool) => tool.name === name)!
      .execute(args, { signal } as ToolRunContext);
  return { file, fs: ctx.fs, signal, call, directory };
}

describe("fixed draft file", () => {
  it("exposes JSON draft content and save receipts without a filesystem path", async () => {
    const { call, file, signal } = await fixture("json");
    await expect(
      call("stock_write_draft", { content: '{"thesis":"Original"}' }),
    ).resolves.toEqual({ status: "saved" });
    await expect(call("stock_read_draft", {})).resolves.toEqual({
      content: '{"thesis":"Original"}',
    });
    await expect(
      call("stock_edit_draft", { oldText: "Original", newText: "Updated" }),
    ).resolves.toEqual({ status: "saved" });
    expect(await file.read(signal)).toBe('{"thesis":"Updated"}');
    await expect(
      call("stock_edit_draft", { oldText: "", newText: "invalid" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await file.read(signal)).toBe('{"thesis":"Updated"}');
  });
  it("retains the task document across attempts and keeps task identifiers in one filename", async () => {
    const { fs, signal, directory } = await fixture();
    const first = { runId: "run", taskId: "../analysis.market", attempt: 1 };
    const retry = { ...first, attempt: 2 };
    const original = taskDraftFile(fs, directory, first);
    await original.write(
      '```json\n{"title":"Work in progress"}\n```\nRetained body',
      signal,
    );
    const resumed = taskDraftFile(fs, directory, retry);
    expect(resumed.path).toBe(original.path);
    expect(dirname(resumed.path)).toBe(join(directory, "run"));
    expect(await resumed.read(signal)).toContain("Retained body");
  });
  it("reads, writes and atomically edits the fixed Markdown file through the SDK", async () => {
    const { file, fs, signal, call } = await fixture();
    const resolve = vi.spyOn(fs, "resolve");
    await expect(
      call("stock_write_draft", {
        content: '```json\n{"title":"Result"}\n```\n# Draft\nOld text\n',
      }),
    ).resolves.toEqual({ path: file.path });
    await call("stock_edit_draft", {
      oldText: "Old text",
      newText: "New text",
    });
    await expect(file.value(signal)).resolves.toEqual({
      title: "Result",
      body: "# Draft\nNew text\n",
    });
    await expect(call("stock_read_draft", {})).resolves.toEqual({
      path: file.path,
      content: '```json\n{"title":"Result"}\n```\n# Draft\nNew text\n',
    });
    await call("stock_edit_draft", { oldText: "New text", newText: "" });
    expect(await file.read(signal)).toContain("# Draft\n\n");
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(file.path, { signal });
    await call("stock_write_draft", { content: "" });
    expect(await file.read(signal)).toBe("");
  });

  it("preserves CRLF Markdown body without completing blank content", async () => {
    const { file, signal } = await fixture();
    await file.write(
      '```json\r\n{"status":"draft"}\r\n```\r\n\r\n  \r\n',
      signal,
    );
    await expect(file.value(signal)).resolves.toEqual({
      status: "draft",
      body: "\r\n  \r\n",
    });
  });

  it.each([
    ["# private draft text", "opening JSON metadata fence"],
    [
      '```json\n{"private draft text": }\n```\nsecret body',
      "Invalid JSON metadata syntax",
    ],
    ["```json\n[]\n```\nsecret body", "must be an object"],
    [
      '```json\n{"body":"secret metadata"}\n```\nsecret body',
      "cannot contain body",
    ],
  ])(
    "reports parse errors with the file path and no draft text",
    async (content, reason) => {
      const { file, signal } = await fixture();
      await file.write(content, signal);
      const error = await file.value(signal).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining(file.path),
      });
      expect((error as Error).message).toContain(reason);
      expect((error as Error).message).not.toMatch(
        /private draft text|secret body|secret metadata/,
      );
    },
  );

  it("preserves SDK missing-file and unmatched-edit errors", async () => {
    const { file, signal } = await fixture();
    await expect(file.read(signal)).rejects.toBeInstanceOf(FsError);
    await expect(file.value(signal)).rejects.toMatchObject({
      code: "FS_NOT_FOUND",
    });
    await file.write("existing draft", signal);
    await expect(
      file.edit("missing", "replacement", signal),
    ).rejects.toMatchObject({ code: "FS_EDIT_NOT_FOUND" });
    expect(await file.read(signal)).toBe("existing draft");
  });

  it("rejects arbitrary paths and empty edit matches before filesystem I/O", async () => {
    const { fs, call } = await fixture();
    const resolve = vi.spyOn(fs, "resolve");
    for (const [name, args] of [
      ["stock_read_draft", { path: "/other.md" }],
      ["stock_write_draft", { path: "/other.md", content: "draft" }],
      ["stock_edit_draft", { path: "/other.md", oldText: "a", newText: "b" }],
      ["stock_edit_draft", { oldText: "", newText: "b" }],
    ] as const) {
      await expect(call(name, args)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { join } from "node:path";
import { ResearchError } from "../contracts/errors.js";
import type { TaskOperation } from "../contracts/runs.js";

/** Attempts edit the same task document; published artifact versions stay immutable. */
export function taskDraftFile(
  fs: FileSystem,
  directory: string,
  operation: Pick<TaskOperation, "runId" | "taskId">,
): DraftFile {
  return new DraftFile(
    fs,
    join(
      directory,
      operation.runId,
      `task-${encodeURIComponent(operation.taskId)}.md`,
    ),
  );
}

export class DraftFile {
  private target?: Promise<FsTarget>;

  constructor(
    private readonly fs: FileSystem,
    readonly path: string,
  ) {}

  private resolve(signal: AbortSignal): Promise<FsTarget> {
    return (this.target ??= this.fs.resolve(this.path, { signal }));
  }

  async read(signal: AbortSignal): Promise<string> {
    return this.fs.readText(await this.resolve(signal), signal);
  }

  async write(content: string, signal: AbortSignal): Promise<void> {
    await this.fs.writeText(
      await this.resolve(signal),
      content,
      undefined,
      signal,
    );
  }

  async edit(
    oldText: string,
    newText: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.fs.editText(
      await this.resolve(signal),
      { oldString: oldText, newString: newText, replaceAll: false },
      undefined,
      signal,
    );
  }

  async value(signal: AbortSignal): Promise<Record<string, unknown>> {
    const content = await this.read(signal);
    const match = /^```json\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/.exec(content);
    if (!match)
      this.invalid(
        "Expected an opening JSON metadata fence followed by Markdown body.",
      );
    let metadata: unknown;
    try {
      metadata = JSON.parse(match[1]!);
    } catch (cause) {
      // Node may append a quoted draft excerpt; the diagnostic needs no copy.
      const reason = (cause as SyntaxError).message.split(', "')[0];
      this.invalid(`Invalid JSON metadata syntax: ${reason}`);
    }
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata)
    )
      this.invalid("JSON metadata must be an object.");
    if (Object.hasOwn(metadata, "body"))
      this.invalid(
        "JSON metadata cannot contain body; use the Markdown body after the fence.",
      );
    return { ...metadata, body: content.slice(match[0].length) };
  }

  private invalid(reason: string): never {
    throw new ResearchError(
      "INVALID_INPUT",
      `Draft file ${this.path}: ${reason}`,
    );
  }
}

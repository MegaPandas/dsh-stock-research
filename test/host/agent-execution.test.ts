import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { createSubmission } from "../../src/host/agent-execution.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { ROLE_PROMPTS } from "../../src/app/research-prompts.js";
import { PUBLIC_ANALYST_PROMPT } from "../../src/app/public-research.js";
import { ASK_PROMPT } from "../../src/app/ask-prompt.js";
import { REVIEW_PROMPT } from "../../src/app/review-prompt.js";
import { COORDINATOR_PROMPT } from "../../src/app/coordinator-prompt.js";

const report = {
  summary: "现金回流随回款改善。",
  content: { explanation: [], limitations: [] },
};
function execution() {
  return {
    signal: new AbortController().signal,
    callId: ToolCallId("submit-1"),
    concludeTurn: vi.fn(),
    agent: { cancel: vi.fn() },
  } as unknown as ToolRunContext;
}

describe("shared Agent submission", () => {
  it("returns a real receipt only after a valid business commit and ends the turn", async () => {
    const accept = vi.fn(() => ({ receipt: "saved" }));
    const submission = createSubmission("ask", accept);
    const exec = execution();
    await expect(submission.tool.execute(report, exec)).resolves.toEqual({
      status: "submitted",
    });
    expect(accept).toHaveBeenCalledWith(report, exec);
    expect(submission.result()).toEqual({ receipt: "saved" });
    expect(exec.concludeTurn).toHaveBeenCalledOnce();
  });

  it("returns structural errors to the session and accepts a corrected result", async () => {
    const accept = vi.fn(() => "answer");
    const submission = createSubmission("ask", accept);
    const exec = execution();
    await expect(
      submission.tool.execute({ ...report, citations: [] }, exec),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(accept).not.toHaveBeenCalled();
    expect(exec.agent!.cancel).not.toHaveBeenCalled();
    expect(() => submission.result()).toThrow(/citations/);
    await submission.tool.execute(report, exec);
    expect(submission.result()).toBe("answer");
  });

  it("preserves storage failure and cancels the producer without claiming a submission", async () => {
    const cause = new ResearchError("STORAGE_FAILED", "disk unavailable");
    const submission = createSubmission("ask", () => {
      throw cause;
    });
    const exec = execution();
    await expect(submission.tool.execute(report, exec)).rejects.toMatchObject({
      code: "STORAGE_FAILED",
    });
    expect(() => submission.result()).toThrow(cause);
    expect(exec.agent!.cancel).toHaveBeenCalledOnce();
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });

  it("rejects completion without a submission", () => {
    expect(() => createSubmission("ask", () => "answer").result()).toThrow(
      /without submitting/,
    );
  });

  it("composes the writing rule and native submission instruction for every current role", () => {
    for (const prompt of [
      ...Object.values(ROLE_PROMPTS),
      PUBLIC_ANALYST_PROMPT,
      ASK_PROMPT,
      REVIEW_PROMPT,
    ]) {
      expect(prompt).toContain(
        "Delete defensive wording that only anticipates objections and adds no information about the subject.",
      );
      expect(prompt).toContain("stock_submit");
      expect(prompt).not.toMatch(
        /stock_write_draft|stock_save_report|stock_remember\(/,
      );
    }
  });

  it("lets the host main Agent orchestrate research and deliver ordinary chat responses", () => {
    expect(COORDINATOR_PROMPT).toContain("stock_start_research");
    expect(COORDINATOR_PROMPT).toContain("stock_review_stage");
    expect(COORDINATOR_PROMPT).toContain("in this chat");
    expect(COORDINATOR_PROMPT).not.toContain("stock_submit");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DigestPayload } from "../../src/contracts/artifact-payloads.js";
import type {
  DigestDraft,
  DigestModelInput,
} from "../../src/contracts/digests.js";
import { DigestService } from "../../src/services/digests.js";
import { ResearchError } from "../../src/contracts/errors.js";
import { NumberService } from "../../src/services/numbers.js";
import { oneDigest } from "../fixtures/digest-conversation.js";
import {
  decisionFixture,
  type DecisionFixtureOptions,
} from "../fixtures/decision.js";

const fixtures: ReturnType<typeof decisionFixture>[] = [];
function setup(options: DecisionFixtureOptions = {}) {
  const c = decisionFixture(options);
  fixtures.push(c);
  c.runs.redo(c.operation, "digest", "redo");
  return c;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of fixtures.splice(0)) c.close();
});
function draft(context: DigestModelInput): DigestDraft {
  return {
    title: "Digest",
    body: "Price {{number:n0}}",
    inputRefs: context.artifacts.map((v) => v.ref),
    facts: [
      {
        text: "Price {{number:n0}}",
        inputRefs: [context.artifacts[0]!.ref],
        numbers: ["n0"],
      },
    ],
    disagreements: [],
    riskSummaries: context.risks.map((risk) => ({
      issueId: risk.issueId,
      text: "Risk summary",
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function task(c: ReturnType<typeof setup>, id = "digest") {
  return c.runs.view(c.operation).tasks.find((value) => value.taskId === id)!;
}
function content(
  c: ReturnType<typeof setup>,
  refs: { runId: string; artifactId: string; revision: number }[],
) {
  return c.runs.readArtifact(refs[0]!).content;
}

describe("DigestService", () => {
  it("forwards the recorded digest protocol to the selected generator", async () => {
    const c = setup();
    const catalog = c.runs.inputCatalog(c.operation.runId);
    vi.spyOn(c.runs, "inputCatalog").mockReturnValue({
      ...catalog,
      versions: {
        ...catalog.versions,
        prompts: { ...catalog.versions.prompts, digest: "8" },
      },
    });
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(generate),
    ).makeDigest(c.operation, "digest", "recorded-protocol");
    expect(generate.mock.calls[0]![0].protocolVersion).toBe("8");
  });

  it("keeps the same attempt running after a rejected draft and publishes its correction", async () => {
    const c = setup();
    const service = new DigestService(
      c.runs,
      c.artifacts,
      async (context, _signal, operation, submit) => {
        const corrected = draft(context);
        expect(() => submit({ ...corrected, riskSummaries: [] })).toThrowError(
          expect.objectContaining({
            code: "INVALID_ARTIFACT",
            message: expect.stringContaining("liquidity"),
          }),
        );
        expect(c.runs.readAttempt(operation)).toMatchObject({
          status: "running",
          outputRefs: [],
          failure: null,
        });
        return submit(corrected);
      },
    );
    const saved = await service.makeDigest(c.operation, "digest", "correction");
    expect(c.runs.readAttempt(saved)).toMatchObject({
      status: "succeeded",
      outputRefs: saved.refs,
      failure: null,
    });
    expect(content(c, saved.refs)).toMatchObject({
      kind: "digest",
      payload: { risks: [expect.objectContaining({ issueId: "liquidity" })] },
    });
  });
  it("publishes bound numbers and inherited risk metadata without new claims", async () => {
    const c = setup();
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    const saved = await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(generate),
    ).makeDigest(c.operation, "digest", "make");
    const output = content(c, saved.refs);
    expect(output.claims).toEqual([]);
    expect(output.body).toContain("Price 100 USD/股");
    expect(output.body).not.toContain("数值与引用");
    expect(output.body).not.toContain(c.analysisRef.artifactId);
    const payload = output.payload as DigestPayload;
    expect(payload.numbers).toContainEqual({
      kind: "artifact",
      artifact: c.analysisRef,
      claimId: "base",
    });
    expect(payload.facts[0]!.evidence).toEqual([c.analysisRef]);
    expect(payload.risks[0]).toMatchObject({
      issueId: "liquidity",
      description: "Liquidity uncertainty",
      impact: "Execution impact",
      trigger: "Volume declines",
      constraint: "Position restraint",
      recommendation: "Monitor liquidity",
    });
    expect(task(c).status).toBe("succeeded");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("isolates model mutations from committed numeric values and metadata", async () => {
    const c = setup();
    const generate = async (context: DigestModelInput) => {
      const reply = draft(context);
      context.numbers[0]!.claim.value = 999;
      context.risks[0]!.description = "Rewritten risk";
      context.artifacts[0]!.content.title = "Rewritten title";
      return reply;
    };
    const saved = await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(generate),
    ).makeDigest(c.operation, "digest", "make");
    const output = content(c, saved.refs);
    expect(output.body).toContain("Price 100 USD/股");
    expect(output.body).not.toContain("999 USD/股");
    expect(c.runs.readArtifact(c.analysisRef).content.claims).toContainEqual(
      expect.objectContaining({ id: "base", value: 100, unit: "USD/share" }),
    );
    expect((output.payload as DigestPayload).risks[0]!.description).toBe(
      "Liquidity uncertainty",
    );
    expect(c.runs.readArtifact(c.analysisRef).content.title).toBe(
      "Market analysis",
    );
  });
  it.each([
    "missing risk",
    "wrong reference",
    "unknown number",
    "raw response",
  ] as const)("rejects %s without publishing success", async (mode) => {
    const c = setup();
    const generate = async (context: DigestModelInput) => {
      if (mode === "raw response") return "Price 100 USD/share";
      const reply = draft(context);
      if (mode === "missing risk") reply.riskSummaries = [];
      if (mode === "wrong reference")
        reply.facts[0]!.inputRefs = [{ ...c.analysisRef, revision: 999 }];
      if (mode === "unknown number") reply.facts[0]!.numbers = ["n999"];
      return reply;
    };
    await expect(
      new DigestService(c.runs, c.artifacts, oneDigest(generate)).makeDigest(
        c.operation,
        "digest",
        "make",
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    expect(task(c).status).toBe("failed");
    expect(task(c).outputRefs).toEqual([]);
  });
  it("uses the real number gate once for the new empty claim set", async () => {
    const c = setup();
    const checked = vi.spyOn(NumberService.prototype, "checkNumbers");
    await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(async (context) => draft(context)),
    ).makeDigest(c.operation, "digest", "make");
    expect(checked).toHaveBeenCalledTimes(1);
    expect(checked.mock.calls[0]![1]).toMatchObject({
      kind: "pending",
      content: { kind: "digest", claims: [] },
    });
  });
  it("shares one model call for concurrent identical requests", async () => {
    const c = setup();
    const ready = deferred<void>();
    const release = deferred<void>();
    const generate = vi.fn(async (context: DigestModelInput) => {
      ready.resolve();
      await release.promise;
      return draft(context);
    });
    const service = new DigestService(c.runs, c.artifacts, oneDigest(generate));
    const first = service.makeDigest(c.operation, "digest", "make");
    await ready.promise;
    const second = service.makeDigest(c.operation, "digest", "make");
    release.resolve();
    expect(await second).toEqual(await first);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("replays successful receipts across a new service without invoking the model", async () => {
    const c = setup();
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    const service = new DigestService(c.runs, c.artifacts, oneDigest(generate));
    const saved = await service.makeDigest(c.operation, "digest", "make");
    expect(await service.makeDigest(c.operation, "digest", "make")).toEqual(
      saved,
    );
    const unused = vi.fn(async () => {
      throw new Error("must not generate");
    });
    expect(
      await new DigestService(
        c.runs,
        c.artifacts,
        oneDigest(unused),
      ).makeDigest(c.operation, "digest", "make"),
    ).toEqual(saved);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
  });
  it("preserves model errors and permits retry under a new request", async () => {
    const c = setup();
    const error = new Error("model unavailable");
    const generate = vi
      .fn(async (context: DigestModelInput) => draft(context))
      .mockRejectedValueOnce(error);
    const service = new DigestService(c.runs, c.artifacts, oneDigest(generate));
    await expect(
      service.makeDigest(c.operation, "digest", "failed"),
    ).rejects.toBe(error);
    expect(task(c).status).toBe("failed");
    await service.makeDigest(c.operation, "digest", "retry");
    expect(task(c).status).toBe("succeeded");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("repairs a post-publication projection failure without regenerating or failing the published task", async () => {
    const c = setup();
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    const service = new DigestService(c.runs, c.artifacts, oneDigest(generate));
    const failure = new ResearchError(
      "STORAGE_FAILED",
      "Simulated projection write failure",
    );
    vi.spyOn(c.runs, "repairProjections").mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      service.makeDigest(c.operation, "digest", "make"),
    ).rejects.toBe(failure);
    expect(task(c).status).toBe("succeeded");
    const saved = task(c).outputRefs;
    expect(
      (await service.makeDigest(c.operation, "digest", "make")).refs,
    ).toEqual(saved);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(task(c).failure).toBeNull();
  });
  it("forwards abort and waits for the cooperative callback before ending the attempt", async () => {
    const c = setup();
    const controller = new AbortController();
    const ready = deferred<void>();
    const release = deferred<void>();
    let returned = false;
    const generate = vi.fn(
      async (context: DigestModelInput, signal?: AbortSignal) => {
        expect(signal?.aborted).toBe(false);
        ready.resolve();
        await release.promise;
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBe(controller.signal.reason);
        returned = true;
        return draft(context);
      },
    );
    const pending = new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(generate),
    ).makeDigest(c.operation, "digest", "make", controller.signal);
    await ready.promise;
    const reason = new Error("stop generation");
    controller.abort(reason);
    expect(returned).toBe(false);
    expect(task(c).status).toBe("running");
    const rejected = expect(pending).rejects.toBe(reason);
    release.resolve();
    await rejected;
    expect(returned).toBe(true);
    expect(task(c).status).toBe("failed");
    expect(task(c).outputRefs).toEqual([]);
  });
  it("does not claim or generate for an already aborted signal", async () => {
    const c = setup();
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    await expect(
      new DigestService(c.runs, c.artifacts, oneDigest(generate)).makeDigest(
        c.operation,
        "digest",
        "make",
        controller.signal,
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(generate).not.toHaveBeenCalled();
    expect(task(c).status).toBe("pending");
  });
  it("rejects late output after redo without failing the replacement attempt", async () => {
    const c = setup();
    const ready = deferred<void>();
    const release = deferred<void>();
    const service = new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(async (context) => {
        ready.resolve();
        await release.promise;
        return draft(context);
      }),
    );
    const pending = service.makeDigest(c.operation, "digest", "make");
    await ready.promise;
    c.runs.redo(c.operation, "digest", "redo-again");
    const replacement = c.runs.claim(c.operation, "digest", "replacement");
    const rejected = expect(pending).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    release.resolve();
    await rejected;
    expect(task(c).status).toBe("running");
    expect(task(c).attempt).toBe(replacement.attempt);
    expect(task(c).failure).toBeNull();
    expect(task(c).outputRefs).toEqual([]);
  });
  it("does not publish late output after run cancellation", async () => {
    const c = setup();
    const ready = deferred<void>();
    const release = deferred<void>();
    const pending = new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(async (context) => {
        ready.resolve();
        await release.promise;
        return draft(context);
      }),
    ).makeDigest(c.operation, "digest", "make");
    await ready.promise;
    c.runs.cancel(c.operation, "cancel");
    const rejected = expect(pending).rejects.toBeDefined();
    release.resolve();
    await rejected;
    expect(c.runs.view(c.operation).status).toBe("cancelled");
    expect(task(c).outputRefs).toEqual([]);
  });
  it("retains source gap attribution automatically", async () => {
    const gap = {
      code: "missing" as const,
      field: "/data/bars/1/volume",
      detail: "Volume unavailable",
    };
    const c = setup({
      frame: (frame) => {
        frame.envelope.data.bars[1]!.volume = null;
        frame.envelope.gaps.push(gap);
      },
    });
    const saved = await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(async (context) => draft(context)),
    ).makeDigest(c.operation, "digest", "make");
    expect(
      (content(c, saved.refs).payload as DigestPayload).gaps,
    ).toContainEqual({
      kind: "source",
      source: {
        runId: c.source.runId,
        evidenceId: c.source.evidenceId,
        selector: "",
      },
      gap,
    });
    expect(content(c, saved.refs).body).not.toContain("## 数据缺口");
    expect(content(c, saved.refs).body).not.toContain(gap.detail);
  });
  it("preserves original gap origin through a second digest", async () => {
    const gap = {
      code: "missing" as const,
      field: "revenue",
      detail: "Revenue unavailable",
    };
    const c = setup({
      analysisGaps: [gap],
      additionalTasks: [
        {
          id: "digest2",
          executor: { kind: "service", service: "digest" },
          dependsOn: ["digest"],
          inputTasks: ["digest"],
          outputKinds: ["digest"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    });
    const service = new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(async (context) => draft(context)),
    );
    await service.makeDigest(c.operation, "digest", "first");
    const saved = await service.makeDigest(c.operation, "digest2", "second");
    const gaps = (content(c, saved.refs).payload as DigestPayload).gaps;
    expect(gaps).toContainEqual({
      kind: "artifact",
      artifact: c.analysisRef,
      gap,
    });
    expect(
      gaps.filter((entry) => entry.gap.detail === gap.detail),
    ).toHaveLength(1);
  });
  it("retains risks behind a selected manager artifact", async () => {
    const c = decisionFixture({
      additionalTasks: [
        {
          id: "manager-digest",
          executor: { kind: "service", service: "digest" },
          dependsOn: ["manager"],
          inputTasks: ["manager"],
          outputKinds: ["digest"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    });
    fixtures.push(c);
    const generate = vi.fn(async (context: DigestModelInput) => draft(context));
    const saved = await new DigestService(
      c.runs,
      c.artifacts,
      oneDigest(generate),
    ).makeDigest(c.operation, "manager-digest", "make");
    expect(
      generate.mock.calls[0]![0].risks.map((risk) => risk.issueId),
    ).toEqual(["liquidity"]);
    expect(
      (content(c, saved.refs).payload as DigestPayload).risks.map(
        (risk) => risk.issueId,
      ),
    ).toEqual(["liquidity"]);
  });
});

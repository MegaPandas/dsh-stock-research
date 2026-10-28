import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionResult,
  ReportPayload,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import type { MarketData } from "../../src/contracts/data.js";
import type { EvidenceInput } from "../../src/contracts/task-data.js";
import { parseArtifactInput } from "../../src/services/artifact-schema.js";
import { DecisionService } from "../../src/services/decisions.js";
import { NumberService } from "../../src/services/numbers.js";
import { RunService } from "../../src/services/runs.js";
import { assembleAnalysis } from "../../src/services/analysis-report.js";
import { analysisReport } from "../fixtures/analysis-report.js";
import {
  decisionFixture,
  type DecisionFixtureOptions,
} from "../fixtures/decision.js";

const fixtures: ReturnType<typeof decisionFixture>[] = [];
type Draft = Extract<ResearchArtifactInput, { kind: "decision_draft" }>;
const setup = (options: DecisionFixtureOptions = {}) => {
  const fixture = decisionFixture(options);
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function output(
  c: ReturnType<typeof setup>,
  refs: ReturnType<DecisionService["decide"]>["refs"],
) {
  return {
    decision: c.runs.readArtifact(refs[0]!).content.payload as DecisionResult,
    report: c.runs.readArtifact(refs[1]!).content.payload as ReportPayload,
  };
}

describe("decision finalization", () => {
  it("publishes the fixed six-month price policy with the calculated rating", () => {
    const c = setup({
      draft: (draft) => {
        draft.payload.ratingPolicy = "absolute-price-6m/1";
        draft.payload.horizonEndDate = "2024-07-03";
      },
    });
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "fixed-price-policy",
    );
    expect(output(c, result.refs).decision).toMatchObject({
      rating: "buy",
      horizonEndDate: "2024-07-03",
      ratingPolicy: "absolute-price-6m/1",
    });
    expect(output(c, result.refs).decision.computedReturn).toBeCloseTo(0.2);
    const report = c.runs.readArtifact(result.refs[1]!).content.body;
    expect(report).toContain("评级口径：六个月绝对价格变动");
    expect(report).toContain("预期价格变动（不含股息）");
  });

  it.each(["rating", "horizon"] as const)(
    "rejects a %s that contradicts the declared fixed price policy",
    (field) => {
      const c = setup({ deferDraft: true });
      c.draft.payload.ratingPolicy = "absolute-price-6m/1";
      c.draft.payload.horizonEndDate =
        field === "horizon" ? "2025-01-03" : "2024-07-03";
      c.draft.payload.rating = field === "rating" ? "neutral" : "buy";
      expect(() =>
        c.artifacts.submitArtifact(
          c.managerOp,
          [c.draft],
          "inconsistent-policy",
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    },
  );

  it("renders the latest public capture from a fixed report's task evidence independently of data cutoff", () => {
    const c = setup({
      additionalTasks: [
        {
          id: "public",
          executor: { kind: "role", role: "analyst", specialty: "public" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    });
    const claim = {
      ...c.runs.claim(c.operation, "public", "public"),
      identity: "worker",
      sessionId: null,
    };
    for (const [index, time] of [
      "2024-01-04T01:00:00.000Z",
      "2024-01-04T03:00:00.000Z",
    ].entries()) {
      c.runs.recordEvidence(
        claim,
        {
          dataset: "research",
          provider: "fixture",
          parameters: { query: `event-${index}` },
        },
        {
          envelope: {
            ...c.frame.envelope,
            dataset: "research",
            asOf: time,
            retrievedAt: time,
            historicalKnowledge: "unverified",
            gaps: [],
            data: {
              query: `event-${index}`,
              items: [],
              truncated: false,
              view: "current_search",
            },
          },
          candidates: [],
        },
        `search-${index}`,
      );
    }
    c.artifacts.submitArtifact(
      claim,
      [assembleAnalysis(analysisReport(), "Public events", [])],
      "save-public",
    );
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "decide",
    );
    const report = c.runs.readArtifact(result.refs[1]!).content.body;
    expect(report).toContain(`固定数据截止：${c.scope.cutoff}`);
    expect(report).toContain("公开检索截至：2024-01-04T03:00:00.000Z");
    expect(output(c, result.refs).decision.cutoff).toBe(c.scope.cutoff);
  });

  it("validates a revised manager draft against a completed attempt without publishing", () => {
    const c = setup();
    new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "completed",
    );
    const before = c.store.read(c.operation.runId);
    const checked = c.artifacts.validateArtifact(
      c.managerOp,
      [c.draft],
      "preview",
    );
    expect(checked.contents).toEqual([c.draft]);
    expect(checked.decisionValidation?.computedReturn).toBeCloseTo(0.2, 14);
    expect(c.store.read(c.operation.runId)).toEqual(before);
    const invalid = structuredClone(c.draft);
    invalid.body += "{{number:missing}}";
    expect(() =>
      c.artifacts.validateArtifact(c.managerOp, [invalid], "invalid-preview"),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: "Body placeholder refers to missing claim missing.",
      }),
    );
    expect(c.store.read(c.operation.runId)).toEqual(before);
  });

  it("publishes limited research with no rating or base price and preserves its gaps", () => {
    const c = setup({
      observedIndex: 0,
      frame: (frame) => {
        frame.envelope.data.bars[1]!.close = null;
        frame.envelope.gaps.push({
          code: "missing",
          field: "/data/bars/1/close",
          detail: "Latest close unavailable",
        });
      },
      draft: (draft) => {
        draft.payload.rating = null;
        draft.payload.basePrice = null;
        draft.payload.thesis = [];
        draft.payload.limitations.push(
          "Insufficient information for a rating or base price",
        );
      },
    });
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "limited",
    );
    const values = output(c, result.refs);
    expect(values.decision).toMatchObject({
      rating: null,
      basePrice: null,
      computedReturn: null,
      thesis: [],
    });
    expect(values.decision.targetPrice).toEqual(c.draft.payload.targetPrice);
    expect(values.report.gaps).toContainEqual(
      expect.objectContaining({
        gap: expect.objectContaining({ detail: "Latest close unavailable" }),
      }),
    );
    expect(values.decision.validation.warnings).toContainEqual(
      expect.stringContaining("latest adopted observation is missing"),
    );
    expect(c.runs.readArtifact(result.refs[1]!).content.body).toContain(
      "评级：未评级",
    );
    expect(c.runs.readArtifact(result.refs[1]!).content.body).toContain(
      "基准价格：未设定",
    );
  });

  it("requires an old draft without submission validation to be resubmitted", () => {
    const c = setup({ unvalidatedDraft: true });
    expect(() =>
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "old"),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARTIFACT",
        message: expect.stringContaining("resubmit"),
      }),
    );
    expect(c.runs.view(c.operation).status).toBe("active");
    expect(
      c.runs.view(c.operation).tasks.find((task) => task.taskId === "final")!
        .outputRefs,
    ).toEqual([]);
  });

  it.each([
    ["strong_buy", "强烈买入"],
    ["buy", "买入"],
    ["hold", "持有"],
    ["sell", "卖出"],
    ["strong_sell", "强烈卖出"],
  ] as const)(
    "preserves the manager's %s and publishes the final pair",
    (rating, label) => {
      const c = setup({ rating });
      expect(c.runs.readArtifact(c.draftRef).decisionValidation?.version).toBe(
        1,
      );
      const checked = vi.spyOn(NumberService.prototype, "checkNumbers");
      const before = c.store.read(c.operation.runId);
      const result = new DecisionService(c.runs, c.now).decide(
        c.operation,
        "final",
        "decide",
      );
      const values = output(c, result.refs);
      expect(result.refs).toHaveLength(2);
      expect(values.decision.rating).toBe(rating);
      expect(values.decision.computedReturn).toBeCloseTo(0.2, 14);
      for (const [key, value] of Object.entries(c.draft.payload))
        expect(values.decision[key as keyof DecisionResult]).toEqual(value);
      expect(values.decision.draftRef).toEqual(c.draftRef);
      expect(values.decision.validation.checkedRefs).toEqual(
        expect.arrayContaining([
          c.analysisRef,
          c.riskRef,
          c.digestRef,
          c.draftRef,
        ]),
      );
      expect(values.report.decision).toEqual(values.decision);
      expect(c.runs.view(c.operation).status).toBe("completed");
      expect(checked).not.toHaveBeenCalled();
      const after = c.store.read(c.operation.runId);
      expect(after.revision).toBe(before.revision + 2); // Claim and one paired publication.
      for (const ref of result.refs)
        expect(() =>
          parseArtifactInput(c.runs.readArtifact(ref).content),
        ).not.toThrow();
      const directory = join(
        c.directory,
        "runs",
        c.scope.date,
        `US_NVDA-quick-${c.operation.runId}`,
      );
      expect(
        JSON.parse(fs.readFileSync(join(directory, "decision.json"), "utf8")),
      ).toEqual(values.decision);
      const markdown = fs.readFileSync(join(directory, "report.md"), "utf8");
      expect(markdown).toContain(`评级：${label}`);
      expect(markdown).toContain("基于估计");
      expect(markdown).toContain("Synthetic scenario");
    },
  );

  it("keeps an absent target and return null instead of reading one from prose", () => {
    const c = setup({
      draft: (draft) => {
        draft.payload.targetPrice = null;
        draft.body =
          "The body mentions target 999; it is not a structured target.";
      },
    });
    const values = output(
      c,
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide")
        .refs,
    );
    expect(values.decision.targetPrice).toBeNull();
    expect(values.decision.computedReturn).toBeNull();
    const report = c.runs
      .view(c.operation)
      .tasks.find((task) => task.taskId === "final")!.outputRefs[1]!;
    expect(c.runs.readArtifact(report).content.body).not.toContain(
      "预期收益：",
    );
  });

  it("accepts a zero target and preserves an explicitly unresolved risk as a warning", () => {
    const c = setup({
      draft: (draft) => {
        draft.claims[0]!.value = 0;
        draft.payload.riskResponses[0]!.disposition = "unresolved";
      },
    });
    const values = output(
      c,
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide")
        .refs,
    );
    expect(values.decision.computedReturn).toBe(-1);
    expect(values.decision.validation.warnings).toContainEqual(
      expect.stringContaining("liquidity remains unresolved"),
    );
    expect(values.decision.rating).toBe("buy");
  });

  it.each([
    {
      name: "horizon",
      options: {
        draft: (draft: Draft) => {
          draft.payload.horizonEndDate = "2024-01-03";
        },
      },
    },
    {
      name: "target sign",
      options: {
        draft: (draft: Draft) => {
          draft.claims[0]!.value = -1;
        },
      },
    },
    {
      name: "currency",
      options: {
        draft: (draft: Draft) => {
          draft.claims[0]!.unit = "EUR/share";
        },
      },
    },
    {
      name: "risk response",
      options: {
        draft: (draft: Draft) => {
          draft.payload.riskResponses = [];
        },
      },
    },
    {
      name: "unknown risk response",
      options: {
        draft: (draft: Draft) => {
          draft.payload.riskResponses.push({
            issueId: "risk.nonexistent.1",
            disposition: "accepted",
            reason: "接受此风险。",
          });
        },
      },
    },
    {
      name: "base zero",
      options: {
        frame: (frame: EvidenceInput<MarketData>) => {
          Object.assign(frame.envelope.data.bars[1]!, {
            open: 0,
            close: 0,
            high: 1,
            low: 0,
          });
        },
      },
    },
  ])(
    "rejects correctable $name before publishing the manager draft",
    ({ options }) => {
      const c = setup({ ...options, deferDraft: true });
      const before = c.store.read(c.operation.runId).artifacts.length;
      expect(() =>
        c.artifacts.submitArtifact(c.managerOp, [c.draft], "invalid"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
      const view = c.runs.view(c.operation);
      expect(view.status).toBe("active");
      expect(view.tasks.find((task) => task.taskId === "manager")!.status).toBe(
        "running",
      );
      expect(
        view.tasks.find((task) => task.taskId === "manager")!.outputRefs,
      ).toEqual([]);
      expect(view.blockReasons).toEqual([]);
      expect(c.store.read(c.operation.runId).artifacts).toHaveLength(before);
      expect(c.clock.calls).toBe(0);
    },
  );

  it("retains optional unrelated source gaps with provenance in the report", () => {
    const c = setup({
      frame: (frame) => {
        frame.envelope.data.bars[1]!.volume = null;
        frame.envelope.gaps.push({
          code: "missing",
          field: "/data/bars/1/volume",
          detail: "Optional volume missing",
        });
      },
    });
    const values = output(
      c,
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide")
        .refs,
    );
    expect(values.report.gaps).toEqual([
      expect.objectContaining({
        kind: "source",
        source: {
          runId: c.source.runId,
          evidenceId: c.source.evidenceId,
          selector: "",
        },
        gap: {
          code: "missing",
          field: "/data/bars/1/volume",
          detail: "Optional volume missing",
        },
      }),
    ]);
    expect(values.decision.validation.warnings).toContainEqual(
      expect.stringContaining("Optional volume missing"),
    );
    expect(values.report.limitations).toEqual(c.draft.payload.limitations);
  });

  it("publishes a cited numeric premise's source gap as a warning", () => {
    const c = setup({
      required: false,
      frame: (frame) => {
        frame.envelope.gaps.push({
          code: "stale",
          field: "/data/bars/1/close",
          detail: "Cited field is stale",
        });
      },
    });
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "decide",
    );
    expect(output(c, result.refs).decision.validation.warnings).toContainEqual(
      expect.stringContaining("Cited field is stale"),
    );
  });
  it.each([false, true])(
    "checks gaps of an adopted whole-artifact premise (gap=%s)",
    (missing) => {
      const c = setup({
        frame: (frame) => {
          if (missing) {
            frame.envelope.data.bars[1]!.volume = null;
            frame.envelope.gaps.push({
              code: "missing",
              field: "/data/bars/1/volume",
              detail: "Whole artifact has a volume gap",
            });
          }
        },
        draft: (draft) => {
          if (draft.payload.basePrice?.kind === "artifact")
            draft.payload.thesis[0]!.evidence = [
              draft.payload.basePrice.artifact,
            ];
        },
      });
      const finalize = () =>
        new DecisionService(c.runs, c.now).decide(
          c.operation,
          "final",
          "decide",
        );
      const result = finalize();
      expect(result.refs).toHaveLength(2);
      if (missing)
        expect(
          output(c, result.refs).decision.validation.warnings,
        ).toContainEqual(expect.stringContaining("volume gap"));
    },
  );

  it("stores each warning once while retaining the adopted evidence and risk responses", () => {
    const gap = {
      code: "missing" as const,
      field: "/data/bars/1/volume",
      detail: "Whole artifact has a volume gap",
    };
    const c = setup({
      frame: (frame) => {
        frame.envelope.data.bars[1]!.volume = null;
        frame.envelope.gaps.push(gap);
      },
      draft: (draft) => {
        const base = draft.payload.basePrice!;
        if (base.kind !== "artifact") throw new Error("Expected fixture base");
        draft.payload.thesis = ["First premise", "Second premise"].map(
          (text) => ({ text, evidence: [base.artifact], numbers: [] }),
        );
        draft.payload.riskResponses[0]!.disposition = "unresolved";
      },
    });
    const saved = c.runs.readArtifact(c.draftRef);
    expect(saved.decisionValidation!.warnings).toEqual([
      "A decision evidence premise has a gap: /data/bars/1/volume: Whole artifact has a volume gap",
      "Risk liquidity remains unresolved: Included in the research view",
    ]);
    expect(saved.content.payload).toEqual(c.draft.payload);
    const values = output(
      c,
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide")
        .refs,
    );
    expect(values.report.gaps).toEqual([
      {
        kind: "source",
        source: { ...c.source, selector: "" },
        gap,
      },
    ]);
    expect(values.decision.riskResponses).toEqual(
      c.draft.payload.riskResponses,
    );
  });

  it("replays published finalization after reconstruction without reading evidence or changing the timestamp", () => {
    const c = setup();
    const result = new DecisionService(c.runs, c.now).decide(
      c.operation,
      "final",
      "decide",
    );
    const original = output(c, result.refs).decision;
    const before = c.store.read(c.operation.runId);
    const directory = join(
      c.directory,
      "runs",
      c.scope.date,
      `US_NVDA-quick-${c.operation.runId}`,
    );
    fs.unlinkSync(join(directory, "evidence", `${c.source.evidenceId}.json`));
    fs.unlinkSync(join(directory, "report.md"));
    const reopened = new RunService(c.store, () => "2025-01-01T00:00:00.000Z");
    const retried = new DecisionService(reopened, () => {
      throw new Error("must not rebuild a published decision");
    }).decide(c.operation, "final", "decide");
    expect(retried).toEqual(result);
    expect(output(c, retried.refs).decision).toEqual(original);
    expect(c.store.read(c.operation.runId)).toEqual(before);
    expect(fs.readFileSync(join(directory, "report.md"), "utf8")).toContain(
      "评级：买入",
    );
  });

  it("accepts a corrected manager draft in the same running attempt", () => {
    const c = setup({
      deferDraft: true,
      draft: (draft) => {
        draft.payload.horizonEndDate = "2024-01-03";
      },
    });
    const decisions = new DecisionService(c.runs, c.now);
    expect(() =>
      c.artifacts.submitArtifact(c.managerOp, [c.draft], "draft-correction"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(
      c.runs.view(c.operation).tasks.find((task) => task.taskId === "manager")!
        .outputRefs,
    ).toEqual([]);
    c.draft.payload.horizonEndDate = "2025-01-03";
    const ref = c.artifacts.submitArtifact(
      c.managerOp,
      [c.draft],
      "draft-correction",
    ).refs[0]!;
    const result = decisions.decide(c.operation, "final", "second");
    expect(output(c, result.refs).decision.draftRef).toEqual(ref);
    expect(result.attempt).toBe(1);
    expect(c.runs.view(c.operation).status).toBe("completed");
  });

  it("does not claim a role task or start an already cancelled request", () => {
    const c = setup();
    const before = c.store.read(c.operation.runId);
    const decisions = new DecisionService(c.runs, c.now);
    expect(() =>
      decisions.decide(c.operation, "manager", "wrong"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    expect(() =>
      decisions.decide(c.operation, "final", "cancelled", controller.signal),
    ).toThrow(reason);
    expect(c.store.read(c.operation.runId)).toEqual(before);
  });

  it("records a blockage when a nondependent task still prevents final publication", () => {
    const c = setup({
      additionalTasks: [
        {
          id: "independent",
          executor: { kind: "role", role: "analyst", specialty: "fixture" },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    });
    expect(() =>
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide"),
    ).toThrowError(expect.objectContaining({ code: "DATA_INSUFFICIENT" }));
    const view = c.runs.view(c.operation);
    expect(view.status).toBe("blocked");
    expect(view.tasks.find((task) => task.taskId === "final")!.status).toBe(
      "failed",
    );
    expect(view.blockReasons[0]!.message).toContain(
      "all other tasks succeeded",
    );
    expect(
      c.store
        .read(c.operation.runId)
        .artifacts.some((entry) => entry.kind === "decision"),
    ).toBe(false);
  });

  it("preserves actual storage failures instead of publishing a default decision", () => {
    const c = setup();
    fs.unlinkSync(
      join(
        c.directory,
        "runs",
        c.scope.date,
        `US_NVDA-quick-${c.operation.runId}`,
        "evidence",
        `${c.source.evidenceId}.json`,
      ),
    );
    expect(() =>
      new DecisionService(c.runs, c.now).decide(c.operation, "final", "decide"),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_FAILED",
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    expect(c.runs.view(c.operation).status).toBe("active");
    expect(
      c.store
        .read(c.operation.runId)
        .artifacts.some((entry) => entry.kind === "decision"),
    ).toBe(false);
  });
});

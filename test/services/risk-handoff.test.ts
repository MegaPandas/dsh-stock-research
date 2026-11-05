import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  DigestPayload,
  ResearchArtifactInput,
} from "../../src/contracts/artifact-payloads.js";
import type { RunState } from "../../src/contracts/runs.js";
import { RunStore } from "../../src/runs/store.js";
import { ArtifactService } from "../../src/services/artifact-submission/index.js";
import { DigestService } from "../../src/services/digest/index.js";
import { generateHandoffDigest } from "../../src/services/digest/handoff.js";
import { NumberService } from "../../src/services/numbers/index.js";
import { createRunService } from "../../src/services/run/index.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { US_SECURITY } from "../fixtures/market.js";

it.each([1, 3])(
  "rejects %i handoffs for two risks before publishing and accepts a corrected submission",
  async (summaryCount) => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-risk-handoff-"));
    const root = new DataRoot(directory);
    const runs = createRunService(
      new RunStore<RunState>(root),
      () => "2024-01-03T00:00:00.000Z",
    );
    const artifacts = new ArtifactService(runs, new NumberService(runs));
    const digests = new DigestService(runs, artifacts, generateHandoffDigest);
    try {
      const { runId } = runs.open(
        "owner",
        {
          definition: {
            scope: {
              security: US_SECURITY,
              date: "2024-01-02",
              cutoff: "2024-01-02T21:00:00.000Z",
            },
            mode: "quick",
            tasks: [
              {
                id: "risk",
                executor: {
                  kind: "role",
                  role: "discussion",
                  specialty: "risk",
                },
                dependsOn: [],
                inputTasks: [],
                outputKinds: ["risk"],
                dataRequirements: [],
                instructionVersion: 1,
              },
              {
                id: "digest",
                executor: { kind: "service", service: "digest" },
                dependsOn: ["risk"],
                inputTasks: ["risk"],
                outputKinds: ["digest"],
                dataRequirements: [],
                instructionVersion: 1,
              },
            ],
          },
          versions: {
            plugin: "1",
            mode: "1",
            prompts: {},
            skills: {},
            adapters: {},
            normalization: {},
          },
          inputs: [],
        },
        "open",
      );
      const operation = { runId, identity: "owner" };
      const task = {
        ...runs.claim(operation, "risk", "claim-risk"),
        identity: "owner",
        sessionId: null,
      };
      const content: Extract<ResearchArtifactInput, { kind: "risk" }> = {
        kind: "risk",
        title: "Risk report",
        body: "Liquidity and pricing risks require separate responses.",
        inputRefs: [],
        claims: [],
        payload: {
          issues: ["liquidity", "pricing"].map((issueId) => ({
            issueId,
            description: issueId,
            impact: "Lower cash generation",
            trigger: "Demand weakens",
            constraint: "Limit exposure",
            recommendation: "Review quarterly",
            evidence: [],
            numbers: [],
          })),
          stageHandoff: {
            keyPoints: ["Monitor cash generation."],
            disagreements: [],
            risks: [
              "Liquidity summary",
              "Pricing summary",
              "Extra summary",
            ].slice(0, summaryCount),
            openQuestions: [],
          },
        },
      };
      const before = runs.view(operation);
      expect(() =>
        artifacts.submitArtifact(task, [content], "submit-risk"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
      expect(runs.view(operation)).toEqual(before);
      expect(runs.numberContext(runId).artifacts).toEqual([]);

      content.payload.stageHandoff!.risks = [
        "Liquidity summary",
        "Pricing summary",
      ];
      const saved = artifacts.submitArtifact(task, [content], "submit-risk");
      expect(saved.refs).toHaveLength(1);
      expect(runs.view(operation).readyTasks).toEqual(["digest"]);
      const digest = await digests.makeDigest(
        operation,
        "digest",
        "make-digest",
      );
      const payload = runs.readArtifact(digest.refs[0]!).content
        .payload as DigestPayload;
      expect(payload.report!.content.riskSummaries).toEqual([
        { issueId: "liquidity", text: "Liquidity summary" },
        { issueId: "pricing", text: "Pricing summary" },
      ]);
      expect(runs.view(operation).tasks.map(({ status }) => status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
    } finally {
      await digests.close();
      root.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

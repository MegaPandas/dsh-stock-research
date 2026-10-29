import type { RoleDispatchContext } from "../contracts/runs.js";
import { ResearchError } from "../contracts/errors.js";
import type { RoleProvision } from "../host/dispatch.js";
import {
  businessDraftTools,
  parseBusinessJson,
} from "../host/business-draft.js";
import { renderArtifactBody } from "../report/render.js";
import { ArtifactInputs } from "../services/artifact-inputs.js";
import { digestRisks } from "../services/digest-inputs.js";
import {
  assembleBusinessReport,
  type BusinessRoleKind,
} from "../services/business-reports.js";
import { researchTool } from "../tools/errors.js";
import {
  object,
  objectSchema,
  resultOutput,
  stringSchema,
  text,
} from "../tools/parameters.js";
import { createReportReader } from "./report-reader.js";
import type { RoleServices } from "./prepare-role.js";
import type { readApplicationInput } from "./research-input.js";

export function prepareBusinessRole(
  services: RoleServices,
  context: RoleDispatchContext,
  profile: ReturnType<typeof readApplicationInput>,
  instruction: string,
): RoleProvision {
  const { claim, definition, scope } = context;
  const kind = definition.outputKinds[0];
  if (
    definition.outputKinds.length !== 1 ||
    !["debate", "risk", "plan", "decision_draft"].includes(kind!)
  )
    throw new ResearchError(
      "INVALID_INPUT",
      "A business role requires one supported report kind.",
    );
  const reportKind = kind as BusinessRoleKind;
  const inputs = new ArtifactInputs(services.runs);
  const reports = inputs.closure(claim.inputRefs);
  const reader = createReportReader(reports, claim.inputRefs);
  const risks = digestRisks(reports).map(({ issueId }) => ({ issueId }));
  const priceReport = reports.find((report) =>
    report.content.claims.some((claim) => claim.id === "market.close"),
  );
  const priceClaim = priceReport?.content.claims.find(
    (claim) => claim.id === "market.close",
  );
  const referencePrice =
    priceReport && priceClaim
      ? { artifact: priceReport.ref, claim: priceClaim }
      : null;
  const file = services.createDraftFile(claim);
  const submit = services
    .createTools(profile.policy)
    .find((tool) => tool.name === "stock_save_report")!;
  const labels = {
    debate: definition.executor.specialty === "bull" ? "多方讨论" : "空方讨论",
    risk: "风控分析",
    plan: "研究计划",
    decision_draft: "经理决策",
  };
  return {
    systemPrompt: profile.prompts[definition.executor.role],
    tools: [
      reader.tool,
      ...businessDraftTools(file),
      researchTool({
        ...submit,
        description:
          "Read the fixed business JSON draft, validate it and submit this stage's result.",
        parameters: objectSchema({ requestId: stringSchema }),
        output: resultOutput(
          objectSchema({ status: { type: "string", const: "submitted" } }),
        ),
        async execute(value, exec) {
          const item = object(value, ["requestId"]);
          const content = assembleBusinessReport(
            parseBusinessJson(await file.read(exec.signal)),
            {
              kind: reportKind,
              taskId: claim.taskId,
              specialty: definition.executor.specialty,
              title: `${scope.security.symbol} ${labels[reportKind]}`,
              inputRefs: reports.map((report) => report.ref),
              currency: scope.security.currency,
              referencePrice,
            },
          );
          await submit.execute(
            {
              requestId: text(item.requestId, "requestId"),
              contents: [content],
            },
            exec,
          );
          exec.concludeTurn();
          return { status: "submitted" };
        },
      }),
    ],
    prompt: [
      {
        type: "text",
        text: JSON.stringify({
          scope,
          task: {
            id: claim.taskId,
            specialty: definition.executor.specialty,
            instruction,
            outputKinds: definition.outputKinds,
          },
          outputContract: profile.guides[reportKind],
          inputs: claim.inputRefs.map((ref) => {
            const content = services.runs.readArtifact(ref).content;
            return { title: content.title, body: renderArtifactBody(content) };
          }),
          reportCatalog: reader.catalog,
          risks,
          referencePrice:
            referencePrice === null
              ? null
              : {
                  value: referencePrice.claim.value,
                  unit: referencePrice.claim.unit,
                },
        }),
      },
    ],
  };
}

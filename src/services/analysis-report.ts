import type {
  AnalysisNotePayload,
  AnalysisAgentPayload,
  AnalysisReport,
  DebateNotePayload,
  DebateAgentPayload,
  ResearchArtifactInput,
} from "../contracts/artifact-payloads.js";
import type { ArtifactInput } from "../contracts/artifacts.js";
import { list, object, text } from "./artifact-shape.js";

export type AnalysisNoteArtifact = Omit<ArtifactInput, "kind" | "payload"> & {
  kind: "analysis";
  payload: AnalysisNotePayload | AnalysisAgentPayload;
};
export type DebateNoteArtifact = Omit<ArtifactInput, "kind" | "payload"> & {
  kind: "debate";
  payload: DebateNotePayload | DebateAgentPayload;
};

export function isStageReport(
  content: ResearchArtifactInput,
): content is AnalysisNoteArtifact | DebateNoteArtifact {
  return (
    (content.kind === "analysis" || content.kind === "debate") &&
    "schemaVersion" in content.payload
  );
}

export function parseAnalysisReport(
  value: unknown,
  path = "analysis",
): AnalysisReport {
  const item = object(value, path, [
    "assessment",
    "current_state",
    "analysis_model",
    "outlook",
    "risks",
    "handoff",
  ]);
  const texts = (value: unknown, location: string) =>
    list(value, location, text);
  text(item.assessment, `${path}/assessment`);
  list(item.current_state, `${path}/current_state`, text, 1);
  const model = object(item.analysis_model, `${path}/analysis_model`, [
    "drivers",
    "mechanism",
    "assumptions",
    "alternative_explanations",
  ]);
  list(model.drivers, `${path}/analysis_model/drivers`, text, 1);
  text(model.mechanism, `${path}/analysis_model/mechanism`);
  texts(model.assumptions, `${path}/analysis_model/assumptions`);
  texts(
    model.alternative_explanations,
    `${path}/analysis_model/alternative_explanations`,
  );
  const outlook = object(item.outlook, `${path}/outlook`, [
    "horizon",
    "base_case",
    "alternative_case",
    "watch_points",
  ]);
  text(outlook.horizon, `${path}/outlook/horizon`);
  for (const name of ["base_case", "alternative_case"] as const) {
    const scenario = object(outlook[name], `${path}/outlook/${name}`, [
      "conditions",
      "expectation",
    ]);
    texts(scenario.conditions, `${path}/outlook/${name}/conditions`);
    text(scenario.expectation, `${path}/outlook/${name}/expectation`);
  }
  texts(outlook.watch_points, `${path}/outlook/watch_points`);
  list(item.risks, `${path}/risks`, (value, location) => {
    const risk = object(value, location, ["factor", "impact", "invalidation"]);
    for (const key of ["factor", "impact", "invalidation"])
      text(risk[key], `${location}/${key}`);
  });
  const handoff = object(item.handoff, `${path}/handoff`, [
    "implications",
    "open_questions",
    "limitations",
  ]);
  for (const key of ["implications", "open_questions", "limitations"])
    texts(handoff[key], `${path}/handoff/${key}`);
  return structuredClone(value) as AnalysisReport;
}

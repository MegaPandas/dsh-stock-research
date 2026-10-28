import type { ResearchArtifactInput } from "../contracts/artifact-payloads.js";
import type { DigestDraft, DigestModelInput } from "../contracts/digests.js";
import { ResearchError } from "../contracts/errors.js";
import { numberText } from "../report/render.js";
import { renderAgentReport } from "../report/agent-report.js";
import { artifactRef, list, object, text } from "./artifact-schema.js";
import { artifactKey } from "./run-dependencies.js";
import { parseAgentReport } from "./agent-reports.js";

function invalid(detail: string): never {
  throw new ResearchError("INVALID_ARTIFACT", detail);
}
function parseDraft(value: unknown): DigestDraft {
  const item = object(value, "digest", [
    "title",
    "body",
    "inputRefs",
    "facts",
    "disagreements",
    "riskSummaries",
    ...(typeof value === "object" && value !== null && "report" in value
      ? ["report"]
      : []),
  ]);
  if (item.report !== undefined) parseAgentReport("digest", item.report);
  text(item.title, "digest/title");
  text(item.body, "digest/body");
  list(item.inputRefs, "digest/inputRefs", artifactRef);
  list(item.disagreements, "digest/disagreements", text);
  list(item.facts, "digest/facts", (value, path) => {
    const fact = object(value, path, ["text", "inputRefs", "numbers"]);
    text(fact.text, `${path}/text`);
    list(fact.inputRefs, `${path}/inputRefs`, artifactRef);
    list(fact.numbers, `${path}/numbers`, text);
  });
  list(item.riskSummaries, "digest/riskSummaries", (value, path) => {
    const risk = object(value, path, ["issueId", "text"]);
    text(risk.issueId, `${path}/issueId`);
    text(risk.text, `${path}/text`);
  });
  return structuredClone(value) as DigestDraft;
}
export function assembleDigest(
  value: unknown,
  context: DigestModelInput,
): Extract<ResearchArtifactInput, { kind: "digest" }> {
  const draft = parseDraft(value);
  const roots = new Set(
    context.artifacts.map((version) => artifactKey(version.ref)),
  );
  const named = new Set(draft.inputRefs.map(artifactKey));
  if (roots.size !== named.size || [...roots].some((key) => !named.has(key)))
    invalid(
      `Digest model inputRefs must match the fixed direct upstream versions. Expected ${JSON.stringify(context.artifacts.map((version) => version.ref))}; received ${JSON.stringify(draft.inputRefs)}.`,
    );
  if (roots.size > 0 && draft.facts.length === 0 && draft.report === undefined)
    invalid("A nonempty digest input requires at least one supported fact.");
  const knownRefs = new Set(context.references.map(artifactKey));
  const numbers = new Map(
    context.numbers.map((candidate) => [candidate.candidateId, candidate]),
  );
  const number = (id: string) => {
    const candidate = numbers.get(id);
    if (candidate === undefined)
      invalid(`Unknown digest numeric candidate ${id}.`);
    return candidate;
  };
  const compile = (value: string): string => {
    const pattern = /\{\{number:([^{}]+)\}\}/g;
    if (/\{\{number\b/.test(value.replace(pattern, "")))
      invalid("Malformed digest number placeholder.");
    return value.replace(pattern, (_token, id: string) => {
      const candidate = number(id);
      return (
        numberText(candidate.claim) +
        (candidate.estimated && candidate.claim.kind !== "estimated"
          ? "（含估计输入）"
          : "")
      );
    });
  };
  const facts = draft.facts.map((fact) => {
    for (const ref of fact.inputRefs)
      if (!knownRefs.has(artifactKey(ref)))
        invalid("Digest fact refers to a version outside its fixed context.");
    return {
      text: compile(fact.text),
      evidence: fact.inputRefs,
      numbers: fact.numbers.map((id) => number(id).input),
    };
  });
  const required = new Set(context.risks.map((risk) => risk.issueId));
  const summaries = new Set(draft.riskSummaries.map((risk) => risk.issueId));
  if (
    summaries.size !== draft.riskSummaries.length ||
    summaries.size !== required.size ||
    [...required].some((id) => !summaries.has(id))
  )
    invalid(
      `Digest model must summarize every inherited risk issueId exactly once. Expected ${JSON.stringify([...required])}; received ${JSON.stringify(draft.riskSummaries.map((risk) => risk.issueId))}.`,
    );
  const body =
    draft.report === undefined
      ? [
          compile(draft.body),
          "",
          "## 事实",
          ...facts.map((fact) => `- ${fact.text}`),
          "",
          "## 未决分歧",
          ...draft.disagreements.map((item) => `- ${compile(item)}`),
          "",
          "## 风险摘要",
          ...draft.riskSummaries.map(
            (risk) => `- ${risk.issueId}：${compile(risk.text)}`,
          ),
        ].join("\n")
      : renderAgentReport("digest", draft.report);
  return {
    kind: "digest",
    title: draft.title,
    body: body.replace(/\{\{number\b/g, "&#123;&#123;number"),
    inputRefs: context.references,
    claims: [],
    payload: {
      ...(draft.report === undefined ? {} : { report: draft.report }),
      facts,
      disagreements: draft.disagreements.map(compile),
      risks: context.risks,
      gaps: context.gaps,
      upstreamRefs: context.references,
      numbers: context.numbers.map((candidate) => candidate.input),
    },
  };
}

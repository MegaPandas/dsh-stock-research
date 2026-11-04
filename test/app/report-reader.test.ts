import { expect, it } from "vitest";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {
  ArtifactInput,
  ArtifactVersion,
} from "../../src/contracts/artifacts.js";
import { createReportReader } from "../../src/app/report-reader.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";

function version(content: ArtifactInput): ArtifactVersion {
  return {
    ref: { runId: "run", artifactId: "analysis", revision: 1 },
    taskId: "analysis",
    attempt: 1,
    producerSessionId: null,
    createdAt: "2024-01-03T08:00:00.000Z",
    schemaVersion: 1,
    content,
  };
}
function setup() {
  const report = agentAnalysisReport();
  const saved = version({
    kind: "analysis",
    title: "经营分析",
    body: "保存的全文",
    inputRefs: [],
    claims: [],
    payload: {
      schemaVersion: 3,
      report,
      publicSearchAsOf: "2024-01-03T08:00:00.000Z",
    },
  });
  const reader = createReportReader([saved], []);
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  return { reader, exec, report, saved };
}

it("lists section names and reads selected fixed sections without changing the report", async () => {
  const { reader, exec, report, saved } = setup();
  const sections = [
    "summary",
    "currentState",
    "analysisModel",
    "outlook",
    "risks",
    "handoff",
  ];
  expect(reader.catalog).toEqual([
    {
      id: "report-1",
      role: "analysis",
      kind: "analysis",
      title: "经营分析",
      sections,
    },
  ]);
  expect(
    await reader.tool.execute({ id: "report-1", sections: [] }, exec),
  ).toEqual({
    title: "经营分析",
    availableSections: sections,
  });
  const selected = (await reader.tool.execute(
    {
      id: "report-1",
      sections: ["summary", "outlook"],
    },
    exec,
  )) as { content: typeof report.content };
  expect(selected).toEqual({
    title: "经营分析",
    summary: report.summary,
    content: { outlook: report.content.outlook },
    availableSections: sections,
    publicSearchAsOf: "2024-01-03T08:00:00.000Z",
  });
  selected.content.outlook.watchPoints.push("外部修改");
  expect(saved.content.payload).toMatchObject({
    report: agentAnalysisReport(),
  });
  expect(
    await reader.tool.execute({ id: "report-1", sections: null }, exec),
  ).toEqual({
    title: "经营分析",
    ...report,
    availableSections: sections,
    publicSearchAsOf: "2024-01-03T08:00:00.000Z",
  });
});

it("keeps saved prose available as an explicit body section", async () => {
  const saved = version({
    kind: "analysis",
    title: "旧报告",
    body: "保存的正文",
    inputRefs: [],
    claims: [],
    payload: {},
  });
  const reader = createReportReader([saved], []);
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  expect(reader.catalog[0]!.sections).toEqual(["body"]);
  expect(
    await reader.tool.execute({ id: "report-1", sections: ["body"] }, exec),
  ).toEqual({
    title: "旧报告",
    body: "保存的正文",
    availableSections: ["body"],
  });
});

it("rejects invalid selectors and honours cancellation before reading", async () => {
  const { reader, exec } = setup();
  for (const args of [
    { id: "report-1", sections: ["unknown"] },
    { id: "report-1", sections: ["summary", "summary"] },
    { id: "report-1", sections: "summary" },
    { id: "report-1" },
    { id: "absent", sections: [] },
  ])
    await expect(reader.tool.execute(args, exec)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  const reason = new Error("stop");
  await expect(
    reader.tool.execute({}, {
      signal: AbortSignal.abort(reason),
    } as ToolRunContext),
  ).rejects.toBe(reason);
});

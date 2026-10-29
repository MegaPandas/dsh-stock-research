import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { afterEach, expect, it } from "vitest";
import catalogue from "../../src/valuation/methods.json" with { type: "json" };
import type {
  OpenRunInput,
  RunState,
  TaskOperation,
} from "../../src/contracts/runs.js";
import type {
  ValuationCalculation,
  ValuationInputs,
  ValuationRequest,
} from "../../src/contracts/valuation.js";
import { DETERMINISTIC_VALUATION_PROTOCOL } from "../../src/contracts/valuation.js";
import { SessionBindings } from "../../src/host/bindings.js";
import { RunStore } from "../../src/runs/store.js";
import { RunService } from "../../src/services/runs.js";
import { ArtifactService } from "../../src/services/artifacts.js";
import { NumberService } from "../../src/services/numbers.js";
import { assembleAgentArtifact } from "../../src/services/business-reports.js";
import type { AgentReport } from "../../src/contracts/agent-reports.js";
import {
  calculateValuation,
  materializeTargetPrice,
  materializeValuation,
  readValuationCalculation,
  validateCalculatedReport,
  valuationCalculationCatalog,
} from "../../src/services/valuation-calculations.js";
import { DataRoot } from "../../src/storage/data-root.js";
import { createValuationTools } from "../../src/tools/valuation.js";
import { agentAnalysisReport } from "../fixtures/analysis-report.js";
import { US_SECURITY } from "../fixtures/market.js";
import { renderValuation } from "../../src/report/valuation.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function request(): Extract<
  ValuationRequest,
  { methodId: "comparable_multiples" }
> & {
  inputs: Extract<
    ValuationInputs["comparable_multiples"],
    { multipleType: "ps" }
  >;
} {
  return {
    methodId: "comparable_multiples",
    purpose: "valuation",
    amountUnit: "hundred_million",
    shares: { value: 10, unit: "hundred_million" },
    inputs: {
      multipleType: "ps",
      revenue: 450,
      multiples: [0.3, 0.5],
    },
    assumptions: ["Synthetic revenue and multiples; unchanged shares."],
    provenance: [
      { path: "/inputs", kind: "assumed", basis: "Synthetic scenario." },
      { path: "/shares", kind: "observed", basis: "Synthetic share register." },
    ],
    sensitivities: [
      {
        label: "Higher revenue",
        path: "/inputs/revenue",
        value: 600,
        basis: "Synthetic upside scenario.",
      },
    ],
  };
}
function setup(tasks?: OpenRunInput["definition"]["tasks"]) {
  const path = fs.mkdtempSync(join(tmpdir(), "valuation-calculation-"));
  let root = new DataRoot(path);
  const now = () => "2024-07-01T12:00:00.000Z";
  let runs = new RunService(new RunStore<RunState>(root), now);
  const input: OpenRunInput = {
    definition: {
      scope: {
        security: US_SECURITY,
        date: "2024-06-30",
        cutoff: "2024-06-30T20:00:00.000Z",
      },
      mode: "quick",
      tasks: [
        {
          id: "analysis.fundamentals",
          executor: {
            kind: "role",
            role: "analyst",
            specialty: "fundamentals",
          },
          dependsOn: [],
          inputTasks: [],
          outputKinds: ["analysis"],
          dataRequirements: [],
          instructionVersion: 1,
        },
      ],
    },
    versions: {
      plugin: "1",
      mode: "quick-1",
      prompts: {
        roles: DETERMINISTIC_VALUATION_PROTOCOL,
        valuationEngine: "2",
        valuationMethods: catalogue.version,
      },
      skills: {},
      adapters: {},
      normalization: {},
    },
    inputs: [{ name: "stock-research:valuation-methods", content: catalogue }],
  };
  if (tasks !== undefined) input.definition.tasks = tasks;
  const { runId } = runs.open("coordinator", input, "open");
  const claim = runs.claim(
    { runId, identity: "coordinator" },
    input.definition.tasks[0]!.id,
    "claim",
  );
  const operation: TaskOperation = {
    runId,
    taskId: claim.taskId,
    attempt: claim.attempt,
    identity: "worker",
    sessionId: "worker",
  };
  cleanups.push(() => {
    root.close();
    fs.rmSync(path, { recursive: true, force: true });
  });
  return {
    get runs() {
      return runs;
    },
    operation,
    input,
    reopen() {
      root.close();
      root = new DataRoot(path);
      runs = new RunService(new RunStore<RunState>(root), now);
    },
  };
}

it("calculates independent amount/share scales and sensitivity, and persists immutable receipts", () => {
  const f = setup();
  const first = calculateValuation(f.runs, f.operation, request(), "ps");
  expect(first.result.equityValues).toEqual([13_500_000_000, 22_500_000_000]);
  expect(first.result.perShareValues).toEqual([13.5, 22.5]);
  expect(first.result.shares).toBe(1_000_000_000);
  expect(first.sensitivities[0]!.result.perShareValues).toEqual([18, 30]);
  expect(calculateValuation(f.runs, f.operation, request(), "ps")).toEqual(
    first,
  );
  const changed = request();
  changed.inputs.revenue = 600;
  expect(() =>
    calculateValuation(f.runs, f.operation, changed, "ps"),
  ).toThrowError(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
  f.reopen();
  expect(
    readValuationCalculation(f.runs, f.operation.runId, first.calculationId),
  ).toEqual(first);
  f.runs.commitArtifact(
    f.operation,
    [
      {
        kind: "analysis",
        title: "Synthetic analysis",
        body: "Synthetic analysis",
        inputRefs: [],
        claims: [],
        payload: {},
      },
    ],
    "complete",
  );
  expect(calculateValuation(f.runs, f.operation, request(), "ps")).toEqual(
    first,
  );
});

it("rejects foreign and invalidated references while preserving same-call receipts", () => {
  const f = setup();
  const first = calculateValuation(f.runs, f.operation, request(), "ps");
  const foreign = f.runs.open("coordinator", f.input, "foreign");
  expect(() =>
    readValuationCalculation(f.runs, foreign.runId, first.calculationId),
  ).toThrow(/not registered/);
  f.runs.redo(
    { runId: f.operation.runId, identity: "coordinator" },
    f.operation.taskId,
    "redo",
  );
  expect(calculateValuation(f.runs, f.operation, request(), "ps")).toEqual(
    first,
  );
  expect(() =>
    readValuationCalculation(f.runs, f.operation.runId, first.calculationId),
  ).toThrow(/superseded|unsuccessful/);
  expect(() =>
    calculateValuation(f.runs, f.operation, request(), "new-call"),
  ).toThrow();
});

it("requires one target-date value for target prices", () => {
  const f = setup();
  const valuation = calculateValuation(
    f.runs,
    f.operation,
    request(),
    "valuation",
  );
  expect(() =>
    materializeTargetPrice(f.runs, f.operation.runId, valuation.calculationId),
  ).toThrow(/target price/);
  const target = request();
  target.purpose = "target_price";
  const range = calculateValuation(f.runs, f.operation, target, "target-range");
  expect(() =>
    materializeTargetPrice(f.runs, f.operation.runId, range.calculationId),
  ).toThrow(/target price/);
  target.inputs.multiples = [0.5];
  const single = calculateValuation(
    f.runs,
    f.operation,
    target,
    "target-single",
  );
  expect(
    materializeTargetPrice(f.runs, f.operation.runId, single.calculationId),
  ).toMatchObject({ calculationId: single.calculationId, value: 22.5 });
  expect(single.valueDate).toBe("2024-12-30");
});

function datedCashFlow(): Extract<ValuationRequest, { methodId: "fcff_dcf" }> {
  return {
    ...request(),
    methodId: "fcff_dcf",
    inputs: {
      forecastStartDate: "2024-01-01",
      openingWorkingCapital: 0,
      periods: [
        {
          endDate: "2024-12-31",
          revenue: 100,
          operatingMargin: 0.1,
          taxRate: 0,
          depreciation: 0,
          capex: 0,
          workingCapital: 0,
        },
      ],
      discountRate: 0,
      terminal: { kind: "finite", recovery: 0 },
      bridge: {
        excessCash: 0,
        nonOperatingAssets: 0,
        debt: 0,
        preferredEquity: 0,
        minorityInterest: 0,
        otherClaims: 0,
      },
    },
    sensitivities: [],
  };
}

it("reuses the same forecast while code derives research-date and target-date remaining cash flows", () => {
  const f = setup();
  const input = datedCashFlow();
  const research = calculateValuation(f.runs, f.operation, input, "research");
  const target = calculateValuation(
    f.runs,
    f.operation,
    { ...input, purpose: "target_price" },
    "target",
  );
  expect(research.result.perShareValues[0]).toBeCloseTo(184 / 365, 12);
  expect(target.result.perShareValues[0]).toBeCloseTo(1 / 365, 12);
  expect(target.request.inputs).toEqual(research.request.inputs);
  expect(target.valueDate).toBe("2024-12-30");
});

it("saves negative equity residuals and their diagnostics without treating them as target prices", () => {
  const f = setup();
  const input = datedCashFlow();
  input.inputs.bridge.debt = 100;
  const saved = calculateValuation(f.runs, f.operation, input, "negative");
  expect(saved.result.perShareValues[0]).toBeLessThan(0);
  expect(saved.result.diagnostics.length).toBeGreaterThan(0);
  expect(calculateValuation(f.runs, f.operation, input, "negative")).toEqual(
    saved,
  );
  const selection = {
    companyProfile: "Synthetic debt exceeds operating asset value.",
    methods: [
      {
        methodId: "fcff_dcf",
        suitability: "Synthetic solvency scenario.",
        calculationIds: [saved.calculationId],
        limitations: [],
      },
    ],
    targetPriceBasis: null,
  };
  const report = agentAnalysisReport();
  report.content.valuation = materializeValuation(
    f.runs,
    f.operation.runId,
    selection,
  );
  expect(report.content.valuation.methods[0]!.valueRange).toBeNull();
  expect(saved.result.diagnostics).toEqual([
    "Negative equity residual is not a usable target share price; analyze solvency and allocation of claims.",
  ]);
  expect(report.content.valuation.methods[0]!.limitations).toEqual([
    "股权残值为负，不能作为目标股价；应分析偿付能力和索取权分配。",
  ]);
  expect(() =>
    validateCalculatedReport(f.runs, f.operation, report),
  ).not.toThrow();
  report.content.valuation.methods[0]!.limitations = ["Unrelated limitation."];
  expect(() => validateCalculatedReport(f.runs, f.operation, report)).toThrow(
    /limitations/,
  );
  const target = calculateValuation(
    f.runs,
    f.operation,
    { ...input, purpose: "target_price" },
    "negative-target",
  );
  expect(() =>
    materializeTargetPrice(f.runs, f.operation.runId, target.calculationId),
  ).toThrow(/Negative equity residuals/);
});

it("rejects mismatched multiple denominators and equity-value debt bridges", () => {
  const f = setup();
  const input = request();
  const valid = calculateValuation(
    f.runs,
    f.operation,
    {
      ...input,
      inputs: { multipleType: "pcf", operatingCashFlow: 80, multiples: [12.5] },
      sensitivities: [],
    },
    "pcf",
  );
  expect(valid.result.perShareValues).toEqual([100]);
  expect(() =>
    calculateValuation(
      f.runs,
      f.operation,
      {
        ...input,
        inputs: {
          multipleType: "ev_revenue",
          operatingCashFlow: 80,
          multiples: [12.5],
          bridge: datedCashFlow().inputs.bridge,
        },
      },
      "mismatched",
    ),
  ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  expect(() =>
    calculateValuation(
      f.runs,
      f.operation,
      {
        ...input,
        inputs: { ...input.inputs, bridge: datedCashFlow().inputs.bridge },
      },
      "equity-bridge",
    ),
  ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("formats report values while preserving exact calculations and range endpoints", () => {
  const f = setup();
  const input = request();
  input.amountUnit = "million";
  input.shares = { value: 100, unit: "million" };
  input.inputs = {
    multipleType: "ps",
    revenue: 773.9999999999999,
    multiples: [1],
  };
  input.sensitivities[0]!.value = 619.1999999999999;
  const saved = calculateValuation(f.runs, f.operation, input, "display");
  const original = structuredClone(saved);
  const valuation = materializeValuation(f.runs, f.operation.runId, {
    companyProfile: "Synthetic company",
    methods: [
      {
        methodId: "comparable_multiples",
        suitability: "Revenue comparison",
        calculationIds: [saved.calculationId],
        limitations: [],
      },
    ],
    targetPriceBasis: null,
  });
  const text = renderValuation(valuation).join("\n");
  expect(text).toContain("倍数法经济指标=7.74 亿USD");
  expect(text).toContain("普通股每股价值1=7.74 USD/股");
  expect(text).toContain("研究日价值区间：7.74 USD/股 至 7.74 USD/股。");
  expect(text).toContain("/inputs/revenue=619.2；每股结果=6.192 USD/股");
  expect(text).toContain('"revenue":774');
  expect(text).not.toContain("999999999");
  expect(valuation.methods[0]!.valueRange!.low).toBe(
    saved.result.perShareValues[0],
  );
  expect(saved.result.equityValues[0]).toBe(773999999.9999999);
  expect(saved.request.inputs).toEqual(input.inputs);
  expect(
    readValuationCalculation(f.runs, f.operation.runId, saved.calculationId),
  ).toEqual(original);
  const report = agentAnalysisReport();
  report.content.valuation = valuation;
  expect(() =>
    validateCalculatedReport(f.runs, f.operation, report),
  ).not.toThrow();
});

it("materializes reports from calculation references and rejects forged or unreferenced results under the current protocol", () => {
  const f = setup();
  const saved = calculateValuation(f.runs, f.operation, request(), "ps");
  const valuation = materializeValuation(f.runs, f.operation.runId, {
    companyProfile: "Synthetic company",
    methods: [
      {
        methodId: "comparable_multiples",
        suitability: "Revenue comparison",
        calculationIds: [saved.calculationId],
        limitations: [],
      },
    ],
    targetPriceBasis: null,
  });
  expect(valuation.methods[0]!.valueRange).toEqual({
    low: 13.5,
    high: 22.5,
    unit: "USD/share",
  });
  expect(saved.result.steps[0]!.label).toBe("Comparable metric");
  expect(valuation.methods[0]!.calculation).toContain(
    "倍数法经济指标=450 亿USD",
  );
  expect(valuation.methods[0]!.calculation).toContain(
    "普通股每股价值1=13.5 USD/股",
  );
  const report = agentAnalysisReport();
  report.content.valuation = valuation;
  expect(() =>
    validateCalculatedReport(f.runs, f.operation, report),
  ).not.toThrow();
  valuation.methods[0]!.valueRange!.high = 99;
  expect(() => validateCalculatedReport(f.runs, f.operation, report)).toThrow(
    /valueRange/,
  );
  delete valuation.methods[0]!.calculationIds;
  expect(() => validateCalculatedReport(f.runs, f.operation, report)).toThrow(
    /calculationIds/,
  );
  valuation.methods[0]!.calculationIds = [saved.calculationId];
  f.runs.redo(
    { runId: f.operation.runId, identity: "coordinator" },
    f.operation.taskId,
    "redo",
  );
  expect(() =>
    materializeValuation(f.runs, f.operation.runId, {
      companyProfile: valuation.companyProfile,
      methods: [
        {
          methodId: "comparable_multiples",
          suitability: "Revenue comparison",
          calculationIds: [saved.calculationId],
          limitations: [],
        },
      ],
      targetPriceBasis: null,
    }),
  ).toThrow(/superseded|unsuccessful/);
});

it("calculates selected methods separately and preserves their values and order in the report", async () => {
  const f = setup();
  const bindings = new SessionBindings();
  const agent = { id: "worker" } as Agent;
  bindings.bind(agent, {
    kind: "task",
    runId: f.operation.runId,
    taskId: f.operation.taskId,
    attempt: f.operation.attempt,
  });
  const calculate = createValuationTools(f.runs, bindings).find(
    ({ name }) => name === "stock_calculate_valuation",
  )!;
  const nav: ValuationRequest = {
    ...request(),
    methodId: "adjusted_net_assets",
    inputs: {
      assets: [{ label: "Assets", fairValue: 400, ownership: 1 }],
      liabilities: 50,
      priorityClaims: 0,
      disposalCosts: 0,
    },
    sensitivities: [],
  };
  const methods = [];
  for (const input of [nav, request()]) {
    const saved = (await calculate.execute(input, {
      agent,
      callId: input.methodId,
      signal: new AbortController().signal,
    } as ToolRunContext)) as ValuationCalculation;
    methods.push({
      methodId: input.methodId,
      suitability: "Synthetic method selected by the analyst.",
      calculationIds: [saved.calculationId],
      limitations: [],
    });
  }
  const report = agentAnalysisReport();
  report.content.valuation = materializeValuation(f.runs, f.operation.runId, {
    companyProfile: "Synthetic company with asset and revenue inputs.",
    methods,
    targetPriceBasis: null,
  });
  expect(
    report.content.valuation.methods.map(({ methodId, valueRange }) => ({
      methodId,
      valueRange,
    })),
  ).toEqual([
    {
      methodId: "adjusted_net_assets",
      valueRange: { low: 35, high: 35, unit: "USD/share" },
    },
    {
      methodId: "comparable_multiples",
      valueRange: { low: 13.5, high: 22.5, unit: "USD/share" },
    },
  ]);
  expect(methods[0]!.calculationIds).not.toEqual(methods[1]!.calculationIds);
  expect(() =>
    validateCalculatedReport(f.runs, f.operation, report),
  ).not.toThrow();
});

it("keeps the native calculation schema compact while enforcing selected-method inputs", async () => {
  const f = setup();
  const bindings = new SessionBindings();
  const agent = { id: "worker" } as Agent;
  bindings.bind(agent, {
    kind: "task",
    runId: f.operation.runId,
    taskId: f.operation.taskId,
    attempt: f.operation.attempt,
  });
  const calculate = createValuationTools(f.runs, bindings).find(
    ({ name }) => name === "stock_calculate_valuation",
  )!;
  assertSupportedJsonSchema(calculate.parameters);
  expect(JSON.stringify(calculate.parameters).length).toBeLessThan(8000);
  expect(calculate.parameters).toMatchObject({
    properties: { inputs: { type: "object", additionalProperties: true } },
  });
  for (const value of [
    { ...request(), methodId: "adjusted_net_assets" },
    { ...request(), inputs: { ...request().inputs, unknown: 1 } },
  ]) {
    expect(validateJsonSchemaValue(calculate.parameters, value)).toEqual([]);
    await expect(
      calculate.execute(value, {
        agent,
        callId: "invalid-inputs",
        signal: new AbortController().signal,
      } as ToolRunContext),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
});

it("binds calculation tools to trusted tasks and authorizes all run reads", async () => {
  const f = setup();
  const bindings = new SessionBindings();
  const tools = createValuationTools(f.runs, bindings);
  const task = { id: "worker" } as Agent;
  bindings.bind(task, {
    kind: "task",
    runId: f.operation.runId,
    taskId: f.operation.taskId,
    attempt: f.operation.attempt,
  });
  const coordinator = { id: "coordinator" } as Agent;
  bindings.bind(coordinator, {
    kind: "coordinator",
    runIds: [f.operation.runId],
  });
  const call = (name: string, args: unknown, agent: Agent) =>
    tools
      .find((tool) => tool.name === name)!
      .execute(args, {
        agent,
        callId: name,
        signal: new AbortController().signal,
      } as ToolRunContext);
  const saved = (await call("stock_calculate_valuation", request(), task)) as {
    calculationId: string;
  };
  expect(
    await call(
      "stock_read_valuation_calculation",
      { runId: f.operation.runId, calculationId: saved.calculationId },
      coordinator,
    ),
  ).toMatchObject({ calculationId: saved.calculationId });
  await expect(
    call("stock_calculate_valuation", request(), coordinator),
  ).rejects.toThrow(/ACCESS_DENIED/);
  await expect(
    call("stock_calculate_valuation", request(), { id: "outside" } as Agent),
  ).rejects.toThrow(/ACCESS_DENIED/);
  await expect(
    call(
      "stock_read_valuation_calculation",
      { runId: "foreign", calculationId: saved.calculationId },
      task,
    ),
  ).rejects.toThrow(/ACCESS_DENIED/);
  await expect(
    call(
      "stock_read_valuation_method",
      { runId: "foreign", methodId: "comparable_multiples" },
      task,
    ),
  ).rejects.toThrow(/ACCESS_DENIED/);
});

function roleTask(
  id: string,
  outputKinds: OpenRunInput["definition"]["tasks"][number]["outputKinds"] = [
    "analysis",
  ],
): OpenRunInput["definition"]["tasks"][number] {
  return {
    id,
    executor: { kind: "role", role: "analyst", specialty: "fundamentals" },
    dependsOn: [],
    inputTasks: [],
    outputKinds,
    dataRequirements: [],
    instructionVersion: 1,
  };
}

it.each(["calculation", "report"] as const)(
  "invalidates independent downstream tasks adopting a %s dependency",
  (adoption) => {
    const f = setup([roleTask("A"), roleTask("B")]);
    const source = request();
    source.inputs.multiples = [0.5];
    const a = calculateValuation(f.runs, f.operation, source, "a");
    const claim = f.runs.claim(
      { runId: f.operation.runId, identity: "coordinator" },
      "B",
      "claim-b",
    );
    const bOperation = {
      ...f.operation,
      taskId: "B",
      attempt: claim.attempt,
      identity: "worker-b",
      sessionId: "worker-b",
    };
    let bCalculationId: string;
    if (adoption === "calculation") {
      const combined: ValuationRequest = {
        ...source,
        methodId: "sum_of_parts",
        inputs: {
          parts: [{ label: "A", ownership: 1, calculationId: a.calculationId }],
          groupAssets: 0,
          groupLiabilities: 0,
          headOffice: { kind: "none" },
        },
        sensitivities: [],
      };
      const b = calculateValuation(f.runs, bOperation, combined, "b");
      expect(b.result.perShareValues).toEqual([22.5]);
      bCalculationId = b.calculationId;
    } else {
      bCalculationId = calculateValuation(
        f.runs,
        bOperation,
        source,
        "b-independent",
      ).calculationId;
      const report = agentAnalysisReport();
      report.content.valuation = materializeValuation(
        f.runs,
        f.operation.runId,
        {
          companyProfile: "Synthetic company",
          methods: [
            {
              methodId: "comparable_multiples",
              suitability: "Revenue comparison",
              calculationIds: [a.calculationId],
              limitations: [],
            },
          ],
          targetPriceBasis: null,
        },
      );
      const artifact = assembleAgentArtifact("analysis", report, {
        taskId: "B",
        specialty: "fundamentals",
        title: "B adopts A",
        inputRefs: [],
        currency: "USD",
        scope: f.input.definition.scope,
        referencePrice: null,
      });
      new ArtifactService(f.runs, new NumberService(f.runs)).submitArtifact(
        bOperation,
        [artifact],
        "commit-b",
      );
    }
    f.runs.redo(
      { runId: f.operation.runId, identity: "coordinator" },
      "A",
      "redo-a",
    );
    const bState = f.runs
      .numberContext(f.operation.runId)
      .tasks.find(({ taskId }) => taskId === "B")!;
    expect(bState.attempts.at(-1)!.status).toBe("invalidated");
    expect(() =>
      readValuationCalculation(f.runs, f.operation.runId, bCalculationId),
    ).toThrow(/superseded|unsuccessful/);
    expect(valuationCalculationCatalog(f.runs, f.operation.runId)).toEqual([]);
  },
);

it.each(["different-value", "missing-calculation"] as const)(
  "rejects %s decision payload target claims diverging from their computed report target",
  (mutation) => {
    const f = setup([
      {
        ...roleTask("digest", ["digest"]),
        executor: { kind: "service", service: "digest" },
      },
      {
        ...roleTask("manager.decision", ["decision_draft"]),
        executor: { kind: "role", role: "manager", specialty: "decision" },
      },
    ]);
    const digest = f.runs.commitArtifact(
      f.operation,
      [
        {
          kind: "digest",
          title: "Synthetic digest",
          body: "Synthetic digest",
          inputRefs: [],
          claims: [],
          payload: {
            facts: [],
            disagreements: [],
            risks: [],
            gaps: [],
            numbers: [],
            upstreamRefs: [],
          },
        },
      ],
      "digest",
    ).refs[0]!;
    const claimed = f.runs.claim(
      { runId: f.operation.runId, identity: "coordinator" },
      "manager.decision",
      "manager",
    );
    const operation = {
      ...f.operation,
      taskId: "manager.decision",
      attempt: claimed.attempt,
      identity: "manager",
      sessionId: "manager",
    };
    const inputs = request();
    inputs.inputs.multiples = [0.5];
    const valuation = calculateValuation(
      f.runs,
      operation,
      inputs,
      "valuation",
    );
    inputs.purpose = "target_price";
    const target = calculateValuation(f.runs, operation, inputs, "target");
    const report: AgentReport<"decision_draft"> = {
      summary: "Synthetic decision",
      content: {
        thesis: ["Synthetic thesis"],
        targetPrice: materializeTargetPrice(
          f.runs,
          operation.runId,
          target.calculationId,
        ),
        valuation: materializeValuation(f.runs, operation.runId, {
          companyProfile: "Synthetic company",
          methods: [
            {
              methodId: "comparable_multiples",
              suitability: "Revenue comparison",
              calculationIds: [valuation.calculationId],
              limitations: [],
            },
          ],
          targetPriceBasis:
            "Unchanged shares and valuation assumptions at target date.",
        }),
        risks: [],
        riskResponses: [],
        invalidationConditions: [],
        limitations: [],
      },
    };
    const artifact = assembleAgentArtifact("decision_draft", report, {
      taskId: operation.taskId,
      specialty: "decision",
      title: "Computed decision",
      inputRefs: [digest],
      currency: "USD",
      scope: f.input.definition.scope,
      referencePrice: null,
    });
    const service = new ArtifactService(f.runs, new NumberService(f.runs));
    expect(() =>
      service.validateArtifact(operation, [artifact], "correct"),
    ).not.toThrow();
    const forged = structuredClone(artifact);
    const targetClaim = forged.claims.find(
      ({ id }) => id === "decision.target",
    )!;
    if (targetClaim.kind !== "estimated")
      throw new Error("Expected estimated target");
    if (mutation === "different-value") {
      targetClaim.value = 99;
      delete targetClaim.calculationId;
    } else delete targetClaim.calculationId;
    expect(() =>
      service.validateArtifact(operation, [forged], mutation),
    ).toThrow();
  },
);

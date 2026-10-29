import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  authorizeRun,
  taskOperation,
  type SessionBindings,
} from "../host/bindings.js";
import type { RunService } from "../services/runs.js";
import {
  calculateValuation,
  readValuationCalculation,
  savedValuationMethods,
} from "../services/valuation-calculations.js";
import {
  VALUATION_INPUT_SCHEMAS,
  valuationCalculationParameters,
} from "../services/valuation-inputs.js";
import {
  VALUATION_ENGINE_VERSION,
  type ValuationMethodId,
} from "../contracts/valuation.js";
import { ResearchError } from "../contracts/errors.js";
import {
  object,
  objectSchema,
  opaqueObjectSchema,
  resultOutput,
  stringSchema,
  text,
} from "./parameters.js";
import { researchTool } from "./errors.js";

export function valuationMethodDetail(
  methods: ReturnType<typeof savedValuationMethods>,
  methodId: string,
) {
  const method = methods.methods.find(({ id }) => id === methodId);
  if (method === undefined)
    throw new ResearchError(
      "INVALID_INPUT",
      `Unknown valuation method ${methodId}.`,
    );
  return structuredClone({
    version: methods.version,
    calculationEngineVersion: VALUATION_ENGINE_VERSION,
    conventions: methods.conventions,
    method,
    sources: methods.sources.filter(({ id }) => method.sourceIds.includes(id)),
    calculationInputSchema:
      VALUATION_INPUT_SCHEMAS[methodId as ValuationMethodId],
  });
}

export function createValuationTools(
  runs: RunService,
  bindings: SessionBindings,
): ToolDefinition[] {
  return [
    researchTool({
      name: "stock_calculate_valuation",
      description:
        "在当前研究任务内确定性计算并保存估值、目标日期估值及参数敏感性。提供基础预测与明确日期；代码推导利润、税、营运资本变化、权益滚存、再投资、终值、CAPM/WACC及按天折现，裁切已过期间。金额与股数独立声明数量级，利率/概率用小数，币种继承运行。PE/PB/PS/P-CF直接给权益价值，EV倍数才桥接债务与现金。负残值正常保存并返回diagnostics，不能作为目标价；不要求调参取得正值。返回calculationId、每股结果及步骤；模型不能覆盖结果。主Agent通过派工调用，读取已保存结果。",
      parameters:
        valuationCalculationParameters as typeof valuationCalculationParameters &
          Record<string, unknown>,
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        return calculateValuation(
          runs,
          taskOperation(bindings.require(exec.agent)),
          value,
          exec.callId,
        );
      },
    }),
    researchTool({
      name: "stock_read_valuation_calculation",
      description:
        "读取获准运行中不可变的估值计算、输入依据、算法版本及中间步骤。",
      parameters: objectSchema({
        runId: stringSchema,
        calculationId: stringSchema,
      }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const input = object(value, ["runId", "calculationId"]);
        const runId = text(input.runId, "runId");
        authorizeRun(bindings.require(exec.agent).binding, runId);
        return readValuationCalculation(
          runs,
          runId,
          text(input.calculationId, "calculationId"),
        );
      },
    }),
    researchTool({
      name: "stock_read_valuation_method",
      description:
        "读取获准运行保存的估值方法、输入约束、文献及计算输入Schema。",
      parameters: objectSchema({ runId: stringSchema, methodId: stringSchema }),
      output: resultOutput(opaqueObjectSchema),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const input = object(value, ["runId", "methodId"]);
        const runId = text(input.runId, "runId");
        authorizeRun(bindings.require(exec.agent).binding, runId);
        return valuationMethodDetail(
          savedValuationMethods(runs, runId),
          text(input.methodId, "methodId"),
        );
      },
    }),
  ];
}

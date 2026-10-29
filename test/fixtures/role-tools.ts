import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { expect } from "vitest";
import { initialInput } from "./quick-host.js";
import type { RoleInput } from "./research-workflow.js";

/** Verify the tools actually sent to the model against the role's business contract. */
export function expectRoleTools(request: GenerateOptions): void {
  const input = initialInput<RoleInput>(request);
  const task = input.task.id;
  const expected = [
    "stock_write_report",
    "stock_read_report_draft",
    "stock_write_handoff",
    "stock_submit",
  ];
  if (input.context.reportCatalog.length > 0)
    expected.push("stock_read_report");
  if (task === "analysis.public") expected.push("stock_search_public");
  else if (task.startsWith("analysis.") && input.context.dataCatalog.length > 0)
    expected.push("stock_describe_collection", "stock_read_collection");
  const valuation =
    task === "analysis.fundamentals" ||
    task.startsWith("debate.") ||
    task === "risk.main" ||
    task === "risk.valuation" ||
    task === "manager.decision";
  if (valuation)
    expected.push(
      "stock_read_valuation_method",
      "stock_calculate_valuation",
      "stock_read_valuation_calculation",
    );
  else {
    const system = JSON.stringify(
      request.messages.filter(({ role }) => role === "system"),
    );
    expect(system, task).not.toContain("stock_calculate_valuation");
    expect(input.context, task).not.toHaveProperty("valuationMethods");
    expect(input.context, task).not.toHaveProperty("financialMetrics");
    expect(input.context, task).not.toHaveProperty("valuationCalculations");
  }
  expect(request.tools?.map(({ name }) => name).sort(), task).toEqual(
    expected.sort(),
  );
  expect(JSON.stringify(request.tools), task).not.toMatch(/\p{Script=Han}/u);
}

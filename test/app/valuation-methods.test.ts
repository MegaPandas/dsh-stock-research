import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { expect, it } from "vitest";
import {
  createValuationMethodTool,
  VALUATION_METHODS,
} from "../../src/app/valuation-methods.js";

it("keeps method selection and literature references resolvable in the bundled catalogue", () => {
  const methods = new Set(VALUATION_METHODS.methods.map(({ id }) => id));
  const sources = new Set(VALUATION_METHODS.sources.map(({ id }) => id));
  expect(methods.size).toBe(11);
  for (const method of VALUATION_METHODS.methods)
    for (const id of method.sourceIds)
      expect(sources.has(id), `${method.id}: ${id}`).toBe(true);
  for (const group of VALUATION_METHODS.stageGuidance)
    for (const id of group.candidateMethodIds)
      expect(methods.has(id)).toBe(true);
  for (const group of VALUATION_METHODS.typeOverlays)
    for (const id of group.methodIds) expect(methods.has(id)).toBe(true);
});

it("rejects unknown method IDs without returning another method", async () => {
  const tool = createValuationMethodTool(VALUATION_METHODS);
  await expect(
    tool.execute({ methodId: "invented" }, {
      signal: new AbortController().signal,
    } as ToolRunContext),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("returns the selected method's full input contract on demand", async () => {
  const tool = createValuationMethodTool(VALUATION_METHODS);
  const detail = await tool.execute({ methodId: "fcff_dcf" }, {
    signal: new AbortController().signal,
  } as ToolRunContext);
  expect(detail).toMatchObject({
    method: { id: "fcff_dcf" },
    calculationInputSchema: {
      type: "object",
      required: [
        "forecastStartDate",
        "openingWorkingCapital",
        "periods",
        "discountRate",
        "terminal",
        "bridge",
      ],
      additionalProperties: false,
      properties: {
        periods: {
          type: "array",
          items: {
            required: [
              "endDate",
              "revenue",
              "operatingMargin",
              "taxRate",
              "depreciation",
              "capex",
              "workingCapital",
            ],
            additionalProperties: false,
          },
        },
        bridge: {
          required: [
            "excessCash",
            "nonOperatingAssets",
            "debt",
            "preferredEquity",
            "minorityInterest",
            "otherClaims",
          ],
          additionalProperties: false,
        },
      },
    },
  });
});

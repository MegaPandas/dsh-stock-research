import { Buffer } from "node:buffer";
import { initialInput } from "../../test/fixtures/quick-host.js";
import {
  isMainResearchRequest,
  type RoleInput,
} from "../../test/fixtures/research-workflow.js";
import { sample } from "./research-pipeline.js";
import { CALCULATION_RULES } from "../../src/app/research-prompts.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
type Sizes = {
  systemPrompt: number;
  messages: number;
  tools: number;
  total: number;
};
type ToolSizes = {
  requests: number;
  name: number;
  description: number;
  parameters: number;
  total: number;
};
type Group = {
  role: string;
  task: string;
  requests: number;
  first: Sizes;
  cumulative: Sizes;
  tools: Record<string, ToolSizes>;
  firstDetails: {
    calculationRules: number;
    valuationMethodFields: Record<string, number>;
    writeReportValuationSchemas: { path: string; bytes: number }[];
  };
};

function valuationSchemas(value: unknown, path = "parameters") {
  const found: { path: string; bytes: number }[] = [];
  if (value !== null && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      const location = `${path}.${key}`;
      if (key === "valuation")
        found.push({ path: location, bytes: bytes(child) });
      else found.push(...valuationSchemas(child, location));
    }
  return found;
}

/** Measures serialized UTF-8 input bytes, not provider tokens or wire framing. */
export async function contextSample(mode: "quick" | "deep") {
  const groups = new Map<string, Group>();
  const result = await sample(mode, "slow-macro", undefined, (request) => {
    const input = isMainResearchRequest(request)
      ? { role: "main", id: "main" }
      : initialInput<RoleInput>(request).task;
    const systemMessages = request.messages.filter(
      ({ role }) => role === "system",
    );
    const tools = (request.tools ?? []).map(
      ({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }),
    );
    const measured = {
      systemPrompt:
        bytes(systemMessages) +
        (request.system === undefined ? 0 : bytes(request.system)),
      messages: bytes(request.messages.filter(({ role }) => role !== "system")),
      tools: bytes(tools),
      total: 0,
    };
    measured.total = measured.systemPrompt + measured.messages + measured.tools;
    const key = `${input.role}/${input.id}`;
    let group = groups.get(key);
    if (group === undefined) {
      const context = isMainResearchRequest(request)
        ? undefined
        : (initialInput<RoleInput>(request).context as unknown as {
            valuationMethods?: Record<string, unknown>;
          });
      const systemText =
        JSON.stringify(systemMessages) + (request.system ?? "");
      // JSON serialization escapes the line breaks inside the shared rule block.
      const serializedRules = JSON.stringify(CALCULATION_RULES).slice(1, -1);
      const ruleOccurrences =
        systemText.split(serializedRules).length -
        1 +
        ((request.system ?? "").split(CALCULATION_RULES).length - 1);
      group = {
        role: input.role,
        task: input.id,
        requests: 0,
        first: measured,
        cumulative: { systemPrompt: 0, messages: 0, tools: 0, total: 0 },
        tools: {},
        firstDetails: {
          calculationRules: ruleOccurrences * bytes(CALCULATION_RULES),
          valuationMethodFields: Object.fromEntries(
            ["selectionBasis", "stageGuidance", "typeOverlays"].flatMap(
              (key) =>
                context?.valuationMethods?.[key] === undefined
                  ? []
                  : [[key, bytes(context.valuationMethods[key])]],
            ),
          ),
          writeReportValuationSchemas: tools
            .filter(({ name }) => name === "stock_write_report")
            .flatMap(({ parameters }) => valuationSchemas(parameters)),
        },
      };
      groups.set(key, group);
    }
    group.requests++;
    for (const field of Object.keys(measured) as (keyof Sizes)[])
      group.cumulative[field] += measured[field];
    for (const tool of tools) {
      const row = (group.tools[tool.name] ??= {
        requests: 0,
        name: 0,
        description: 0,
        parameters: 0,
        total: 0,
      });
      row.requests++;
      row.name += bytes(tool.name);
      row.description += bytes(tool.description);
      row.parameters += bytes(tool.parameters);
      row.total += bytes(tool);
    }
  });
  const rows = [...groups.values()].sort((a, b) =>
    a.task.localeCompare(b.task),
  );
  return {
    mode,
    profile: "slow-macro",
    timing: result.timing,
    assertionsPassed: true,
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    cumulative: rows.reduce(
      (sum, row) => {
        for (const key of Object.keys(sum) as (keyof Sizes)[])
          sum[key] += row.cumulative[key];
        return sum;
      },
      { systemPrompt: 0, messages: 0, tools: 0, total: 0 },
    ),
    groups: rows.map((row) => ({
      ...row,
      tools: Object.fromEntries(
        Object.entries(row.tools)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => [
            name,
            {
              ...value,
              shareOfTools: value.total / row.cumulative.tools,
              fieldShares: {
                name: value.name / value.total,
                description: value.description / value.total,
                parameters: value.parameters / value.total,
              },
            },
          ]),
      ),
    })),
  };
}

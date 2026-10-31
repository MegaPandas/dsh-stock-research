import type { ToolDefinition, JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { EvidenceData } from "../contracts/query.js";
import { ResearchError } from "../contracts/errors.js";
import {
  authorizeRun,
  taskOperation,
  type SessionBindings,
} from "../host/bindings.js";
import { parseArtifactInput } from "../artifacts/schema.js";
import {
  checkNumbersParameters,
  checkPendingNumbersParameters,
} from "./artifact-inputs.js";
import type { MemoryAccess } from "../contracts/memory-service.js";
import type { NumberChecker } from "../contracts/numbers.js";
import { readPointer, SelectorError } from "../json/pointer.js";
import type { QueryService } from "../services/query/index.js";
import type { RunReader } from "../contracts/run-access.js";
import type { RunReadOperations } from "../host/run-reading.js";
import {
  collectionGaps,
  collectionRowSelectors,
} from "../services/collection/view.js";
import { researchTool } from "./errors.js";
import { createDataHealthTool } from "./data-health.js";
import { createRecallTool } from "./recall.js";
import {
  artifactRef,
  artifactRefSchema,
  object,
  objectSchema,
  sourceRef,
  sourceRefSchema,
  stringSchema,
  text,
  resultOutput as output,
} from "./parameters.js";

export interface ReadToolServices {
  runs: Pick<RunReader, "view" | "readEvidence">;
  reads: RunReadOperations;
  queries: Pick<QueryService, "health">;
  memory: Pick<MemoryAccess, "recall" | "recallForTask">;
  numbers: NumberChecker;
}
const opaqueObject: JsonSchemaNode = {
  type: "object",
  additionalProperties: true,
};
const kind = (value: string): JsonSchemaNode => ({
  type: "string",
  const: value,
});
const numberCheckOutput = objectSchema({
  checkerVersion: stringSchema,
  target: opaqueObject,
  scope: opaqueObject,
  passed: { type: "boolean" },
  claims: { type: "array", items: opaqueObject },
});
export function createReadTools(
  services: ReadToolServices,
  bindings: SessionBindings,
): ToolDefinition[] {
  const { runs, reads, queries, memory, numbers } = services;
  return [
    researchTool({
      name: "stock_read_run",
      description: "Read an authorized run's status, tasks and artifact index.",
      parameters: objectSchema({ runId: stringSchema }),
      output: output(
        objectSchema({ kind: kind("run_view"), view: opaqueObject }),
      ),
      async execute(value, exec) {
        return { kind: "run_view", view: reads.readRun(value, exec) };
      },
    }),
    researchTool({
      name: "stock_read_artifact",
      description:
        "Read a fixed artifact version by reference in an authorized run.",
      parameters: objectSchema({ ref: artifactRefSchema }),
      output: output(
        objectSchema({ kind: kind("artifact"), artifact: opaqueObject }),
      ),
      async execute(value, exec) {
        return { kind: "artifact", artifact: reads.readArtifact(value, exec) };
      },
    }),
    researchTool({
      name: "stock_read_evidence",
      description:
        "Read authorized evidence fields and source metadata by reference.",
      parameters: objectSchema({ ref: sourceRefSchema }),
      output: output(
        objectSchema({
          kind: kind("evidence"),
          ref: sourceRefSchema,
          value: {},
          metadata: opaqueObject,
        }),
      ),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["ref"]);
        const ref = sourceRef(item.ref);
        authorizeRun(caller.binding, ref.runId);
        const envelope = runs.readEvidence<EvidenceData>(ref).envelope;
        let selected: unknown;
        try {
          selected = readPointer(envelope, ref.selector).value;
        } catch (cause) {
          if (!(cause instanceof SelectorError)) throw cause;
          throw new ResearchError("INVALID_INPUT", cause.message, { cause });
        }
        const metadata = { ...envelope };
        Reflect.deleteProperty(metadata, "data");
        Reflect.deleteProperty(metadata, "candidateClaims");
        if ("table" in envelope.data) {
          const row = /^\/data\/rows\/(\d+)(?:\/|$)/.exec(ref.selector);
          metadata.gaps = collectionGaps(envelope.gaps, [
            ref.selector,
            ...(row === null ? [] : collectionRowSelectors(Number(row[1]))),
          ]);
        }
        return { kind: "evidence", ref, value: selected, metadata };
      },
    }),
    createDataHealthTool(queries, runs, bindings),
    createRecallTool(memory, bindings),
    researchTool({
      name: "stock_check_numbers",
      description:
        "Check numeric claims in an authorized fixed artifact and return results without modifying it.",
      parameters: checkNumbersParameters(),
      output: output(numberCheckOutput),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["ref"]);
        const ref = artifactRef(item.ref);
        authorizeRun(caller.binding, ref.runId);
        return numbers.checkNumbers(
          { runId: ref.runId, identity: caller.agent.id },
          { kind: "artifact", ref },
        );
      },
    }),
    researchTool({
      name: "stock_check_pending_numbers",
      description:
        "Check numeric claims in the current task's complete pending artifact and return results without modifying it.",
      parameters: checkPendingNumbersParameters(),
      output: output(numberCheckOutput),
      async execute(value, exec) {
        exec.signal.throwIfAborted();
        const caller = bindings.require(exec.agent);
        const item = object(value, ["contentId", "content"]);
        const runId = taskOperation(caller).runId;
        return numbers.checkNumbers(
          { runId, identity: caller.agent.id },
          {
            kind: "pending",
            contentId: text(item.contentId, "contentId"),
            content: parseArtifactInput(item.content),
          },
        );
      },
    }),
  ];
}

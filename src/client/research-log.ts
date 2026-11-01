import type {
  CollectionCounts,
  ResearchJobRecord,
  ResearchProgress,
} from "../contracts/research-progress.js";

export type ResearchLogEntry =
  | { kind: "message"; text: string }
  | { kind: "record"; path: string }
  | { kind: "diagnostic"; datasets: string[]; source: string; message: string };

/** The native output ring can retain only the tail of its first JSON record. */
function readRecord(line: string): ResearchJobRecord | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as ResearchJobRecord;
  } catch {
    return undefined;
  }
}

export function researchLog(text: string) {
  let progress: ResearchProgress | undefined;
  let collection: CollectionCounts | undefined;
  const entries: ResearchLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = readRecord(line);
    switch (record?.type) {
      case "research/progress":
        progress = record.progress;
        if (record.progress.state.phase.kind === "collection")
          collection = record.progress.state.phase.counts;
        else entries.push({ kind: "message", text: record.progress.text });
        break;
      case "research/collection-record":
        entries.push({ kind: "record", path: record.path });
        break;
      case "research/diagnostic": {
        const message = `${record.code}: ${record.message}`;
        const previous = entries.at(-1);
        if (
          previous?.kind === "diagnostic" &&
          previous.source === record.source &&
          previous.message === message
        )
          previous.datasets.push(record.dataset);
        else
          entries.push({
            kind: "diagnostic",
            datasets: [record.dataset],
            source: record.source,
            message,
          });
        break;
      }
      case "research/message":
        entries.push({ kind: "message", text: record.text });
        break;
      default:
        entries.push({ kind: "message", text: line });
    }
  }
  return { progress, collection, entries };
}

export type ResearchLog = ReturnType<typeof researchLog>;

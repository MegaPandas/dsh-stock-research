export function collectionCounts(progress: string | undefined) {
  const match =
    /^采集数据\s+(\d+)\/(\d+)(?:\s*·\s*成功\s*(\d+)[，,]\s*缺失\s*(\d+))?/.exec(
      progress ?? "",
    );
  if (match === null || Number(match[2]) === 0) return undefined;
  return {
    completed: Number(match[1]),
    total: Number(match[2]),
    succeeded: match[3] === undefined ? undefined : Number(match[3]),
    missing: match[4] === undefined ? undefined : Number(match[4]),
  };
}

export type ResearchLogEntry =
  | { kind: "message"; text: string }
  | { kind: "record"; path: string }
  | { kind: "diagnostic"; datasets: string[]; source: string; message: string };

export function researchLog(text: string) {
  let collection: ReturnType<typeof collectionCounts>;
  const entries: ResearchLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const counts = collectionCounts(line);
    if (counts) {
      collection = counts;
      continue;
    }
    const record = /^采集记录：(.+)$/.exec(line);
    if (record) {
      entries.push({ kind: "record", path: record[1]! });
      continue;
    }
    // Collection failure lines describe a source attempt, not the research outcome.
    const diagnostic = /^(\S+) · (\S+) · ([\w./-]+: .+)$/.exec(line);
    if (diagnostic) {
      const previous = entries.at(-1);
      if (
        previous?.kind === "diagnostic" &&
        previous.source === diagnostic[2] &&
        previous.message === diagnostic[3]
      ) {
        previous.datasets.push(diagnostic[1]!);
      } else {
        entries.push({
          kind: "diagnostic",
          datasets: [diagnostic[1]!],
          source: diagnostic[2]!,
          message: diagnostic[3]!,
        });
      }
      continue;
    }
    entries.push({ kind: "message", text: line });
  }
  return { collection, entries };
}

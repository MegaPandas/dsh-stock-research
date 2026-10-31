import type {
  CollectionFailure,
  CollectionOptions,
  CollectionPlan,
  CollectionTask,
} from "../../contracts/collection.js";

const REQUIRED_DATA_TIMEOUT_MS = 45_000;
const TABLE_TIMEOUT_MS = 120_000;

/** Compile source capabilities before execution; source order defines preference. */
export function createCollectionPlans(
  sources: readonly CollectionTask[],
  options: Pick<CollectionOptions, "enabledSources" | "requireDailyMarket">,
): { plans: CollectionPlan[]; disabled: CollectionFailure[] } {
  const enabled = new Set(options.enabledSources);
  const tables = new Map<string, CollectionTask[]>();
  for (const source of sources) {
    const candidates = tables.get(source.id);
    if (candidates) candidates.push(source);
    else tables.set(source.id, [source]);
  }
  const plans: CollectionPlan[] = [];
  const disabled: CollectionFailure[] = [];
  for (const [id, sources] of tables) {
    const candidates = sources.filter((source) =>
      source.enabledBy.every((key) => enabled.has(key)),
    );
    if (candidates.length === 0) {
      disabled.push({
        id,
        provider: sources[0]!.provider,
        code: "SOURCE_UNAVAILABLE",
        detail: "This dataset's sources are not enabled in the deployment.",
      });
      continue;
    }
    const required =
      options.requireDailyMarket === true && id === "market.daily";
    plans.push({
      id,
      dataset: candidates[0]!.dataset,
      candidates,
      required,
      timeoutMs: required ? REQUIRED_DATA_TIMEOUT_MS : TABLE_TIMEOUT_MS,
    });
  }
  return { plans, disabled };
}

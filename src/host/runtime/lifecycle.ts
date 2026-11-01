export type Dispose = () => void | Promise<void>;

export async function settle(actions: readonly Dispose[]): Promise<unknown[]> {
  return (
    await Promise.allSettled(
      actions.map((action) => Promise.resolve().then(action)),
    )
  ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
export function throwFailures(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Research runtime cleanup failed.", {
      cause: failures[0],
    });
}
export async function releaseReverse(
  actions: readonly Dispose[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of [...actions].reverse())
    failures.push(...(await settle([action])));
  throwFailures(failures);
}

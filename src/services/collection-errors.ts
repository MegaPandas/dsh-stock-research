import type { CollectionError } from "../contracts/collection.js";

export function collectionError(cause: unknown): CollectionError {
  if (!(cause instanceof Error))
    return { name: "Error", message: String(cause) };
  const code =
    "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return {
    name: cause.name,
    message: cause.message,
    ...(code === undefined ? {} : { code }),
    ...(cause.cause instanceof Error
      ? { cause: collectionError(cause.cause) }
      : {}),
    ...(cause instanceof AggregateError
      ? { errors: cause.errors.map(collectionError) }
      : {}),
  };
}

export function collectionErrorDetail(error: CollectionError): string {
  return [
    `${error.message}${error.code === undefined ? "" : ` [${error.code}]`}`,
    ...(error.cause === undefined ? [] : [collectionErrorDetail(error.cause)]),
    ...(error.errors?.map(collectionErrorDetail) ?? []),
  ].join(" → ");
}

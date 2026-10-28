export type ResearchErrorCode =
  | "INVALID_INPUT"
  | "ACCESS_DENIED"
  | "TASK_NOT_READY"
  | "STALE_ATTEMPT"
  | "REQUEST_CONFLICT"
  | "SOURCE_UNAVAILABLE"
  | "DATA_INSUFFICIENT"
  | "INVALID_ARTIFACT"
  | "NUMBER_MISMATCH"
  | "STORAGE_FAILED"
  | "VERSION_UNAVAILABLE";

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;

  constructor(
    code: ResearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResearchError";
    this.code = code;
  }
}

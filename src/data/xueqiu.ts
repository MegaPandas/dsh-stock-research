import { ResearchError } from "../contracts/errors.js";
import type { HttpClient } from "./http.js";
import { parseSourceJson, sourceError, sourceObject } from "./source.js";

const localDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function xueqiuTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(new Date(value).getTime())
  )
    sourceError(field, "expected a millisecond timestamp");
  return new Date(value).toISOString();
}

export function xueqiuDate(value: unknown, field: string): string {
  return localDate.format(new Date(xueqiuTimestamp(value, field)));
}

/** Credentials remain in the transport, outside captured research inputs. */
export class XueqiuClient {
  readonly #cookie: string;

  constructor(
    private readonly http: Pick<HttpClient, "getText">,
    cookie: string,
  ) {
    this.#cookie = cookie;
  }

  async get(
    path: string,
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{
    data: Record<string, unknown>;
    url: string;
    retrievedAt: string;
  }> {
    const url = new URL(path, "https://stock.xueqiu.com");
    url.search = new URLSearchParams(parameters).toString();
    const response = parseSourceJson(
      await this.http.getText(url, {
        ...(signal && { signal }),
        headers: {
          Cookie: this.#cookie,
          Referer: "https://xueqiu.com/",
        },
      }),
    );
    if (response.error_code !== 0)
      throw new ResearchError(
        "SOURCE_UNAVAILABLE",
        "Xueqiu rejected the data request. Check the configured Cookie and source availability.",
      );
    return {
      data: sourceObject(response.data, "data"),
      url: url.href,
      retrievedAt: new Date().toISOString(),
    };
  }
}

import { ResearchError } from "../contracts/errors.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface HttpClientOptions {
  timeoutMs: number;
  maxConcurrency: number;
  minIntervalMs: number;
}

export interface HttpRequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface HttpRequestMetadata {
  readonly url: string;
  readonly method: "GET" | "POST";
}

const requestMetadata = new WeakMap<Error, HttpRequestMetadata>();

export function getHttpRequestMetadata(
  error: unknown,
): HttpRequestMetadata | undefined {
  return error instanceof Error ? requestMetadata.get(error) : undefined;
}

function requestUrl(url: string | URL): string {
  return String(url).split(/[?#]/, 1)[0]!;
}

export class HttpStatusError extends ResearchError {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(response: Response) {
    super(
      "SOURCE_UNAVAILABLE",
      `HTTP ${response.status} ${response.statusText}`,
    );
    this.name = "HttpStatusError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = requestUrl(response.url);
  }
}

export class HttpClient {
  readonly #timeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #minIntervalMs: number;
  readonly #lifetime = new AbortController();
  readonly #waiting = new Set<() => void>();
  readonly #operations = new Set<Promise<string>>();
  readonly #sources = new Map<string, HttpClient>();
  #active = 0;
  #nextStartAt = 0;
  #wakeUp: ReturnType<typeof setTimeout> | undefined;

  constructor({ timeoutMs, maxConcurrency, minIntervalMs }: HttpClientOptions) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      !Number.isInteger(minIntervalMs) ||
      minIntervalMs < 0 ||
      minIntervalMs > MAX_TIMEOUT_MS
    ) {
      throw new ResearchError(
        "INVALID_INPUT",
        "HTTP timeout must be an integer from 1 to 2147483647 ms, concurrency a positive safe integer, and minimum interval an integer from 0 to 2147483647 ms",
      );
    }
    this.#timeoutMs = timeoutMs;
    this.#maxConcurrency = maxConcurrency;
    this.#minIntervalMs = minIntervalMs;
  }

  getText(
    url: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<string> {
    return this.#start(url, options, "GET");
  }

  forSource(source: string): HttpClient {
    this.#lifetime.signal.throwIfAborted();
    let client = this.#sources.get(source);
    if (!client) {
      client = new HttpClient({
        timeoutMs: this.#timeoutMs,
        maxConcurrency: 1,
        minIntervalMs: this.#minIntervalMs,
      });
      this.#sources.set(source, client);
    }
    return client;
  }

  /** Some public statistics endpoints expose read-only queries through POST. */
  postText(
    url: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<string> {
    return this.#start(url, options, "POST");
  }

  #start(
    url: string | URL,
    options: HttpRequestOptions,
    method: "GET" | "POST",
  ): Promise<string> {
    const operation = this.#request(url, options, method);
    this.#operations.add(operation);
    const remove = () => {
      this.#operations.delete(operation);
    };
    void operation.then(remove, remove);
    return operation;
  }

  async close(): Promise<void> {
    this.#lifetime.abort(
      new DOMException("HTTP client is closed", "AbortError"),
    );
    await Promise.allSettled([
      ...this.#operations,
      ...Array.from(this.#sources.values(), (client) => client.close()),
    ]);
  }

  async #request(
    url: string | URL,
    options: HttpRequestOptions,
    method: "GET" | "POST",
  ): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new DOMException("HTTP request timed out", "TimeoutError"));
    }, this.#timeoutMs);
    timer.unref();
    const signals = [this.#lifetime.signal, timeout.signal];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let acquired = false;

    try {
      await this.#acquire(signal);
      acquired = true;
      signal.throwIfAborted();
      const response = await fetch(url, { ...options, method, signal });
      if (!response.ok) {
        const error = new HttpStatusError(response);
        try {
          await response.body?.cancel();
        } catch (cause) {
          error.cause = cause;
        }
        throw error;
      }
      return await response.text();
    } catch (error) {
      // Body consumption may replace the caller's reason with a generic AbortError.
      if (signal.aborted) {
        if (signal.reason === timeout.signal.reason) {
          requestMetadata.set(signal.reason as Error, {
            url: requestUrl(url),
            method,
          });
        }
        signal.throwIfAborted();
      }
      if (error instanceof Error) {
        requestMetadata.set(error, { url: requestUrl(url), method });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (acquired) this.#release();
    }
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.#waiting.delete(grant);
        if (this.#waiting.size === 0) {
          clearTimeout(this.#wakeUp);
          this.#wakeUp = undefined;
        }
        reject(signal.reason);
      };
      this.#waiting.add(grant);
      signal.addEventListener("abort", abort, { once: true });
      this.#drain();
    });
  }

  #release(): void {
    this.#active--;
    this.#drain();
  }

  #drain(): void {
    if (this.#wakeUp !== undefined) return;
    while (this.#active < this.#maxConcurrency && this.#waiting.size > 0) {
      const now = performance.now();
      const remaining = this.#nextStartAt - now;
      if (remaining > 0) {
        // This timer keeps a queued request alive even when no I/O is running.
        this.#wakeUp = setTimeout(() => {
          this.#wakeUp = undefined;
          this.#drain();
        }, Math.ceil(remaining));
        return;
      }
      const next = this.#waiting.values().next().value!;
      this.#waiting.delete(next);
      this.#active++;
      this.#nextStartAt = now + this.#minIntervalMs;
      next();
    }
  }
}

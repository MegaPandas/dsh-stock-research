import { ResearchError } from "../contracts/errors.js";

interface SharedEntry<T> {
  identity: string;
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

export class SharedQueries<T> {
  readonly #lifetime = new AbortController();
  readonly #entries = new Map<string, SharedEntry<T>>();
  readonly #operations = new Set<Promise<T>>();

  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  async run(
    key: string,
    identity: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const waiterSignal = signal
      ? AbortSignal.any([this.signal, signal])
      : this.signal;
    waiterSignal.throwIfAborted();
    let entry = this.#entries.get(key);
    if (entry !== undefined && entry.identity !== identity)
      throw new ResearchError(
        "REQUEST_CONFLICT",
        "In-flight query has different content.",
      );
    if (entry === undefined) entry = this.create(key, identity, load);
    const current = entry;
    current.waiters++;

    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (complete: () => void, cancelled = false) => {
        if (finished) return;
        finished = true;
        waiterSignal.removeEventListener("abort", abort);
        current.waiters--;
        if (cancelled && current.waiters === 0 && !current.settled) {
          if (this.#entries.get(key) === current) this.#entries.delete(key);
          current.controller.abort(waiterSignal.reason);
        }
        complete();
      };
      const abort = () => finish(() => reject(waiterSignal.reason), true);
      waiterSignal.addEventListener("abort", abort, { once: true });
      current.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  async close(): Promise<void> {
    this.#lifetime.abort(
      new DOMException("Shared queries are closed", "AbortError"),
    );
    await Promise.allSettled(this.#operations);
  }

  private create(
    key: string,
    identity: string,
    load: (signal: AbortSignal) => Promise<T>,
  ): SharedEntry<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const promise = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return load(signal);
    });
    const entry = { identity, controller, promise, waiters: 0, settled: false };
    this.#entries.set(key, entry);
    this.#operations.add(promise);
    const finish = () => {
      entry.settled = true;
      this.#operations.delete(promise);
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    };
    promise.then(finish, finish);
    return entry;
  }
}

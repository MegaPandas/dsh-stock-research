import { describe, expect, it } from "vitest";
import z from "@deepseek-ai/schemastery";
import { Config, type ResearchConfig } from "../../src/host/config.js";
import { ResearchError } from "../../src/contracts/errors.js";

function parse(value: unknown): ResearchConfig {
  return z.resolve(value, Config, {})[0];
}

function input(): ResearchConfig {
  return {
    dataRoot: "/tmp/research-config-sample",
    enabledSources: ["sina", "dsh-web"],
    http: { timeoutMs: 1000, maxConcurrency: 1, minIntervalMs: 1000 },
    cache: {
      maxEntries: 100,
      ttl: { market: 0, fundamentals: 0.5, macro: 0, research: 0 },
    },
    policy: {
      freshness: { market: 0, fundamentals: 1, macro: 0 },
      secCiks: { "US:NVDA": "0001045810" },
    },
  };
}

describe("Research runtime configuration boundary", () => {
  it("accepts explicit deployment settings without probing enabled providers", () => {
    const config = input();
    expect(() => parse(null)).toThrow();
    expect(() => parse(undefined)).toThrow();
    expect(parse(config)).toEqual(config);
  });

  it("rejects the removed digest model setting", () => {
    const config = input();
    expect(() =>
      parse({
        ...config,
        digestModel: { provider: "fixture", model: "fixture" },
      }),
    ).toThrow("Unknown configuration field digestModel.");
  });

  it("skips unconfigured SEC and preserves the other selected sources", () => {
    const config = input();
    config.enabledSources = ["sina", "sec"];
    expect(parse(config).enabledSources).toEqual(["sina"]);
    expect(config.enabledSources).toEqual(["sina", "sec"]);
    config.secUserAgent = "CedarResearch/0.1 (operator@example.org)";
    expect(parse(config).enabledSources).toEqual(["sina", "sec"]);
    expect(parse(config).secUserAgent).toBe(config.secUserAgent);
    expect(() => parse({ ...config, secUserAgent: null })).toThrow();
    expect(() => parse({ ...input(), secUserAgent: null })).toThrow();
  });

  it("leaves Xueqiu disabled unless selected and retains its configured Cookie", () => {
    const config = input();
    expect(parse(config).enabledSources).not.toContain("xueqiu");
    expect(parse(config).xueqiuCookie).toBeUndefined();
    config.xueqiuCookie = "session=fixture";
    expect(parse(config).xueqiuCookie).toBe("session=fixture");
    config.enabledSources.push("xueqiu");
    expect(parse(config)).toEqual(config);
  });

  it.each([undefined, "", "   "])(
    "requires a Cookie before enabling Xueqiu: %j",
    (xueqiuCookie) => {
      expect(() =>
        parse({
          ...input(),
          enabledSources: ["xueqiu"],
          xueqiuCookie,
        }),
      ).toThrow("The enabled Xueqiu source requires a Cookie.");
    },
  );

  it.each([null, "session=fixture\r", "session=fixture\nInjected: fixture"])(
    "rejects invalid Cookie headers without including their contents: %j",
    (xueqiuCookie) => {
      expect(() => parse({ ...input(), xueqiuCookie })).toThrow(
        new ResearchError(
          "INVALID_INPUT",
          "Xueqiu Cookie must be a single-line string when supplied.",
        ),
      );
    },
  );

  it.each([NaN, Infinity, -1, null, undefined])(
    "rejects invalid durations %s at cache and freshness boundaries",
    (value) => {
      const config = input();
      expect(() =>
        parse({
          ...config,
          cache: {
            ...config.cache,
            ttl: { ...config.cache.ttl, research: value },
          },
        }),
      ).toThrow();
      expect(() =>
        parse({
          ...config,
          policy: {
            ...config.policy,
            freshness: { ...config.policy.freshness, market: value },
          },
        }),
      ).toThrow();
    },
  );

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
    { maxConcurrency: 0 },
    { maxConcurrency: 1.5 },
    { minIntervalMs: -1 },
  ])("rejects unusable HTTP controls %j", (change) => {
    const config = input();
    expect(() =>
      parse({ ...config, http: { ...config.http, ...change } }),
    ).toThrow();
  });

  it("rejects missing settings, unknown sources and configuration typos", () => {
    const config = input();
    expect(() => parse({})).toThrow();
    expect(() =>
      parse({ ...config, enabledSources: ["unconfirmed"] }),
    ).toThrow();
    expect(() => parse({ ...config, pollingMs: 1000 })).toThrow();
    expect(() =>
      parse({ ...config, http: { ...config.http, retry: 3 } }),
    ).toThrow();
    expect(() =>
      parse({
        ...config,
        cache: { ...config.cache, ttl: { ...config.cache.ttl, markets: 0 } },
      }),
    ).toThrow();
  });

  it("rejects invalid CIK and cache capacity", () => {
    const config = input();
    expect(() =>
      parse({
        ...config,
        policy: { ...config.policy, secCiks: { "US:NVDA": "0000000000" } },
      }),
    ).toThrow();
    expect(() =>
      parse({ ...config, cache: { ...config.cache, maxEntries: 0 } }),
    ).toThrow();
  });
});

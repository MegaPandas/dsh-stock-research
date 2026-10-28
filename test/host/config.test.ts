import { describe, expect, it } from "vitest";
import z from "@deepseek-ai/schemastery";
import { Config, type ResearchConfig } from "../../src/host/config.js";

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
    digestModel: { provider: "fixture", model: "fixture" },
  };
}

describe("Research runtime configuration boundary", () => {
  it("accepts explicit deployment settings without probing enabled providers", () => {
    const config = input();
    expect(() => parse(null)).toThrow();
    expect(() => parse(undefined)).toThrow();
    expect(parse(config)).toEqual(config);
  });

  it("allows the digest to inherit its caller model and validates explicit overrides", () => {
    const config = input();
    delete config.digestModel;
    expect(parse(config)).toEqual(config);
    expect(() =>
      parse({ ...config, digestModel: { provider: "fixture" } }),
    ).toThrow();
    expect(() =>
      parse({ ...config, digestModel: { model: "fixture" } }),
    ).toThrow();
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

  it("rejects invalid CIK and empty deployment identity values", () => {
    const config = input();
    expect(() =>
      parse({
        ...config,
        policy: { ...config.policy, secCiks: { "US:NVDA": "0000000000" } },
      }),
    ).toThrow();
    expect(() =>
      parse({ ...config, digestModel: { provider: " ", model: "fixture" } }),
    ).toThrow();
    expect(() =>
      parse({ ...config, cache: { ...config.cache, maxEntries: 0 } }),
    ).toThrow();
  });
});

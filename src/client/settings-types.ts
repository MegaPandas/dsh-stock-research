export interface ModelOverride {
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
}

export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelCatalog {
  default?: ModelRoute;
  groups: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      reasoning?: {
        efforts: { id: string; name: string; description?: string }[];
        defaultEffort?: string;
      };
    }[];
  }[];
}

export interface SettingsValue {
  model?: ModelOverride;
  publicSearchLimit?: number;
  runtime: {
    dataRoot: string;
    enabledSources: string[];
    http: { timeoutMs: number; maxConcurrency: number; minIntervalMs: number };
    cache: {
      maxEntries: number;
      ttl: {
        market: number;
        fundamentals: number;
        macro: number;
        research: number;
      };
    };
    policy: {
      freshness: { market: number; fundamentals: number; macro: number };
      secCiks: Record<string, string>;
    };
    secUserAgent?: string;
    xueqiuCookie?: string;
    digestModel?: ModelOverride;
  };
}

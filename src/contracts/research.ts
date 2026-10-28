import type { ResearchScope } from "./data.js";

export type HostWebSearch = (
  request: { query: string; maxResults?: number },
  signal?: AbortSignal,
) => Promise<unknown>;

export interface ResearchItem {
  url: string;
  title: string | null;
  snippet: string | null;
  providerTimestamp: string | null;
  publishedAt: null;
  availableAt: null;
  location: null;
}

export interface ResearchData {
  query: string;
  items: ResearchItem[];
  truncated: boolean;
  view: "current_search";
}

export interface ResearchQuery {
  scope: ResearchScope;
  query: string;
  maxResults?: number;
}

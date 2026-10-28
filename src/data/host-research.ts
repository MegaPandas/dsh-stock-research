import type { DataEnvelope, DataGap } from "../contracts/data.js";
import type {
  HostWebSearch,
  ResearchData,
  ResearchItem,
  ResearchQuery,
} from "../contracts/research.js";
import { sourceArray, sourceError, sourceObject } from "./source.js";
import { SOURCE_VERSIONS } from "./versions.js";

function optionalText(
  source: Record<string, unknown>,
  field: string,
): string | null {
  const value = source[field];
  if (value === undefined) return null;
  if (typeof value !== "string") sourceError(field, "expected optional text");
  return value.trim() === "" ? null : value;
}

function citationUrl(value: unknown): string {
  if (typeof value !== "string" || !URL.canParse(value))
    sourceError("url", "expected an absolute web URL");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    sourceError("url", "expected an HTTP or HTTPS citation");
  return value;
}

export class HostResearchAdapter {
  readonly capability = {
    provider: "dsh-web",
    dataset: "research",
    historicalVersions: false,
    timeFiltering: false,
    publicationTimes: false,
    documentLocations: false,
    ...SOURCE_VERSIONS["research/dsh-web"],
  } as const;

  constructor(private readonly search: HostWebSearch) {}

  async query(
    query: ResearchQuery,
    signal?: AbortSignal,
  ): Promise<DataEnvelope<ResearchData>> {
    const raw = await this.search(
      {
        query: query.query,
        ...(query.maxResults === undefined
          ? {}
          : { maxResults: query.maxResults }),
      },
      signal,
    );
    const retrievedAt = new Date().toISOString();
    const response = sourceObject(raw, "web.search");
    if (typeof response.truncated !== "boolean")
      sourceError("truncated", "expected the host result-limit flag");
    const gaps: DataGap[] = [
      {
        code: "unverified_time",
        field: "/data/items",
        detail:
          "This is a current host search snapshot. The host timestamp may mean publication or crawling and does not establish content or versions known at cutoff.",
      },
    ];
    const items: ResearchItem[] = sourceArray(response.sources, "sources").map(
      (value, index) => {
        const source = sourceObject(value, "source");
        const title = optionalText(source, "title");
        const snippet = optionalText(source, "snippet");
        if (title === null)
          gaps.push({
            code: "missing",
            field: `/data/items/${index}/title`,
            detail: "The search source provides no title.",
          });
        if (snippet === null)
          gaps.push({
            code: "missing",
            field: `/data/items/${index}/snippet`,
            detail: "The search source provides no snippet.",
          });
        gaps.push({
          code: "missing",
          field: `/data/items/${index}/location`,
          detail:
            "The host search result contains no position in the original document.",
        });
        return {
          url: citationUrl(source.url),
          title,
          snippet,
          providerTimestamp: optionalText(source, "publishedAt"),
          publishedAt: null,
          availableAt: null,
          location: null,
        };
      },
    );
    const url = new URL("dsh://web/search");
    url.search = new URLSearchParams({
      query: query.query,
      ...(query.maxResults === undefined
        ? {}
        : { maxResults: String(query.maxResults) }),
    }).toString();
    return {
      dataset: "research",
      data: {
        query: query.query,
        items,
        truncated: response.truncated,
        view: "current_search",
      },
      source: {
        provider: "dsh-web",
        url: url.href,
        adapterVersion: this.capability.adapterVersion,
        normalizationVersion: this.capability.normalizationVersion,
      },
      asOf: retrievedAt,
      availableAt: null,
      retrievedAt,
      cutoff: query.scope.cutoff,
      ageMs: Date.parse(query.scope.cutoff) - Date.parse(retrievedAt),
      stale: false,
      historicalKnowledge: "unverified",
      gaps,
    };
  }
}

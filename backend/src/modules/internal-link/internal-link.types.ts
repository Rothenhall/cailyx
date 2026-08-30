/**
 * Internal-Link Types — topical-architecture analysis (Agent #8, Swarm layer).
 *
 * One run crawls a bounded set of the **client's own** pages, builds the
 * internal link graph, and derives "add a link A → B" recommendations from
 * topical overlap + inbound-link deficit. Client-site analysis only.
 *
 * @module internal-link.types
 */

export type LinkGraphStatus = 'crawling' | 'analyzing' | 'complete' | 'failed';
export type LinkRecStatus = 'open' | 'applied' | 'dismissed';
export type PageSourceKind = 'http' | 'fixture';

/** A fetched page, source-agnostic. */
export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  status: number;
  html: string;
}

/** Abstraction over "get me this page" — HTTP (via FetcherService) or fixture. */
export interface PageSource {
  readonly kind: PageSourceKind;
  fetchPage(url: string): Promise<FetchedPage>;
  /**
   * Known page URLs independent of the link graph — a sitemap for HTTP, the full
   * page set for the fixture. Lets orphan detection see pages that BFS from the
   * root can never reach (that is what makes them orphans). Returns [] when none.
   */
  discoverSeeds(rootUrl: string): Promise<string[]>;
}

/** A node in the working graph, before persistence. */
export interface WorkingNode {
  path: string;
  url: string;
  title: string | null;
  h1: string | null;
  wordCount: number;
  topicKeywords: string[];
  depth: number;
  httpStatus: number;
}

/** A working node with graph degrees resolved. */
export interface GraphNode extends WorkingNode {
  inboundCount: number;
  outboundCount: number;
  isOrphan: boolean;
}

/** An internal link in the working graph. */
export interface WorkingEdge {
  fromPath: string;
  toPath: string;
  anchorText: string;
  rel: string | null;
  context: string | null;
}

export interface WorkingRecommendation {
  fromPath: string;
  toPath: string;
  suggestedAnchor: string;
  reason: string;
  topicOverlap: number;
  priority: number;
}

export interface AnalyzeInput {
  rootUrl?: string;
  maxPages?: number;
  maxDepth?: number;
  useLlm?: boolean;
}

export const INTERNAL_LINK_LIMITS = {
  maxPages: { min: 1, max: 300, default: 50 },
  maxDepth: { min: 1, max: 6, default: 3 },
  maxRecommendations: 100,
  /** Minimum keyword Jaccard for a pair to be recommendation-worthy. */
  minTopicOverlap: 0.12,
  /** A node with inbound <= this is "under-linked" and eligible as a rec target. */
  underLinkedInboundMax: 2,
  topicKeywordsPerPage: 8,
} as const;

/**
 * TypeScript interfaces for the fetcher module.
 *
 * All inputs and outputs of every fetcher method are defined here.
 * No `any` types — everything is explicitly typed.
 *
 * @module fetcher.types
 */

import type { BotDefinition } from './fetcher.constants';

// ─── Fetch (raw HTTP) ───────────────────────────────────────────

export interface FetchOptions {
  url: string;
  userAgent?: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  retries?: number;
  /** If true, skip cache lookup and always fetch fresh */
  bypassCache?: boolean;
  /** Cache TTL in seconds (0 = no cache, default depends on URL type) */
  cacheTtlSeconds?: number;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timing: {
    latencyMs: number;
  };
  userAgent: string;
  cached: boolean;
  retryCount: number;
}

// ─── Probe (access probe with specific UA) ──────────────────────

export interface ProbeOptions {
  url: string;
  userAgent: string;
  botName: string;
  retries?: number;
  /** Number of times to repeat the probe for determinism (default 3) */
  repeat?: number;
}

export interface ProbeAttempt {
  attempt: number;
  status: number;
  latencyMs: number;
  blocked: boolean;
}

export interface ProbeResult {
  url: string;
  botName: string;
  userAgent: string;
  /** Stable status code across all attempts (most common) */
  status: number;
  /** True if the stable status indicates a block (403, 401, 429, 503) */
  blocked: boolean;
  latencyMs: number;
  attempts: ProbeAttempt[];
  /** True if different attempts returned different statuses (flapping) */
  inconsistent: boolean;
}

// ─── Render (headless browser) ──────────────────────────────────

export interface RenderOptions {
  url: string;
  jsDisabled?: boolean;
  timeout?: number;
  /** If true, capture a screenshot as base64 PNG */
  screenshot?: boolean;
}

export interface RenderResult {
  url: string;
  finalUrl: string;
  html: string;
  text: string;
  title: string;
  screenshot?: string;
  timing: {
    latencyMs: number;
  };
  jsDisabled: boolean;
}

// ─── Schema (JSON-LD extraction) ────────────────────────────────

export interface SchemaResult {
  url: string;
  schemas: SchemaBlock[];
  raw: string;
}

export interface SchemaBlock {
  type: string;
  fields: Record<string, unknown>;
}

// ─── Verify URL (sameAs check) ──────────────────────────────────

export interface VerifyUrlOptions {
  url: string;
  expectedName?: string;
}

export interface VerifyUrlResult {
  url: string;
  finalUrl: string;
  resolves: boolean;
  statusCode?: number;
  title?: string;
  identityMatch?: boolean;
  checkedAt: string;
}

// ─── PSI (PageSpeed Insights) ───────────────────────────────────

export interface PsiResult {
  url: string;
  lcp: number;
  cls: number;
  inp: number;
  performanceScore: number;
  raw: unknown;
}

// ─── AI Assistant Query ─────────────────────────────────────────

export type AiProvider = 'openai' | 'anthropic' | 'perplexity' | 'google';

export interface QueryAssistantOptions {
  provider: AiProvider;
  prompt: string;
  geo?: string;
  model?: string;
}

export interface QueryAssistantResult {
  provider: AiProvider;
  answer: string;
  citations?: string[];
  timing: {
    latencyMs: number;
  };
  cost: number;
  model: string;
}

// ─── Web Search ─────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  provider?: string;
  geo?: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
}

// ─── Fetch Log ──────────────────────────────────────────────────

export interface FetchLogEntry {
  id: string;
  runId?: string;
  calledBy: string;
  method: string;
  url: string;
  userAgent: string;
  httpStatus: number;
  latencyMs: number;
  cost: number;
  cached: boolean;
  retryCount: number;
  timestamp: string;
}

// ─── Cost Tracking ──────────────────────────────────────────────

export interface CostEntry {
  runId: string;
  method: string;
  cost: number;
  timestamp: string;
}

// ─── Circuit Breaker ────────────────────────────────────────────

export interface CircuitBreakerState {
  domain: string;
  failures: number;
  isOpen: boolean;
  openedAt?: number;
  lastFailureAt?: number;
}
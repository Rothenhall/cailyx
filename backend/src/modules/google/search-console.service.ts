/**
 * Google Search Console — Search Analytics API (v3).
 *
 * Reads: `listSites` feeds the resource picker; `summary` pulls the headline
 * clicks / impressions / CTR / position for a project's mapped site plus its
 * top queries and pages over a rolling window. One write: `submitSitemap`
 * re-submits the property's sitemaps, which needs the read/write `webmasters`
 * scope (G19/D17).
 *
 * @module google/search-console.service
 */

import { BadGatewayException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { GoogleConnectionService } from './google-connection.service';
import { GSC_SCOPE_READWRITE } from './google.types';
import type { DateWindow, GoogleResourceOption, SearchConsoleSummary } from './google.types';

const API = 'https://searchconsole.googleapis.com/webmasters/v3';
const INSPECT_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

export interface SaRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** The slice of the URL Inspection response the SEO audit reads. */
export interface UrlInspection {
  coverageState: string | null;
  verdict: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  sitemaps: string[];
  referringUrls: string[];
  richResultsVerdict: string | null;
  /** detected rich-result items with any issues attached */
  richResultItems: Array<{ type: string; issues: Array<{ severity: string; message: string }> }>;
}

function window(days: number): DateWindow {
  const end = new Date();
  // GSC data lags ~2 days; end the window there so totals are not artificially low.
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end), days };
}

@Injectable()
export class SearchConsoleService {
  private readonly logger = new Logger(SearchConsoleService.name);

  constructor(private readonly connections: GoogleConnectionService) {}

  private async call<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
    const token = await this.connections.accessTokenFor(userId, 'search-console');
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`GSC ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(`Search Console API ${res.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Verified sites the connected account can read. */
  async listSites(userId: string): Promise<GoogleResourceOption[]> {
    const data = await this.call<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>(
      userId,
      '/sites',
    );
    return (data.siteEntry ?? [])
      .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
      .map((s) => ({ id: s.siteUrl, label: s.siteUrl, detail: s.permissionLevel }));
  }

  async summary(userId: string, siteUrl: string, days = 28): Promise<SearchConsoleSummary> {
    const range = window(days);
    const enc = encodeURIComponent(siteUrl);
    const base = { startDate: range.startDate, endDate: range.endDate };

    const query = (dimensions: string[], rowLimit: number) =>
      this.call<{ rows?: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }> }>(
        userId,
        `/sites/${enc}/searchAnalytics/query`,
        { method: 'POST', body: JSON.stringify({ ...base, dimensions, rowLimit }) },
      );

    const [totalsRes, queriesRes, pagesRes] = await Promise.all([
      query([], 1),
      query(['query'], 10),
      query(['page'], 10),
    ]);

    const t = totalsRes.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const shape = (
      rows: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }> = [],
    ) =>
      rows.map((r) => ({
        key: r.keys?.[0] ?? '(unknown)',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));

    return {
      range,
      site: siteUrl,
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
      topQueries: shape(queriesRes.rows),
      topPages: shape(pagesRes.rows),
    };
  }

  /* ── lower-level calls the SEO audit builds on ─────────────────────────── */

  /** Raw Search Analytics query. `startDate`/`endDate` are YYYY-MM-DD. */
  async searchAnalytics(
    userId: string,
    siteUrl: string,
    body: {
      startDate: string;
      endDate: string;
      dimensions?: string[];
      rowLimit?: number;
      startRow?: number;
      dimensionFilterGroups?: unknown[];
    },
  ): Promise<SaRow[]> {
    const res = await this.call<{ rows?: SaRow[] }>(
      userId,
      `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return (res.rows ?? []).map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
  }

  /** URL Inspection for a single URL. Returns null when Google has nothing on it. */
  async inspectUrl(userId: string, siteUrl: string, inspectionUrl: string): Promise<UrlInspection | null> {
    const token = await this.connections.accessTokenFor(userId, 'search-console');
    const res = await fetch(INSPECT_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) {
      this.logger.warn(`GSC inspect ${inspectionUrl} -> ${res.status}: ${text.slice(0, 200)}`);
      throw new BadGatewayException(`URL Inspection API ${res.status}`);
    }
    const d = (JSON.parse(text || '{}').inspectionResult ?? {}) as Record<string, any>;
    const idx = d.indexStatusResult ?? {};
    const rr = d.richResultsResult ?? {};
    return {
      coverageState: idx.coverageState ?? null,
      verdict: idx.verdict ?? null,
      indexingState: idx.indexingState ?? null,
      robotsTxtState: idx.robotsTxtState ?? null,
      pageFetchState: idx.pageFetchState ?? null,
      googleCanonical: idx.googleCanonical ?? null,
      userCanonical: idx.userCanonical ?? null,
      lastCrawlTime: idx.lastCrawlTime ?? null,
      sitemaps: Array.isArray(idx.sitemap) ? idx.sitemap : [],
      referringUrls: Array.isArray(idx.referringUrls) ? idx.referringUrls : [],
      richResultsVerdict: rr.verdict ?? null,
      richResultItems: (rr.detectedItems ?? []).flatMap((grp: any) =>
        (grp.items ?? []).map((it: any) => ({
          type: String(grp.richResultType ?? 'unknown'),
          issues: (it.issues ?? []).map((is: any) => ({
            severity: String(is.severity ?? 'WARNING'),
            message: String(is.issueMessage ?? ''),
          })),
        })),
      ),
    };
  }

  /** Submitted sitemaps + their error / warning counts. */
  async listSitemaps(
    userId: string,
    siteUrl: string,
  ): Promise<Array<{ path: string; errors: number; warnings: number; lastDownloaded: string | null; isPending: boolean }>> {
    const d = await this.call<{ sitemap?: Array<any> }>(
      userId,
      `/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    );
    return (d.sitemap ?? []).map((s) => ({
      path: String(s.path ?? ''),
      errors: Number(s.errors ?? 0),
      warnings: Number(s.warnings ?? 0),
      lastDownloaded: s.lastDownloaded ?? null,
      isPending: Boolean(s.isPending),
    }));
  }

  /**
   * Re-submit a sitemap so Google recrawls it. This is one thing Cailyx can
   * actually *do* about discovery, rather than only advise.
   *
   * `sitemaps.submit` is a `PUT`, so it needs the read/write `webmasters`
   * scope — a grant holding only `webmasters.readonly` (every connection made
   * before G19/D17) cannot call it. That is checked here rather than left for
   * Google to answer with a 403, because the operator's fix (reconnect Search
   * Console and accept the write scope) is not derivable from a 403.
   */
  async submitSitemap(userId: string, siteUrl: string, feedpath: string): Promise<void> {
    // Token first: it throws the accurate "not connected / authorisation
    // expired" error, so the scope message below is only ever reached when a
    // usable grant exists and the question really is what it grants.
    const token = await this.connections.accessTokenFor(userId, 'search-console');
    if (!(await this.connections.hasGrantedScope(userId, 'search-console', GSC_SCOPE_READWRITE))) {
      throw new ConflictException(
        'The connected Search Console grant is read-only, so Cailyx cannot submit sitemaps. ' +
          'Reconnect Search Console from this project\'s connections screen to grant write access.',
      );
    }
    const res = await fetch(
      `${API}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok && res.status !== 204) {
      throw new BadGatewayException(`Sitemap submit ${res.status}`);
    }
  }
}

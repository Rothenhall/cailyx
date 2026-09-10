/**
 * Google Search Console — Search Analytics API (v3).
 *
 * Read-only. `listSites` feeds the resource picker; `summary` pulls the
 * headline clicks / impressions / CTR / position for a project's mapped site
 * plus its top queries and pages over a rolling window.
 *
 * @module google/search-console.service
 */

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { GoogleConnectionService } from './google-connection.service';
import type { DateWindow, GoogleResourceOption, SearchConsoleSummary } from './google.types';

const API = 'https://searchconsole.googleapis.com/webmasters/v3';

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
}

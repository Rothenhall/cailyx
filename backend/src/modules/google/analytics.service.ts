/**
 * Google Analytics 4 — Admin API (property list) + Data API (runReport).
 *
 * Read-only, and consented as read-only: `listProperties` feeds the resource
 * picker against the `analytics.readonly` grant (`accountSummaries.list`
 * accepts it), and `summary` pulls sessions / users / views / engagement for a
 * project's mapped GA4 property plus a channel breakdown and the top pages
 * over a rolling window. Nothing here writes to Analytics (G19/D17).
 *
 * @module google/analytics.service
 */

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { GoogleConnectionService } from './google-connection.service';
import type { AnalyticsSummary, DateWindow, GaLandingSessionPage, GaLandingSessionRow, GoogleResourceOption } from './google.types';

const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

function window(days: number): DateWindow {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // GA "yesterday" is the last complete day
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end), days };
}

interface GaReport {
  rows?: Array<{ dimensionValues?: Array<{ value: string }>; metricValues?: Array<{ value: string }> }>;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly connections: GoogleConnectionService) {}

  private async call<T>(userId: string, url: string, init?: RequestInit): Promise<T> {
    const token = await this.connections.accessTokenFor(userId, 'analytics');
    const res = await fetch(url, {
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
      this.logger.warn(`GA ${url} -> ${res.status}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(`Analytics API ${res.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** GA4 properties visible to the connected account, flattened across accounts. */
  async listProperties(userId: string): Promise<GoogleResourceOption[]> {
    const data = await this.call<{
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property: string; displayName: string }>;
      }>;
    }>(userId, `${ADMIN_API}/accountSummaries?pageSize=200`);

    const out: GoogleResourceOption[] = [];
    for (const acc of data.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        out.push({ id: p.property, label: p.displayName || p.property, detail: acc.displayName });
      }
    }
    return out;
  }

  async summary(userId: string, property: string, days = 28): Promise<AnalyticsSummary> {
    const range = window(days);
    const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
    const metrics = [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
    ];
    const run = (body: Record<string, unknown>) =>
      this.call<GaReport>(userId, `${DATA_API}/${property}:runReport`, {
        method: 'POST',
        body: JSON.stringify({ dateRanges, ...body }),
      });

    const [totalsRes, channelRes, pageRes] = await Promise.all([
      run({ metrics }),
      run({
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      }),
      run({
        metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
        dimensions: [{ name: 'pagePath' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),
    ]);

    const n = (v: string | undefined) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };
    const tv = totalsRes.rows?.[0]?.metricValues ?? [];

    return {
      range,
      property,
      totals: {
        sessions: n(tv[0]?.value),
        totalUsers: n(tv[1]?.value),
        screenPageViews: n(tv[2]?.value),
        engagementRate: n(tv[3]?.value),
        averageSessionDuration: n(tv[4]?.value),
      },
      channels: (channelRes.rows ?? []).map((r) => ({
        key: r.dimensionValues?.[0]?.value ?? '(other)',
        sessions: n(r.metricValues?.[0]?.value),
        totalUsers: n(r.metricValues?.[1]?.value),
      })),
      topPages: (pageRes.rows ?? []).map((r) => ({
        key: r.dimensionValues?.[0]?.value ?? '(unknown)',
        screenPageViews: n(r.metricValues?.[0]?.value),
        sessions: n(r.metricValues?.[1]?.value),
      })),
    };
  }

  /** The GA4 property's configured reporting timezone — disclosed, not assumed to match GSC's Pacific clock. */
  async propertyTimezone(userId: string, property: string): Promise<string | null> {
    try {
      const d = await this.call<{ timeZone?: string }>(userId, `${ADMIN_API}/${property}`);
      return d.timeZone ?? null;
    } catch {
      return null;
    }
  }

  /**
   * P12 (§7.3) data extension: landing-page + session-source/channel facts —
   * a real landing-session report, not the `pagePath`/`screenPageViews`
   * summary above (`pagePath` is an ordinary page-view dimension; it does
   * not tell you which sessions *entered* on that page, which is what a
   * page-level "visitors landing on this page" figure requires).
   *
   * `landingPage` + `sessionDefaultChannelGroup` + `sessionSource` + `date`
   * are documented GA4 Data API dimensions and are mutually compatible with
   * `sessions` / `totalUsers` / `engagedSessions` — validated against the
   * GA4 Data API schema before this report was built (see google.types.ts).
   */
  async landingSessionFacts(
    userId: string,
    property: string,
    opts: { days?: number; limit?: number } = {},
  ): Promise<GaLandingSessionPage> {
    const range = window(opts.days ?? 28);
    const limit = Math.min(opts.limit ?? 1000, 100_000); // GA4 Data API's own documented per-report cap
    const tz = await this.propertyTimezone(userId, property);

    const res = await this.call<GaReport>(userId, `${DATA_API}/${property}:runReport`, {
      method: 'POST',
      body: JSON.stringify({
        dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
        dimensions: [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }, { name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }],
        limit,
      }),
    });

    const n = (v: string | undefined) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };
    const rows: GaLandingSessionRow[] = (res.rows ?? []).map((r) => ({
      landingPage: r.dimensionValues?.[0]?.value ?? null,
      channelGroup: r.dimensionValues?.[1]?.value ?? null,
      sessionSource: r.dimensionValues?.[2]?.value ?? null,
      date: r.dimensionValues?.[3]?.value ?? null,
      sessions: n(r.metricValues?.[0]?.value),
      totalUsers: n(r.metricValues?.[1]?.value),
      engagedSessions: n(r.metricValues?.[2]?.value),
    }));

    return {
      range,
      timezoneNote: tz
        ? `GA4 property timezone: ${tz} (may not align with GSC's Pacific-time day boundaries)`
        : 'GA4 property timezone unavailable — treat day boundaries as approximate versus GSC (Pacific)',
      property,
      rows,
      rowCount: rows.length,
      complete: rows.length < limit,
    };
  }
}

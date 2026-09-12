/**
 * DataForSEO Business Data adapter — wave-6 decision D2
 * (`docs/analysis/wave-6-audit-pipeline.md`).
 *
 * Two lookups:
 *   - Business Data → Google → My Business Info: the profile itself (name,
 *     categories, opening hours, aggregate rating).
 *   - Business Data → Google / Trustpilot / Yelp → Reviews: rating + count
 *     ONLY per platform. DataForSEO gives no sentiment score, and this
 *     adapter does not invent one over review text — that would be a
 *     fabricated number presented as a measurement.
 *
 * Same vendor and the same auth convention as `serp-intelligence`'s
 * `DataForSeoProvider` — Basic Auth from `DATAFORSEO_LOGIN` /
 * `DATAFORSEO_PASSWORD`, gated behind the `SWARM_ALLOW_LIVE=1` master switch
 * because a call costs money — reused here rather than re-implemented.
 *
 * **Neither credential is set in this repo's `backend/.env`** (only a
 * commented placeholder exists in `.env.example`), so every method below
 * fails closed with a typed `ServiceUnavailableException` naming exactly what
 * is missing. This adapter must never return an empty or fabricated profile
 * in place of that error — a blank business profile and "we didn't look" are
 * different answers, and only one of them is true when credentials are absent.
 *
 * Endpoint paths follow DataForSEO's documented Business Data catalogue; D2
 * flags them "to confirm against their catalogue at build time", and there is
 * no live credential here to do that confirmation. The task-envelope shape
 * (`tasks[0].result[0].items[]`, `status_code` on the task) is DataForSEO's
 * universal contract across every one of its APIs — already proven live by
 * `serp-intelligence`'s `DataForSeoProvider` — so that part is not a guess;
 * only the business-specific field names inside one result item are
 * best-effort. Those are read defensively (several candidate keys tried per
 * field) and the full raw result is always stored alongside, so a schema
 * drift loses nothing — it just leaves a column null until the mapping is
 * updated.
 *
 * @module presence.dataforseo.service
 */

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FetcherService } from '../fetcher/fetcher.service';

const MY_BUSINESS_INFO_URL = 'https://api.dataforseo.com/v3/business_data/google/my_business_info/live';
const GOOGLE_REVIEWS_URL = 'https://api.dataforseo.com/v3/business_data/google/reviews/live';
const TRUSTPILOT_REVIEWS_URL = 'https://api.dataforseo.com/v3/business_data/trustpilot/reviews/live';
const YELP_REVIEWS_URL = 'https://api.dataforseo.com/v3/business_data/yelp/reviews/live';

export type ReviewPlatform = 'google' | 'trustpilot' | 'yelp';

/** The business profile, normalised. Anything not mapped survives in `raw`. */
export interface BusinessProfileResult {
  source: 'google-my-business';
  name: string | null;
  categories: string[];
  /** Provider's own shape, JSON-stringified verbatim — never reshaped here. */
  hours: string | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  raw: string;
}

/** One review platform's rating + count. No sentiment — see module doc. */
export interface ReviewResult {
  platform: ReviewPlatform;
  rating: number | null;
  reviewCount: number | null;
  url: string | null;
  raw: string;
}

interface DataForSeoEnvelope {
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: Array<{ items?: unknown[] }>;
  }>;
}

@Injectable()
export class PresenceDataForSeoService {
  constructor(
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
  ) {}

  /** True only when both the master switch and credentials are configured. */
  get enabled(): boolean {
    return (
      this.config.get<string>('SWARM_ALLOW_LIVE') === '1' &&
      !!this.config.get<string>('DATAFORSEO_LOGIN') &&
      !!this.config.get<string>('DATAFORSEO_PASSWORD')
    );
  }

  /**
   * Pull the Google My Business profile.
   *
   * @throws ServiceUnavailableException when the master switch or either
   *   credential is absent, naming exactly what is missing.
   */
  async fetchProfile(businessName: string, locationName: string): Promise<BusinessProfileResult> {
    const envelope = await this.call(MY_BUSINESS_INFO_URL, [
      { keyword: businessName, location_name: locationName, language_code: 'en' },
    ]);
    const item = firstItem(envelope);
    const raw = JSON.stringify(item ?? {});
    if (!item) {
      return {
        source: 'google-my-business',
        name: null,
        categories: [],
        hours: null,
        rating: null,
        reviewCount: null,
        address: null,
        phone: null,
        website: null,
        raw,
      };
    }
    return {
      source: 'google-my-business',
      name: pickString(item, ['title', 'name']),
      categories: pickCategories(item),
      hours: pickHours(item),
      rating: pickRating(item),
      reviewCount: pickReviewCount(item),
      address: pickString(item, ['address', 'full_address']),
      phone: pickString(item, ['phone', 'phone_number']),
      website: pickString(item, ['url', 'website', 'domain']),
      raw,
    };
  }

  /**
   * Pull one review platform's rating + count.
   *
   * @throws ServiceUnavailableException when the master switch or either
   *   credential is absent, naming exactly what is missing.
   */
  async fetchReviews(platform: ReviewPlatform, businessName: string, locationName: string): Promise<ReviewResult> {
    const url =
      platform === 'google' ? GOOGLE_REVIEWS_URL : platform === 'trustpilot' ? TRUSTPILOT_REVIEWS_URL : YELP_REVIEWS_URL;
    const envelope = await this.call(url, [{ keyword: businessName, location_name: locationName, language_code: 'en' }]);
    const item = firstItem(envelope);
    const raw = JSON.stringify(item ?? {});
    return {
      platform,
      rating: item ? pickRating(item) : null,
      reviewCount: item ? pickReviewCount(item) : null,
      url: item ? pickString(item, ['url', 'review_url', 'profile_url']) : null,
      raw,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Fail closed, naming exactly what is missing — never a silent empty call. */
  private assertConfigured(): { login: string; password: string } {
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      throw new ServiceUnavailableException(
        'DataForSEO Business Data is blocked — set SWARM_ALLOW_LIVE=1 to allow paid DataForSEO calls.',
      );
    }
    const login = this.config.get<string>('DATAFORSEO_LOGIN');
    const password = this.config.get<string>('DATAFORSEO_PASSWORD');
    if (!login || !password) {
      throw new ServiceUnavailableException(
        'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not configured — set both to pull business-profile or review data.',
      );
    }
    return { login, password };
  }

  private async call(url: string, tasks: Array<Record<string, unknown>>): Promise<DataForSeoEnvelope> {
    const { login, password } = this.assertConfigured();
    const auth = Buffer.from(`${login}:${password}`).toString('base64');
    const res = await this.fetcher.fetch(
      {
        url,
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(tasks),
      },
      'digital-presence',
    );
    if (res.status >= 400) {
      throw new Error(`DataForSEO HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`);
    }
    const parsed = JSON.parse(res.body || '{}') as DataForSeoEnvelope;
    const task = parsed.tasks?.[0];
    if (!task || (task.status_code && task.status_code >= 40000)) {
      throw new Error(`DataForSEO task error: ${task?.status_message ?? 'no task returned'}`);
    }
    return parsed;
  }
}

function firstItem(envelope: DataForSeoEnvelope): Record<string, unknown> | null {
  const item = envelope.tasks?.[0]?.result?.[0]?.items?.[0];
  return item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
}

function pickString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickCategories(item: Record<string, unknown>): string[] {
  const cat = item.category;
  const extra = item.additional_categories;
  const out: string[] = [];
  if (typeof cat === 'string') out.push(cat);
  if (Array.isArray(extra)) out.push(...extra.filter((c): c is string => typeof c === 'string'));
  return out;
}

function pickHours(item: Record<string, unknown>): string | null {
  const hours = item.work_time ?? item.hours ?? item.working_hours;
  return hours ? JSON.stringify(hours) : null;
}

function pickRating(item: Record<string, unknown>): number | null {
  const rating = item.rating;
  if (rating && typeof rating === 'object') {
    const value = (rating as Record<string, unknown>).value;
    if (typeof value === 'number') return value;
  }
  if (typeof rating === 'number') return rating;
  return null;
}

function pickReviewCount(item: Record<string, unknown>): number | null {
  const rating = item.rating;
  if (rating && typeof rating === 'object') {
    const votes = (rating as Record<string, unknown>).votes_count;
    if (typeof votes === 'number') return votes;
  }
  const direct = item.reviews_count ?? item.total_reviews;
  return typeof direct === 'number' ? direct : null;
}

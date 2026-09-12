/**
 * Apify social-activity adapter — wave-6 decision D7
 * (`docs/analysis/wave-6-audit-pipeline.md`).
 *
 * DataForSEO's Business Data (D2) gives profiles, listings and reviews but
 * nothing about organic social activity — posting cadence, followers,
 * engagement. Apify closes that gap by reading the platforms directly.
 *
 * ## This adapter must never spend money by accident
 *
 * `APIFY_API_KEY` is a REAL key on a REAL account with a **$5/month usage
 * credit** (the FREE plan). Every actor run is real spend against that
 * ceiling. Two independent gates:
 *   1. `APIFY_API_KEY` must be configured — fails closed with a typed 503,
 *      same convention as `PresenceDataForSeoService` and
 *      `measurement/adapters/cloro.adapter.ts`'s `CloroClient.key()`.
 *   2. The caller must pass `confirmSpend: true` — checked in
 *      `PresenceService.socialActivity()` BEFORE this adapter is touched at
 *      all, mirroring the existing `searchWeb` opt-in on `discover()`. A
 *      default/automatic presence scan must never reach this file.
 *
 * This module was built, reviewed and read against D7 — it has NEVER made a
 * live Apify call, in development or otherwise, and must not until an
 * operator explicitly runs it against a project they intend to spend on.
 *
 * ## API shape (D7 — the run lifecycle, not the per-actor input, is
 * documented and not a guess):
 *   `POST /v2/actors/{actorId}/runs` (async) → `{ data: { id, status,
 *   defaultDatasetId } }`. Actor ids are `owner/name`; Apify's REST path
 *   wants `owner~name`, hence {@link encodeActorId}.
 *   `GET  /v2/actor-runs/{runId}` polled until a terminal status
 *   (`SUCCEEDED` | `FAILED` | `ABORTED` | `TIMED-OUT`).
 *   `GET  /v2/datasets/{id}/items` → the raw item array; schema is
 *   actor-specific and normalised at {@link normalizeItem}.
 * The 300s sync run-and-get-items variant is documented as too short for
 * anything real (D7) and is never used — this is async-only, same discipline
 * as `cloro.adapter.ts`'s task submit/poll.
 *
 * ## What is NOT verified
 * D7 says plainly: "Per-actor input schemas are unverified. Step 5 confirms
 * each against one live run before building on it." That confirmation step
 * is exactly the live call this task forbids, so {@link buildInput} is
 * best-effort against each actor's publicly documented Store listing, kept
 * to one small function per actor so correcting it later (from one real,
 * operator-authorised run) touches nothing else. {@link normalizeItem}
 * mirrors that caution on the way out: several candidate field names are
 * tried per metric and an absent one is `null`, never guessed — D7 warns
 * actor output schemas "differ wildly", and that variance must not leak past
 * this file.
 *
 * @module presence.apify.service
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const APIFY_BASE_URL = 'https://api.apify.com/v2';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — actor runs are minutes, not seconds

export type ApifyPlatform = 'linkedin' | 'instagram' | 'facebook' | 'twitter' | 'youtube' | 'tiktok';

export const ALL_APIFY_PLATFORMS: readonly ApifyPlatform[] = [
  'linkedin',
  'instagram',
  'facebook',
  'twitter',
  'youtube',
  'tiktok',
];

/** D7's default set. YouTube/TikTok are supported but off unless requested/configured. */
export const DEFAULT_APIFY_PLATFORMS: readonly ApifyPlatform[] = ['linkedin', 'instagram', 'facebook', 'twitter'];

type ActorRole = 'profile' | 'posts';

/** platform:role -> actorId. From D7's actor table, chosen on reliability then price. */
const DEFAULT_ACTORS: Record<string, string> = {
  'linkedin:profile': 'harvestapi/linkedin-company',
  'linkedin:posts': 'harvestapi/linkedin-profile-posts',
  'instagram:profile': 'apify/instagram-profile-scraper',
  'instagram:posts': 'apify/instagram-post-scraper',
  'facebook:profile': 'apify/facebook-pages-scraper',
  'facebook:posts': 'apify/facebook-posts-scraper',
  // X/Twitter has one actor covering posts only in D7's table — no separate
  // profile-info actor was selected.
  'twitter:posts': 'xquik/x-tweet-scraper',
  'youtube:profile': 'streamers/youtube-channel-scraper',
  'tiktok:profile': 'clockworks/tiktok-profile-scraper',
};

/** Per-unit prices from D7's actor table, USD. Used only as a cost estimate
 *  when a run's own `usageTotalUsd` is unavailable — never as the billed figure. */
const ACTOR_UNIT_COST_USD: Record<string, number> = {
  'harvestapi/linkedin-company': 0.004,
  'harvestapi/linkedin-profile-posts': 0.002,
  'apify/instagram-profile-scraper': 0.0026,
  'apify/instagram-post-scraper': 0.0017,
  'apify/facebook-pages-scraper': 0.012,
  'apify/facebook-posts-scraper': 0.005,
  'xquik/x-tweet-scraper': 0.00015,
  'streamers/youtube-channel-scraper': 0.0013,
  'clockworks/tiktok-profile-scraper': 0.003,
};

/** One target to enrich: the account's own URL/handle, when one is on file. */
export interface ApifyTarget {
  platform: ApifyPlatform;
  url: string | null;
  handle: string | null;
}

/** One normalised row, ready for `PresencePost.create()`. */
export interface NormalizedSocialItem {
  platform: ApifyPlatform;
  kind: 'profile' | 'post';
  postedAt: string | null;
  url: string | null;
  caption: string | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  viewCount: number | null;
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  actorId: string;
  raw: string;
}

export interface ApifyRoleResult {
  platform: ApifyPlatform;
  role: ActorRole;
  actorId: string;
  items: NormalizedSocialItem[];
  costUsd: number;
  error: string | null;
}

export interface ApifyRunResult {
  results: ApifyRoleResult[];
  skipped: Array<{ platform: ApifyPlatform; reason: string }>;
  totalCostUsd: number;
}

interface ApifyRunSummary {
  id: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
}

@Injectable()
export class PresenceApifyService {
  private readonly logger = new Logger(PresenceApifyService.name);

  constructor(private readonly config: ConfigService) {}

  /** True only when the key is configured. Callers report the absence, never guess. */
  get enabled(): boolean {
    return !!this.config.get<string>('APIFY_API_KEY');
  }

  /** The platform set to use when a request does not name its own. */
  defaultPlatforms(): ApifyPlatform[] {
    const raw = this.config.get<string>('APIFY_PLATFORMS');
    if (!raw) return [...DEFAULT_APIFY_PLATFORMS];
    const parsed = raw
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p): p is ApifyPlatform => (ALL_APIFY_PLATFORMS as readonly string[]).includes(p));
    return parsed.length > 0 ? parsed : [...DEFAULT_APIFY_PLATFORMS];
  }

  /**
   * Run the configured actors for each target platform and return normalised
   * rows. Callers (`PresenceService.socialActivity()`) are responsible for
   * the `confirmSpend` opt-in gate — by the time this method is called, the
   * decision to spend has already been made explicitly.
   *
   * @throws ServiceUnavailableException when `APIFY_API_KEY` is not configured.
   */
  async run(targets: ApifyTarget[], postsPerPlatform: number): Promise<ApifyRunResult> {
    // Fail closed BEFORE touching the network, same convention as
    // PresenceDataForSeoService and CloroClient.key().
    const key = this.assertConfigured();
    const actors = this.resolveActorMap();

    const results: ApifyRoleResult[] = [];
    const skipped: ApifyRunResult['skipped'] = [];

    for (const target of targets) {
      if (!target.url && !target.handle) {
        skipped.push({ platform: target.platform, reason: 'no linked account on file for this platform' });
        continue;
      }

      const roles: ActorRole[] = target.platform === 'twitter' ? ['posts'] : ['profile', 'posts'];
      for (const role of roles) {
        const actorId = actors[`${target.platform}:${role}`];
        if (!actorId) continue; // not every platform has both roles (e.g. twitter has no profile actor)

        try {
          const input = buildInput(target.platform, role, target, postsPerPlatform);
          const summary = await this.runActor(key, actorId, input);
          const rawItems = await this.getDatasetItems(key, summary.defaultDatasetId);
          const items = rawItems.map((raw) => normalizeItem(target.platform, role, actorId, raw));
          const costUsd = summary.usageTotalUsd ?? estimateCost(actorId, items.length);
          results.push({ platform: target.platform, role, actorId, items, costUsd, error: null });
        } catch (err) {
          const message = (err as Error).message;
          this.logger.warn(`Apify ${target.platform}:${role} (${actorId}) failed: ${message}`);
          results.push({ platform: target.platform, role, actorId, items: [], costUsd: 0, error: message });
        }
      }
    }

    const totalCostUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
    return { results, skipped, totalCostUsd };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private assertConfigured(): string {
    const key = this.config.get<string>('APIFY_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException(
        'APIFY_API_KEY is not set — add it to run social-activity pulls (see docs/analysis/wave-6-audit-pipeline.md D7).',
      );
    }
    return key;
  }

  private resolveActorMap(): Record<string, string> {
    const raw = this.config.get<string>('APIFY_ACTORS');
    if (!raw) return DEFAULT_ACTORS;
    try {
      const overrides = JSON.parse(raw) as Record<string, string>;
      return { ...DEFAULT_ACTORS, ...overrides };
    } catch {
      this.logger.warn('APIFY_ACTORS is not valid JSON — ignoring it and using the built-in actor map.');
      return DEFAULT_ACTORS;
    }
  }

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  /** `POST /v2/actors/{actorId}/runs` then poll `/v2/actor-runs/{id}` to a terminal status. */
  private async runActor(key: string, actorId: string, input: Record<string, unknown>): Promise<ApifyRunSummary> {
    const encoded = encodeActorId(actorId);
    const createRes = await fetch(`${APIFY_BASE_URL}/actors/${encoded}/runs`, {
      method: 'POST',
      headers: this.headers(key),
      body: JSON.stringify(input),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`POST /v2/actors/${actorId}/runs returned HTTP ${createRes.status}: ${body.slice(0, 300)}`);
    }
    const created = (await createRes.json()) as { data: ApifyRunSummary };
    const runId = created.data.id;

    const started = Date.now();
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await this.sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(`${APIFY_BASE_URL}/actor-runs/${runId}`, { headers: this.headers(key) });
      if (!pollRes.ok) {
        throw new Error(`GET /v2/actor-runs/${runId} returned HTTP ${pollRes.status}`);
      }
      const polled = (await pollRes.json()) as { data: ApifyRunSummary };
      const status = polled.data.status;
      if (status === 'SUCCEEDED') return polled.data;
      if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        throw new Error(`Apify run ${runId} ended with status ${status}`);
      }
      // READY | RUNNING — keep polling
    }
    throw new Error(`Apify run ${runId} did not finish within ${POLL_TIMEOUT_MS}ms`);
  }

  /** `GET /v2/datasets/{id}/items` — the raw, actor-specific item array. */
  private async getDatasetItems(key: string, datasetId: string): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${APIFY_BASE_URL}/datasets/${datasetId}/items?clean=true`, {
      headers: this.headers(key),
    });
    if (!res.ok) {
      throw new Error(`GET /v2/datasets/${datasetId}/items returned HTTP ${res.status}`);
    }
    const items = (await res.json()) as unknown[];
    return items.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Apify's REST path wants `owner~name`, not `owner/name`. */
function encodeActorId(actorId: string): string {
  return actorId.replace(/\//g, '~');
}

function estimateCost(actorId: string, itemCount: number): number {
  const unit = ACTOR_UNIT_COST_USD[actorId];
  return unit ? unit * Math.max(itemCount, 1) : 0;
}

/**
 * Best-effort actor input, per D7's own caveat that per-actor schemas are
 * unverified. One function per actor family so a real confirmed run only
 * ever touches this branch.
 */
function buildInput(
  platform: ApifyPlatform,
  role: ActorRole,
  target: ApifyTarget,
  postsPerPlatform: number,
): Record<string, unknown> {
  const handle = target.handle ?? undefined;
  const url = target.url ?? undefined;

  switch (platform) {
    case 'linkedin':
      return role === 'profile'
        ? { companies: [url ?? handle] }
        : { profileUrls: [url ?? handle], postsLimit: postsPerPlatform };
    case 'instagram':
      return role === 'profile' ? { usernames: [handle ?? url] } : { username: [handle ?? url], resultsLimit: postsPerPlatform };
    case 'facebook':
      return role === 'profile'
        ? { startUrls: [{ url }] }
        : { startUrls: [{ url }], resultsLimit: postsPerPlatform };
    case 'twitter':
      return { handles: [handle], maxItems: postsPerPlatform };
    case 'youtube':
      return { startUrls: [{ url }] };
    case 'tiktok':
      return { profiles: [handle ?? url] };
  }
}

/**
 * Fold one actor's raw dataset item into the shared shape. Several candidate
 * field names are tried per metric; an absent one is `null`. D7 warns actor
 * schemas "differ wildly" — this is the boundary where that variance stops.
 */
function normalizeItem(
  platform: ApifyPlatform,
  role: ActorRole,
  actorId: string,
  raw: Record<string, unknown>,
): NormalizedSocialItem {
  const kind: 'profile' | 'post' = role === 'profile' ? 'profile' : 'post';
  return {
    platform,
    kind,
    postedAt: pickDate(raw, ['postedAt', 'timestamp', 'time', 'date', 'createdAt', 'publishedAt']),
    url: pickString(raw, ['url', 'postUrl', 'link', 'webVideoUrl']),
    caption: pickString(raw, ['caption', 'text', 'description', 'content']),
    likeCount: pickNumber(raw, ['likeCount', 'likesCount', 'likes', 'favoriteCount', 'diggCount']),
    commentCount: pickNumber(raw, ['commentCount', 'commentsCount', 'comments', 'replyCount']),
    shareCount: pickNumber(raw, ['shareCount', 'sharesCount', 'shares', 'retweetCount', 'repostCount']),
    viewCount: pickNumber(raw, ['viewCount', 'viewsCount', 'views', 'playCount']),
    followerCount: pickNumber(raw, ['followerCount', 'followersCount', 'followers', 'subscriberCount', 'employeeCount']),
    followingCount: pickNumber(raw, ['followingCount', 'followsCount', 'following']),
    postCount: pickNumber(raw, ['postCount', 'postsCount', 'mediaCount', 'videoCount']),
    actorId,
    raw: JSON.stringify(raw),
  };
}

function pickString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickNumber(item: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function pickDate(item: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Some actors report unix seconds, others milliseconds.
      const ms = v > 1e12 ? v : v * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

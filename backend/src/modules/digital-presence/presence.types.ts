/**
 * Digital Presence types — where the client exists on the internet.
 *
 * Two ideas run through this module and must not be conflated:
 *
 * - **State** ({@link PresenceState}) — what we know about the account.
 *   Deliberately three-valued. A profile linked from the client's own footer
 *   that we then fail to fetch is `unverified`, never `missing`: Instagram and
 *   Facebook serve login walls and LinkedIn answers datacentre IPs with `999`,
 *   so a failed check is the routine outcome for the platforms that matter most.
 * - **Source** ({@link PresenceSource}) — how we came to know it. Operator entry
 *   outranks both crawlers and survives every re-run.
 *
 * Analysis + approved decisions: `docs/analysis/digital-presence.md`.
 *
 * @module presence.types
 */

// ─── Platforms ────────────────────────────────────────────────────────────

/**
 * Platforms this module recognises from a URL. The split into social vs listing
 * is not cosmetic: the two answer different questions for a client ("are you
 * publishing?" vs "are you findable?") and are reported separately.
 */
export type PresencePlatform =
  // social
  | 'linkedin'
  | 'instagram'
  | 'facebook'
  | 'x'
  | 'youtube'
  | 'tiktok'
  | 'pinterest'
  | 'threads'
  // publishing
  | 'medium'
  | 'substack'
  | 'github'
  // listings, review and authority sites
  | 'crunchbase'
  | 'g2'
  | 'capterra'
  | 'trustpilot'
  | 'glassdoor'
  | 'yelp'
  | 'producthunt'
  | 'clutch'
  // marketplaces
  | 'app-store'
  | 'play-store'
  // personal identity hosts — a founder, not the company
  | 'scholar'
  | 'orcid'
  /**
   * A profile the client's own schema markup declares via `sameAs` that no
   * signature recognises — Google Scholar, ORCID, Wikipedia, a trade body, a
   * niche directory. The declaration *is* the authority here, so dropping it
   * for want of a regex would discard the highest-trust signal the site gives.
   */
  | 'other';

export const PRESENCE_PLATFORMS: readonly PresencePlatform[] = [
  'linkedin',
  'instagram',
  'facebook',
  'x',
  'youtube',
  'tiktok',
  'pinterest',
  'threads',
  'medium',
  'substack',
  'github',
  'crunchbase',
  'g2',
  'capterra',
  'trustpilot',
  'glassdoor',
  'yelp',
  'producthunt',
  'clutch',
  'app-store',
  'play-store',
  'scholar',
  'orcid',
  'other',
];

/**
 * The categories stage 2 of the delivery flow actually asks about — "External
 * Presence & Reputation" pairs each one with an *analyse* step:
 *
 * | Discover                       | Analyse                      |
 * |--------------------------------|------------------------------|
 * | Social Media Profiles          | Analyze Social Activity      |
 * | Industry / Business Directories| Analyze Directory Presence   |
 * | Business / Brand Profiles      | Analyze Profiles             |
 * | Relevant Marketplaces          | Analyze Marketplace Presence |
 * | Review Platforms               | Analyze Reviews              |
 *
 * `personal` is a sixth bucket that is deliberately **not** part of the company
 * footprint — see {@link PresenceEntity}.
 */
export type PresenceGroup =
  | 'social'
  | 'directory'
  | 'review'
  | 'marketplace'
  | 'publishing'
  | 'personal'
  | 'other';

export const PLATFORM_GROUP: Record<PresencePlatform, PresenceGroup> = {
  linkedin: 'social',
  instagram: 'social',
  facebook: 'social',
  x: 'social',
  youtube: 'social',
  tiktok: 'social',
  pinterest: 'social',
  threads: 'social',
  medium: 'publishing',
  substack: 'publishing',
  github: 'publishing',
  crunchbase: 'directory',
  clutch: 'directory',
  yelp: 'directory',
  g2: 'review',
  capterra: 'review',
  trustpilot: 'review',
  glassdoor: 'review',
  producthunt: 'marketplace',
  'app-store': 'marketplace',
  'play-store': 'marketplace',
  scholar: 'personal',
  orcid: 'personal',
  other: 'other',
};

export const GROUP_LABELS: Record<PresenceGroup, string> = {
  social: 'Social media profiles',
  directory: 'Industry & business directories',
  review: 'Review platforms',
  marketplace: 'Marketplaces & app stores',
  publishing: 'Publishing channels',
  personal: 'Personal profiles (not the company)',
  other: 'Other declared profiles',
};

/** How each platform is named in a report. */
export const PLATFORM_LABELS: Record<PresencePlatform, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X / Twitter',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  threads: 'Threads',
  medium: 'Medium',
  substack: 'Substack',
  github: 'GitHub',
  crunchbase: 'Crunchbase',
  g2: 'G2',
  capterra: 'Capterra',
  trustpilot: 'Trustpilot',
  glassdoor: 'Glassdoor',
  yelp: 'Yelp',
  producthunt: 'Product Hunt',
  clutch: 'Clutch',
  'app-store': 'Apple App Store',
  'play-store': 'Google Play',
  scholar: 'Google Scholar',
  orcid: 'ORCID',
  other: 'Declared profile',
};

/**
 * What kind of business this is, which is what decides where it *should* be
 * findable. Inferred from the client's category; a heuristic, and the assessment
 * says so rather than presenting it as fact.
 */
export type BusinessProfile = 'b2b-services' | 'b2b-saas' | 'local-services' | 'consumer-brand' | 'default';

/**
 * Where each kind of business is expected to exist.
 *
 * This is the list that decides what counts as a **gap**, so it has to be
 * opinionated per business type rather than universal. A B2B consultancy with no
 * TikTok is not a finding; one with no Clutch profile is. A local trade with no
 * G2 listing is not a finding; one with no Google/Yelp presence is. A single flat
 * list would generate noise for everyone and miss the category that matters to
 * each of them.
 *
 * Deliberately short. Every entry here produces a "missing" row a delivery lead
 * has to explain, so a platform earns its place by being one a *buyer of that
 * kind of business* would actually look at.
 */
export const EXPECTED_BY_PROFILE: Record<BusinessProfile, readonly PresencePlatform[]> = {
  // Consultancies, agencies, professional services: buyers check LinkedIn, then
  // third-party proof on the directories their peers review on.
  'b2b-services': ['linkedin', 'x', 'clutch', 'crunchbase', 'glassdoor'],
  // Software: the review platforms are the shortlist, so they are the gap.
  'b2b-saas': ['linkedin', 'x', 'g2', 'capterra', 'crunchbase', 'github'],
  // Anyone selling locally lives or dies on maps, reviews and Facebook.
  'local-services': ['facebook', 'instagram', 'yelp', 'trustpilot', 'linkedin'],
  // Consumer brands are judged on social reach and public reviews.
  'consumer-brand': ['instagram', 'facebook', 'tiktok', 'youtube', 'trustpilot'],
  // Nothing known about the business — the broad social set only, and the
  // assessment says the category was not identified.
  default: ['linkedin', 'instagram', 'facebook', 'x', 'youtube'],
};

/** Human label for the inferred profile, printed in the assessment. */
export const PROFILE_LABELS: Record<BusinessProfile, string> = {
  'b2b-services': 'B2B services / consultancy',
  'b2b-saas': 'B2B software',
  'local-services': 'Local services',
  'consumer-brand': 'Consumer brand',
  default: 'not identified',
};

/**
 * Guess the business type from the client's own category text.
 *
 * A heuristic over words the client used about themselves — never a claim. The
 * assessment prints which profile was applied so a wrong guess is visible and
 * arguable rather than silently shaping the gaps.
 */
export function inferBusinessProfile(category: string | null | undefined): BusinessProfile {
  const c = (category ?? '').toLowerCase();
  if (!c.trim()) return 'default';
  if (/\b(saas|software|platform|app|api|tool|tech company|product)\b/.test(c)) return 'b2b-saas';
  if (/\b(plumb|electric|roof|dentist|clinic|salon|restaurant|cafe|garage|landscap|builder|contractor|local)\b/.test(c)) {
    return 'local-services';
  }
  if (/\b(retail|ecommerce|e-commerce|dtc|d2c|shop|store|brand|fashion|beauty|food|drink)\b/.test(c)) {
    return 'consumer-brand';
  }
  if (/\b(agency|consult|advisor|partner|services|marketing|studio|firm|b2b)\b/.test(c)) return 'b2b-services';
  return 'default';
}

/** Back-compat default set. Prefer {@link EXPECTED_BY_PROFILE} keyed on the client. */
export const EXPECTED_PLATFORMS: readonly PresencePlatform[] = EXPECTED_BY_PROFILE.default;

/**
 * Whose profile this is.
 *
 * The audit is about **the company**. A founder's personal LinkedIn, their
 * Google Scholar page or their ORCID record are real, and worth recording — but
 * they are not the company's digital footprint, and counting them as such
 * inflates the picture and answers a question nobody asked.
 *
 * `unknown` exists because a handle alone often cannot tell you: an Instagram
 * account could be the brand or the founder. It is reported as company presence
 * (that is the likelier reading for a brand-named handle) but kept flaggable.
 */
export type PresenceEntity = 'company' | 'personal' | 'unknown';

// ─── Account state and provenance ─────────────────────────────────────────

/**
 * `confirmed` — found and the URL resolved.
 * `unverified` — found on the client's own site, but the platform refused the
 *   check. Honest and common; not a problem to fix.
 * `missing` — no link anywhere on the site and nothing supplied by hand.
 * `candidate` — found by **search**, not by the client's own site. We do not
 *   know it is theirs. A real query for `site:instagram.com "HubSpot"` returns
 *   `/hubspot` and `/hubspotacademy` (both theirs) alongside
 *   `/hubshotspodcast` (a different company entirely) — indistinguishable
 *   without a human. Candidates never count as accounts and never reach a
 *   client report until an operator confirms one.
 */
export type PresenceState = 'confirmed' | 'unverified' | 'missing' | 'candidate';

/** Where the account came from. `manual` always wins. */
export type PresenceSource = 'json-ld-sameas' | 'page-link' | 'manual' | 'serp';

export const SOURCE_LABELS: Record<PresenceSource, string> = {
  'json-ld-sameas': 'Declared in schema markup',
  'page-link': 'Linked from the site',
  manual: 'Entered by operator',
  serp: 'Suggested by Google search',
};

/** One account, as returned to callers. */
export interface PresenceAccountDto {
  id: string;
  platform: PresencePlatform;
  label: string;
  group: PresenceGroup;
  url: string;
  handle: string | null;
  source: PresenceSource;
  sourceLabel: string;
  /** Company or a person. Personal rows are excluded from the company counts. */
  entity: PresenceEntity;
  state: PresenceState;
  /** Verbatim reason the check could not be completed. Only when `unverified`. */
  reason: string | null;
  statusCode: number | null;
  title: string | null;
  foundOn: string | null;
  verifiedAt: string | null;
  /**
   * Does this platform's page actually name the client? `match` / `mismatch` /
   * `not-checked`, decided by `entity-audit`'s shared rules so the two modules
   * cannot drift apart on what a name match is.
   *
   * `not-checked` is the honest and common answer: we only have a title for
   * profiles a platform let us fetch, which excludes every walled one.
   */
  nameConsistency: 'match' | 'mismatch' | 'not-checked';
  /**
   * 0-1 name-similarity hint for `candidate` rows only. A ranking aid for the
   * operator's eye, never a threshold the code acts on -- a high score on the
   * wrong company is still the wrong company.
   */
  confidence: number | null;
}

/** A platform we expected and did not find — the thing the operator can fix. */
export interface PresenceGap {
  platform: PresencePlatform;
  label: string;
  group: PresenceGroup;
}

// ─── Discovery run ────────────────────────────────────────────────────────

export type DiscoveryStatus = 'pending' | 'crawling' | 'verifying' | 'completed' | 'failed';

export interface DiscoveryRunDto {
  id: string;
  status: DiscoveryStatus;
  pagesFetched: number;
  found: number;
  confirmed: number;
  unverified: number;
  /** Search suggestions raised this run, awaiting confirmation. */
  candidates: number;
  /** Billable DataForSEO queries. Cache hits are excluded; zero when the phase skipped. */
  serpQueries: number;
  /** Real DataForSEO charge for this run, from the response envelope. */
  serpCostUsd: number;
  /** Why the SERP phase did not run, when it did not. */
  serpSkipped: string | null;
  /** How many accounts each source contributed. */
  sources: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ─── The inventory ────────────────────────────────────────────────────────

/**
 * One line of the wider footprint — everything the other modules discovered.
 *
 * `state` here answers a different question from {@link PresenceState}:
 * `not-checked` is not a failure and not an absence, it means no module has
 * looked yet. Rendering it as "none" would report an unasked question as a
 * negative answer.
 */
export type FootprintState = 'found' | 'none' | 'not-checked';

export interface FootprintItem {
  label: string;
  state: FootprintState;
  /** The finding itself — a count, a name, a list. Never a score. */
  detail: string | null;
  /** Module that produced it, so a number can always be traced home. */
  source: string;
}

export interface FootprintSection {
  key: 'identity' | 'owned' | 'connected' | 'answer-engines' | 'competitors';
  label: string;
  items: FootprintItem[];
}

// ─── Assessment (the "analyse" half of stage 2) ───────────────────────────

/**
 * How well one stage-2 category is covered.
 *
 * `not-checked` is a first-class value here for the same reason it is in the
 * footprint: a category nobody has searched is not a category with nothing in it.
 */
export type CoverageState = 'covered' | 'partial' | 'absent' | 'not-checked';

export interface CategoryCoverage {
  group: PresenceGroup;
  label: string;
  state: CoverageState;
  /** Company profiles held in this category. */
  held: number;
  /** Platforms expected for this client and not found. */
  missing: string[];
  /** What the state means for this client, in plain language. */
  note: string;
}

/**
 * Why one capability isn't reflected in the numbers above, three-valued the
 * same way {@link PresenceState} is — collapsing these into one boolean would
 * hide exactly the distinction an operator needs:
 *
 * - `not-built`   — the module has no code for this yet.
 * - `not-configured` — built, but the credentials/vendor this needs are not
 *   set in this environment (e.g. `DATAFORSEO_LOGIN`/`_PASSWORD`).
 * - `not-run`     — built and configured, but nobody has pulled it for this
 *   project yet. Different from `not-configured`: an operator fixes this with
 *   a POST, not with an env var.
 */
export type CapabilityState = 'not-built' | 'not-configured' | 'not-run';

export interface CapabilityNote {
  label: string;
  state: CapabilityState;
  note: string;
}

/**
 * The analysis of the company's current presence on the internet.
 *
 * Facts and absences only. Every number here is counted, never estimated, and
 * anything unmeasured is named in {@link PresenceAssessment.notMeasured} rather
 * than quietly omitted — an audit that lists six findings and hides that it never
 * looked at reviews is worse than one that lists five and says so.
 */
export interface PresenceAssessment {
  /** Business type the expected set was derived from — a heuristic, stated. */
  businessProfile: BusinessProfile;
  businessProfileLabel: string;
  /** The category text the guess was made from, so it can be argued with. */
  inferredFrom: string | null;
  /** Plain-language read, worst-first. No adjectives, no scores. */
  headlines: string[];
  coverage: CategoryCoverage[];
  /**
   * Capabilities this module cannot yet reflect in the numbers above, each
   * naming exactly why — see {@link CapabilityState}. An item is removed from
   * this list entirely once it is built, configured AND has run for this
   * project; it is never silently dropped just because the module now has
   * code for it.
   */
  notMeasured: CapabilityNote[];
}

// ─── External presence — DataForSEO Business Data (wave-6 D2) ────────────

/** One Google Business Profile snapshot, as returned to callers. */
export interface BusinessProfileDto {
  id: string;
  source: string;
  name: string | null;
  categories: string[];
  /** Parsed from the stored JSON; shape is the provider's own, unreshaped. */
  hours: unknown | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  fetchedAt: string;
}

/** One review-platform snapshot. Rating + count only — see wave-6 D2. */
export interface ReviewDto {
  id: string;
  platform: string;
  rating: number | null;
  reviewCount: number | null;
  url: string | null;
  /** dataforseo (google/trustpilot/yelp, paid) | schema-scrape (any other ratable platform, free). */
  source: string;
  fetchedAt: string;
}

// ─── External presence — Apify social activity (wave-6 D7) ───────────────

export interface SocialPostDto {
  id: string;
  platform: string;
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
  fetchedAt: string;
}

/** Result of one `POST /presence/social-activity` run. */
export interface SocialActivityRunDto {
  requested: string[];
  skipped: Array<{ platform: string; reason: string }>;
  pulled: SocialPostDto[];
  totalCostUsd: number;
  errors: Array<{ platform: string; role: string; error: string }>;
}

/** Per-platform read on posting cadence + reach, derived from stored `PresencePost` rows. */
export interface SocialActivitySummary {
  platform: string;
  followerCount: number | null;
  /** Posts pulled in the most recent run — a sample size, not a true 30-day count. */
  postsSampled: number;
  lastPostAt: string | null;
  /** Mean of (likes + comments + shares) across sampled posts. Null with no posts. */
  avgEngagement: number | null;
}

/** Everything the console shows for one project. */
export interface PresenceInventory {
  projectId: string;
  domain: string;
  /** Accounts, newest discovery first, operator entries included. */
  accounts: PresenceAccountDto[];
  counts: {
    /** Company profiles only. Personal profiles are NOT included. */
    total: number;
    confirmed: number;
    unverified: number;
    social: number;
    /** Directory + review + marketplace — the non-social company footprint. */
    listing: number;
    manual: number;
    /** Search suggestions awaiting a yes/no. Never counted as accounts. */
    candidates: number;
    /** A founder's own profiles. Reported separately, never as company reach. */
    personal: number;
  };
  /** Expected platforms with no account — what the operator is asked to supply. */
  gaps: PresenceGap[];
  /** The rest of the digital footprint, from the modules that own each fact. */
  footprint: FootprintSection[];
  /** Stage 2's *analyse* column — the read on the company's current state. */
  assessment: PresenceAssessment;
  /** Newest discovery run, or null when none has been run. */
  lastRun: DiscoveryRunDto | null;
  /**
   * Latest DataForSEO Business Data pull (wave-6 D2), or `null` when it has
   * never been pulled for this project — never a fabricated empty profile.
   */
  businessProfile: BusinessProfileDto | null;
  /** Latest review-platform snapshots, one per platform pulled so far. */
  reviews: ReviewDto[];
  /** Per-platform posting cadence + reach from the Apify enrichment (wave-6 D7). */
  socialActivity: SocialActivitySummary[];
  /**
   * P05 §11.2 — the applicability policy result for every recognised platform.
   * The SAME array `gaps`/`assessment`/the collector all read; exposed here so
   * the UI can render "Not relevant" (settings/details only, per §11.1) and
   * explain a recommendation without recomputing the policy client-side.
   */
  applicability: PlatformApplicabilityDto[];
}

/** Re-exported shape of `presence.applicability.service`'s `PlatformApplicability`,
 *  declared locally to avoid a types-file → service-file import. */
export interface PlatformApplicabilityDto {
  platform: PresencePlatform;
  label: string;
  status: 'relevant' | 'optional' | 'not-relevant' | 'needs-confirmation';
  reason: string;
  ruleVersion: string;
  overridden: boolean;
}

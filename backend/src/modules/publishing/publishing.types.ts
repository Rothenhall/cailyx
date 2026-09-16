/**
 * Provider declarations, status vocabularies and view shapes for G11
 * (CMS/channel publishing, remote verification).
 *
 * The provider table is the load-bearing part of this file. It is the answer to
 * "one connect button must never bundle unknown permissions across providers":
 * a destination is created for **one** declared provider, its `permissions`
 * must be a subset of that provider's own declared scopes, and the kinds are
 * disjoint — a CMS credential never authorizes a social post.
 *
 * `implemented: false` is not decoration. Only `custom-webhook` has an adapter
 * in this build; every other provider is declared so the UI can offer it,
 * refuse it honestly, and say what is missing. Inventing a WordPress
 * integration that has never been run against a WordPress site is exactly the
 * failure this flag exists to prevent.
 *
 * @module publishing.types
 */

// ── Vocabularies (mirror the schema comments) ─────────────────────────────

/** `PublishDestination.provider`. */
export const PUBLISH_PROVIDERS = [
  'custom-webhook',
  'wordpress',
  'webflow',
  'ghost',
  'contentful',
  'linkedin',
  'x',
] as const;
export type PublishProvider = (typeof PUBLISH_PROVIDERS)[number];

/** `PublishDestination.status`. */
export const DESTINATION_STATUSES = ['unconfigured', 'connected', 'error', 'revoked'] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

/** `Publication.status`. */
export const PUBLICATION_STATUSES = ['pending', 'publishing', 'published', 'failed', 'cancelled'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** `Publication.mode`. */
export const PUBLICATION_MODES = ['draft', 'publish'] as const;
export type PublicationMode = (typeof PUBLICATION_MODES)[number];

/**
 * A `credentialRef` is a **name**, never a secret: it points at an entry in the
 * secret store (today, an environment variable — see `lib/credentials.util`).
 * The shape is enforced because it is the one place a mistake would persist a
 * credential on the destination row: a provider key, a JWT or a base64 blob can
 * never match a short lowercase slug.
 */
export const CREDENTIAL_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Config keys this service writes itself. A caller supplying one is rejected
 * rather than merged: `grantedPermissions` is the record of what was actually
 * authorized, and it must not be settable by the request that asks for it.
 */
export const RESERVED_CONFIG_KEYS = ['grantedPermissions'] as const;

/**
 * Config keys that must never be accepted, at any depth.
 *
 * `PublishDestination.config` holds non-secret settings only — credentials live
 * behind `credentialRef`. A caller that puts `apiKey` or `signingSecret` in the
 * config is one bug away from a leaked credential in a database backup and in
 * every API response that returns the destination, so this is refused at the
 * door rather than trimmed silently.
 */
export const SECRET_CONFIG_KEY_RE =
  /(secret|token|password|passwd|credential|bearer|authorization|api[-_]?key|private[-_]?key|signing[-_]?key|client[-_]?secret|access[-_]?key)/i;

// ── Provider declarations ─────────────────────────────────────────────────

export type ProviderKind = 'cms' | 'social' | 'email' | 'ads' | 'webhook';

export interface ProviderDeclaration {
  provider: PublishProvider;
  label: string;
  kind: ProviderKind;
  /** True only when an adapter exists in this build and has been exercised. */
  implemented: boolean;
  /** Non-secret config keys the destination must carry to be usable. */
  requiredConfig: string[];
  /** Non-secret config keys the adapter understands but does not require. */
  optionalConfig: string[];
  /**
   * The scopes this provider can be authorized for. A destination's requested
   * `permissions` must be a subset — never a superset, and never another
   * provider's scopes.
   */
  permissions: string[];
  /** Why it is unavailable, and what would have to land first. Null when implemented. */
  unavailableReason: string | null;
}

/** One scope: write content to the destination. The webhook provider's only one. */
const CONTENT_WRITE = 'content:write';

export const PROVIDER_DECLARATIONS: readonly ProviderDeclaration[] = [
  {
    provider: 'custom-webhook',
    label: 'Custom webhook (HTTPS endpoint)',
    kind: 'webhook',
    implemented: true,
    requiredConfig: ['endpoint'],
    optionalConfig: ['channels', 'verifyMarker', 'requiresAuth'],
    permissions: [CONTENT_WRITE],
    unavailableReason: null,
  },
  {
    provider: 'wordpress',
    label: 'WordPress',
    kind: 'cms',
    implemented: false,
    requiredConfig: ['siteUrl'],
    optionalConfig: ['defaultCategory'],
    permissions: ['posts:write', 'media:write'],
    unavailableReason:
      'No WordPress adapter exists in this build. WordPress needs per-site application passwords plus the REST API base and editorial-status handling, and none of it has been exercised against a real site. Publishing to WordPress today is a human action: publish it, then record the URL here.',
  },
  {
    provider: 'webflow',
    label: 'Webflow',
    kind: 'cms',
    implemented: false,
    requiredConfig: ['siteId', 'collectionId'],
    optionalConfig: [],
    permissions: ['cms:write'],
    unavailableReason:
      'No Webflow adapter exists in this build. Webflow needs a site-scoped API token, a CMS collection id, and field-mapping per collection — a mapping that cannot be guessed and has not been verified against a real collection.',
  },
  {
    provider: 'ghost',
    label: 'Ghost',
    kind: 'cms',
    implemented: false,
    requiredConfig: ['adminUrl'],
    optionalConfig: [],
    permissions: ['posts:write'],
    unavailableReason: 'No Ghost adapter exists in this build (Admin API key + signed JWT per request, unexercised).',
  },
  {
    provider: 'contentful',
    label: 'Contentful',
    kind: 'cms',
    implemented: false,
    requiredConfig: ['spaceId', 'environmentId', 'contentTypeId'],
    optionalConfig: [],
    permissions: ['entries:write'],
    unavailableReason: 'No Contentful adapter exists in this build (CMA token + content-type field mapping, unexercised).',
  },
  {
    provider: 'linkedin',
    label: 'LinkedIn',
    kind: 'social',
    implemented: false,
    requiredConfig: ['organizationUrn'],
    optionalConfig: [],
    permissions: ['w_organization_social'],
    unavailableReason:
      'No LinkedIn adapter exists in this build. It needs an approved developer app and an organisation-scoped OAuth grant; requesting the scope without the app in place would fail at consent, not at publish, so it is not offered as a working connection.',
  },
  {
    provider: 'x',
    label: 'X',
    kind: 'social',
    implemented: false,
    requiredConfig: [],
    optionalConfig: [],
    permissions: ['tweet.write'],
    unavailableReason:
      'No X adapter exists in this build, and the vendor API tier required to post on a client\'s behalf is a commercial decision, not an implementation detail.',
  },
];

/** Look up one declaration, or null when the provider is not declared at all. */
export function findProvider(provider: string): ProviderDeclaration | null {
  return PROVIDER_DECLARATIONS.find((declaration) => declaration.provider === provider) ?? null;
}

// ── Views ─────────────────────────────────────────────────────────────────

/** A destination as returned over HTTP. Never includes a credential value. */
export interface PublishDestinationView {
  id: string;
  projectId: string;
  provider: string;
  providerLabel: string;
  providerKind: ProviderKind;
  /** Whether an adapter for this provider exists in this build. */
  providerImplemented: boolean;
  label: string;
  resourceId: string | null;
  resourceLabel: string | null;
  /** Non-secret settings only — the service refuses anything secret-shaped. */
  config: Record<string, unknown>;
  /** The **name** of the secret-store entry. Never the secret. */
  credentialRef: string | null;
  /** Whether that entry currently resolves in this process. Derived. */
  credentialConfigured: boolean;
  /** Scopes this destination was authorized for (a subset of the provider's own). */
  grantedPermissions: string[];
  status: string;
  lastTestedAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A publication as returned over HTTP. */
export interface PublicationView {
  id: string;
  projectId: string;
  destinationId: string;
  assetId: string;
  revisionId: string;
  /** The approval that authorized this specific push. Null only for legacy rows. */
  approvalId: string | null;
  mode: string;
  scheduledFor: string | null;
  /** The remote write: `publishing` -> `published` | `failed`. */
  status: string;
  remoteId: string | null;
  remoteUrl: string | null;
  /**
   * Remote verification — a **separate outcome** from `status`. A publication
   * can be `published` with `verifyState: 'unverified'`: the push succeeded and
   * the follow-up fetch could not confirm the content is live.
   *
   * These three fields describe the **latest** verification attempt: a failed
   * attempt clears them rather than leaving a stale `verifiedAt` in place. Each
   * attempt is also written as a `CheckResult` evidence row, so the history of
   * what was verified when is not lost, only superseded.
   */
  verifiedAt: string | null;
  verifiedUrl: string | null;
  verifyError: string | null;
  verifyState: 'not-attempted' | 'verified' | 'unverified';
  error: string | null;
  attempt: number;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
  destination: {
    id: string;
    provider: string;
    label: string;
    resourceId: string | null;
    resourceLabel: string | null;
    status: string;
  };
  revision: {
    id: string;
    revision: number;
    title: string | null;
    contentHash: string | null;
  } | null;
  /** Why nothing will happen next, when nothing will. Derived, never stored. */
  blockedReason: string | null;
  /** True when the row has been `publishing` for longer than the stale window. */
  stale: boolean;
  actions: {
    canDispatch: boolean;
    canVerify: boolean;
    canRetry: boolean;
    canCancel: boolean;
  };
}

/** One selectable remote resource (a site, a blog, a channel, an endpoint). */
export interface ProviderResource {
  id: string;
  label: string;
  /** Optional non-secret detail shown in the picker. */
  detail?: string;
}

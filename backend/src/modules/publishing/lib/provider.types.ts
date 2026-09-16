/**
 * The adapter contract every publishing provider implements.
 *
 * A provider is integrated by writing one object with these methods; the state
 * machine, the approval gate, the retry semantics and the verification split
 * live in `PublishingService` and are shared by all of them. That is the point:
 * "publishing and verifying are different outcomes" is enforced by the caller,
 * so an adapter cannot collapse them, and "no remote write without an approved
 * action" is enforced before an adapter is ever reached.
 *
 * **No adapter may throw.** A provider that is down, unconfigured, rate-limited
 * or returning nonsense is a state to record, not an exception to propagate —
 * so every method returns an {@link AdapterResult} and the caller decides what
 * that means for the publication row.
 *
 * Only `custom-webhook` implements this in the current build. The other
 * declared providers (`publishing.types.ts`) are listed with
 * `implemented: false` and an explicit reason, because an adapter that has never
 * been run against a real WordPress site is not an integration.
 *
 * @module publishing/lib/provider.types
 */

import type { ProviderResource } from '../publishing.types';

/** The destination row an adapter acts for. Credentials are passed separately. */
export interface AdapterDestination {
  id: string;
  projectId: string;
  provider: string;
  label: string;
  resourceId: string | null;
  resourceLabel: string | null;
  /** Non-secret settings only — enforced on write by `PublishingService`. */
  config: Record<string, unknown>;
}

export interface AdapterContext {
  destination: AdapterDestination;
  /**
   * The resolved credential, or null when the reference does not resolve.
   * Never logged, never returned in a view.
   */
  secret: string | null;
  projectId: string;
}

/** What the adapter is asked to write. Assembled from the approved revision. */
export interface PublishPayload {
  projectId: string;
  publicationId: string;
  mode: string;
  assetId: string;
  assetType: string;
  revisionId: string;
  revision: number;
  title: string | null;
  body: string | null;
  fields: Record<string, unknown>;
  /** The revision's content hash — the strongest "is this the content we sent" marker. */
  contentHash: string | null;
}

export type AdapterResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** Operator-facing reason. Never contains the credential or the payload. */
      reason: string;
      /** The remote HTTP status, when the failure came from one. */
      httpStatus?: number;
    };

export interface AdapterTestResult {
  detail: string;
  /** The remote resource the test reached, when the provider reports one. */
  resourceLabel?: string | null;
}

export interface AdapterResourceResult {
  resources: ProviderResource[];
}

export interface AdapterPushResult {
  /** The id the remote system assigned. This is the retry key. */
  remoteId: string;
  /** Where the remote copy lives. Needed for the follow-up verification. */
  remoteUrl: string;
  /** A short, non-secret description of what came back (status, id). */
  responseSummary: string;
}

export interface AdapterVerifyResult {
  /** The URL that was actually fetched. */
  url: string;
  httpStatus: number;
  /**
   * Which marker confirmed the content, when one did.
   * `content-hash` is conclusive; `title` is a weak signal and says so.
   */
  markerMatched: 'content-hash' | 'title' | null;
  detail: string;
}

/** What an adapter must implement. See the module doc for the rules. */
export interface PublisherAdapter {
  readonly provider: string;
  /**
   * Can this destination be used right now? Checked before every push and by
   * the test action, so a missing credential is reported the same way wherever
   * it is noticed.
   */
  readiness(ctx: AdapterContext): { ready: boolean; reason: string | null };
  /** Reach the provider and confirm the destination is usable. */
  test(ctx: AdapterContext): Promise<AdapterResult<AdapterTestResult>>;
  /** The remote targets a destination may publish to. */
  listResources(ctx: AdapterContext): Promise<AdapterResult<AdapterResourceResult>>;
  /** Perform the remote write. Called exactly once per attempt. */
  push(ctx: AdapterContext, payload: PublishPayload): Promise<AdapterResult<AdapterPushResult>>;
  /** Confirm the pushed content is actually live. Never mutates the remote. */
  verify(
    ctx: AdapterContext,
    target: { remoteUrl: string; mode: string; contentHash: string | null; title: string | null },
  ): Promise<AdapterResult<AdapterVerifyResult>>;
}

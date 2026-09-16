/**
 * The `custom-webhook` adapter — the one provider integration that genuinely
 * works end to end in this build, and the reference implementation of
 * {@link PublisherAdapter}.
 *
 * ## The contract a receiver implements
 *
 * **Push** — we send `POST <config.endpoint>` with
 *
 * ```json
 * {
 *   "cailyx": { "version": 1, "event": "publication", "publicationId": "…",
 *               "projectId": "…", "mode": "draft", "contentHash": "…" },
 *   "content": { "assetId": "…", "assetType": "article", "revisionId": "…",
 *                "revision": 3, "title": "…", "body": "…", "fields": { } }
 * }
 * ```
 *
 * signed with `X-Cailyx-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over
 * `<t>.<raw body>` — the same scheme this platform verifies on its own inbound
 * webhook, so a receiver can reuse the check it already has. The receiver must
 * answer `2xx` with `{"id": "…", "url": "https://…"}`; `id` becomes the
 * `remoteId` retries key on, and `url` is what verification fetches.
 *
 * **Verify** — we `GET` that `url` and require a `2xx` whose body contains the
 * revision's `contentHash` (conclusive) or, failing that, its title (a weak
 * signal, recorded as such). A receiver that echoes the hash into the page — a
 * `<meta name="cailyx-content-hash">` is enough — gets definitive verification;
 * one that does not still gets a real answer, just a weaker one.
 *
 * **Test** — the same POST with `"event": "test"` and no content.
 *
 * ## What is deliberately not flexible
 *
 * The endpoint must be `https`. Plain `http` to a public host would put a
 * client's draft content on the wire in clear text, and there is no `localhost`
 * exception because the platform's outbound client refuses loopback and private
 * addresses outright — an http endpoint could never work, so offering the
 * setting would be a trap.
 *
 * @module publishing/lib/custom-webhook.adapter
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { FetcherService } from '../../fetcher/fetcher.service';
import type {
  AdapterContext,
  AdapterPushResult,
  AdapterResourceResult,
  AdapterResult,
  AdapterTestResult,
  AdapterVerifyResult,
  PublishPayload,
  PublisherAdapter,
} from './provider.types';
import type { ProviderResource } from '../publishing.types';

/** Config keys this adapter reads. Anything else in config is ignored. */
interface WebhookConfig {
  endpoint: string;
  channels?: Array<{ id: string; label?: string }>;
  verifyMarker?: string;
  requiresAuth?: boolean;
}

@Injectable()
export class CustomWebhookAdapter implements PublisherAdapter {
  readonly provider = 'custom-webhook';
  private readonly logger = new Logger(CustomWebhookAdapter.name);

  constructor(private readonly fetcher: FetcherService) {}

  // ── config ──────────────────────────────────────────────────────────

  private config(ctx: AdapterContext): WebhookConfig | null {
    const raw = ctx.destination.config;
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : null;
    if (!endpoint) return null;

    const channels = Array.isArray(raw.channels)
      ? raw.channels.filter(
          (entry): entry is { id: string; label?: string } =>
            typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string',
        )
      : undefined;

    return {
      endpoint,
      channels,
      verifyMarker: typeof raw.verifyMarker === 'string' ? raw.verifyMarker : undefined,
      requiresAuth: raw.requiresAuth !== false,
    };
  }

  /**
   * The endpoint must be an absolute `https` URL. There is no plain-`http`
   * exception — not even for `localhost`, because the platform's outbound
   * client (`FetcherService`) refuses loopback and private addresses outright,
   * so an http endpoint could never work anyway; offering it would be a setting
   * that silently fails. Applied to the configured endpoint *and* to the URL a
   * receiver hands back for verification, which is the same kind of
   * attacker-influenced input.
   */
  private endpointProblem(endpoint: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return 'config.endpoint is not an absolute URL';
    }
    if (parsed.protocol === 'https:') return null;
    if (parsed.protocol === 'http:') {
      return 'config.endpoint must use https — plain http would send a client\'s content in clear text';
    }
    return `config.endpoint must be an https URL, not ${parsed.protocol}`;
  }

  readiness(ctx: AdapterContext): { ready: boolean; reason: string | null } {
    const config = this.config(ctx);
    if (!config) return { ready: false, reason: 'config.endpoint is not set on this destination' };

    const problem = this.endpointProblem(config.endpoint);
    if (problem) return { ready: false, reason: problem };

    if (config.requiresAuth !== false && !ctx.secret) {
      return {
        ready: false,
        reason:
          'no signing credential resolves for this destination — set the credential reference and the environment variable it names before publishing',
      };
    }
    return { ready: true, reason: null };
  }

  // ── actions ─────────────────────────────────────────────────────────

  /** POST a signed test event; `2xx` means the endpoint is reachable and accepting. */
  async test(ctx: AdapterContext): Promise<AdapterResult<AdapterTestResult>> {
    const ready = this.readiness(ctx);
    if (!ready.ready) return { ok: false, reason: ready.reason ?? 'destination is not ready' };
    const config = this.config(ctx);
    if (!config) return { ok: false, reason: 'config.endpoint is not set on this destination' };

    const body = JSON.stringify({
      cailyx: {
        version: 1,
        event: 'test',
        projectId: ctx.projectId,
        destinationId: ctx.destination.id,
        at: new Date().toISOString(),
      },
    });

    try {
      const response = await this.fetcher.fetch(
        {
          url: config.endpoint,
          method: 'POST',
          headers: this.headers(body, ctx.secret, { event: 'test' }),
          body,
          // A remote write must never be answered from a cache.
          bypassCache: true,
          cacheTtlSeconds: 0,
        },
        'publishing:test',
      );

      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          httpStatus: response.status,
          reason: `the endpoint answered ${response.status} ${response.statusText || ''}`.trim(),
        };
      }
      return {
        ok: true,
        data: { detail: `Endpoint reached and answered ${response.status}. Signed test event accepted.`, resourceLabel: null },
      };
    } catch (err) {
      return { ok: false, reason: `the endpoint could not be reached: ${this.messageOf(err)}` };
    }
  }

  /**
   * The selectable targets for this destination.
   *
   * A receiver that declares `config.channels` gets a picker; one that does not
   * gets a single implicit target, because a webhook has exactly one endpoint
   * and pretending otherwise would be a fake list.
   */
  async listResources(ctx: AdapterContext): Promise<AdapterResult<AdapterResourceResult>> {
    const config = this.config(ctx);
    if (!config) return { ok: false, reason: 'config.endpoint is not set on this destination' };

    if (config.channels && config.channels.length > 0) {
      const resources: ProviderResource[] = config.channels.map((channel) => ({
        id: channel.id,
        label: channel.label ?? channel.id,
        detail: 'channel declared by the receiver',
      }));
      return { ok: true, data: { resources } };
    }

    let host = config.endpoint;
    try {
      host = new URL(config.endpoint).host;
    } catch {
      /* the endpoint check in readiness() already reported this */
    }
    return {
      ok: true,
      data: {
        resources: [
          {
            id: 'default',
            label: host,
            detail: 'the endpoint itself — this receiver declares no channels',
          },
        ],
      },
    };
  }

  /** POST the content. The response's `id` is what makes retries safe. */
  async push(ctx: AdapterContext, payload: PublishPayload): Promise<AdapterResult<AdapterPushResult>> {
    const ready = this.readiness(ctx);
    if (!ready.ready) return { ok: false, reason: ready.reason ?? 'destination is not ready' };
    const config = this.config(ctx);
    if (!config) return { ok: false, reason: 'config.endpoint is not set on this destination' };

    const body = JSON.stringify({
      cailyx: {
        version: 1,
        event: 'publication',
        publicationId: payload.publicationId,
        projectId: payload.projectId,
        mode: payload.mode,
        contentHash: payload.contentHash,
        resourceId: ctx.destination.resourceId,
      },
      content: {
        assetId: payload.assetId,
        assetType: payload.assetType,
        revisionId: payload.revisionId,
        revision: payload.revision,
        title: payload.title,
        body: payload.body,
        fields: payload.fields,
      },
    });

    try {
      const response = await this.fetcher.fetch(
        {
          url: config.endpoint,
          method: 'POST',
          headers: this.headers(body, ctx.secret, { event: 'publication' }),
          body,
          bypassCache: true,
          cacheTtlSeconds: 0,
        },
        'publishing:push',
      );

      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          httpStatus: response.status,
          reason: `the endpoint answered ${response.status} ${response.statusText || ''}`.trim(),
        };
      }

      const parsed = this.parseJson(response.body);
      const remoteId = typeof parsed?.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : null;
      const remoteUrl = typeof parsed?.url === 'string' && parsed.url.trim() !== '' ? parsed.url.trim() : null;

      if (!remoteId) {
        return {
          ok: false,
          httpStatus: response.status,
          reason:
            'the endpoint accepted the content but did not return an `id`, so a retry could not be de-duplicated. The remote may hold a copy — check before retrying.',
        };
      }
      if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
        return {
          ok: false,
          httpStatus: response.status,
          reason:
            'the endpoint did not return a usable absolute `url`, so the content cannot be verified. The write may have succeeded — check the remote before retrying.',
        };
      }

      return {
        ok: true,
        data: {
          remoteId,
          remoteUrl,
          responseSummary: `HTTP ${response.status}, remote id ${remoteId}`,
        },
      };
    } catch (err) {
      return { ok: false, reason: `the endpoint could not be reached: ${this.messageOf(err)}` };
    }
  }

  /**
   * Fetch the remote URL and look for the marker.
   *
   * A `2xx` alone is not verification: an error page rendered with a 200 would
   * otherwise pass. The marker is what makes this a check rather than a
   * ping — see the module doc for the two markers and their relative strength.
   */
  async verify(
    ctx: AdapterContext,
    target: { remoteUrl: string; mode: string; contentHash: string | null; title: string | null },
  ): Promise<AdapterResult<AdapterVerifyResult>> {
    const config = this.config(ctx);

    // The URL to fetch comes from the *receiver's* response, so it is
    // attacker-influenced input on a server-side fetch. Only http(s) to a
    // public host, or plain http on localhost for a local receiver, is
    // followed — otherwise a receiver could point this at an internal address.
    const problem = this.endpointProblem(target.remoteUrl);
    if (problem) {
      return { ok: false, reason: `refusing to verify ${target.remoteUrl}: ${problem}` };
    }

    try {
      const response = await this.fetcher.fetch(
        {
          url: target.remoteUrl,
          method: 'GET',
          // Verification must observe the remote now, not a cached copy from
          // an earlier check of the same URL.
          bypassCache: true,
          cacheTtlSeconds: 0,
        },
        'publishing:verify',
      );

      if (response.status < 200 || response.status >= 300) {
        const draftNote =
          target.mode === 'draft'
            ? ' (expected for a draft: a draft URL is usually not publicly readable, which is why mode and verification are reported separately)'
            : '';
        return {
          ok: false,
          httpStatus: response.status,
          reason: `fetching ${target.remoteUrl} returned ${response.status}${draftNote}`,
        };
      }

      const body = response.body ?? '';
      if (target.contentHash && body.includes(target.contentHash)) {
        return {
          ok: true,
          data: {
            url: response.finalUrl || target.remoteUrl,
            httpStatus: response.status,
            markerMatched: 'content-hash',
            detail: `Content hash found in the live page (HTTP ${response.status}).`,
          },
        };
      }

      const override = config?.verifyMarker;
      const titleMarker = override ?? target.title;
      if (titleMarker && titleMarker.trim().length >= 4 && body.includes(titleMarker.trim())) {
        return {
          ok: true,
          data: {
            url: response.finalUrl || target.remoteUrl,
            httpStatus: response.status,
            markerMatched: 'title',
            detail: `Page is live (HTTP ${response.status}) and contains the title, but not the content hash — verification is weaker than a hash match. Have the receiver echo cailyx.contentHash to make this conclusive.`,
          },
        };
      }

      return {
        ok: false,
        httpStatus: response.status,
        reason: `the page answered ${response.status} but contains neither the content hash nor the title — the content is not confirmed live at ${target.remoteUrl}`,
      };
    } catch (err) {
      return { ok: false, reason: `the remote URL could not be fetched: ${this.messageOf(err)}` };
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * Outbound headers, including the HMAC signature when a credential resolves.
   * The scheme is deliberately identical to the one this platform verifies on
   * its own inbound webhook, so a receiver's check is a copy, not a puzzle.
   */
  private headers(body: string, secret: string | null, meta: { event: string }): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Cailyx-Event': meta.event,
      'User-Agent': 'Cailyx-Publisher/1.0',
    };
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
      headers['X-Cailyx-Signature'] = `t=${timestamp},v1=${signature}`;
    }
    return headers;
  }

  private parseJson(body: string | undefined): Record<string, unknown> | null {
    if (!body) return null;
    try {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private messageOf(err: unknown): string {
    const message = err instanceof Error ? err.message : 'unknown error';
    // The fetcher's errors can carry the request URL; that is not secret, and
    // no header or body is ever included.
    return message.length > 300 ? `${message.slice(0, 300)}…` : message;
  }
}

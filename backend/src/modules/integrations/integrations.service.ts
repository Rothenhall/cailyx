/**
 * Integrations Service — resolves connection status for every external service.
 *
 * Pure config inspection (+ one short Redis ping). Returns booleans and display
 * metadata only — no secret value ever leaves this service.
 *
 * @module integrations.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Integration, IntegrationsResponse } from './integrations.types';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly config: ConfigService) {}

  /** Full connection roster. */
  async list(): Promise<IntegrationsResponse> {
    const has = (k: string) => {
      const v = this.config.get<string>(k);
      return typeof v === 'string' && v.trim().length > 0;
    };

    const redisConnected = await this.pingRedis();
    const swarmLive = this.config.get<string>('SWARM_ALLOW_LIVE') === '1';

    // Google OAuth is "configured" once the client id + secret are set; the
    // per-operator connection state (who has authorised which account) lives
    // on GET /integrations/google/connections, not here.
    const googleOAuthReady = has('GOOGLE_OAUTH_CLIENT_ID') && has('GOOGLE_OAUTH_CLIENT_SECRET');
    const googleRow = (key: string, name: string, api: string, doc: string): Integration => ({
      key,
      name,
      category: 'analytics',
      connected: false,
      status: googleOAuthReady ? 'not-connected' : 'unavailable',
      detail: googleOAuthReady
        ? `${api}. OAuth client is configured — connect a Google account from the connections panel.`
        : `${api}. Set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET, then connect a Google account from the panel.`,
      configHint: 'GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET',
      connectUrl: null,
      docsPath: doc,
    });

    const integrations: Integration[] = [
      // ── analytics (3-legged OAuth — modules/google) ──────────
      googleRow(
        'google-analytics',
        'Google Analytics',
        'GA4 sessions, users, channels & top pages',
        'backend/src/modules/google/README.md',
      ),
      googleRow(
        'google-search-console',
        'Google Search Console',
        'Search clicks, impressions, CTR, position & top queries',
        'backend/src/modules/google/README.md',
      ),

      // ── AI surfaces ─────────────────────────────────────────
      {
        key: 'anthropic',
        name: 'Anthropic (Claude)',
        category: 'ai-surface',
        connected: has('ANTHROPIC_API_KEY'),
        status: has('ANTHROPIC_API_KEY') ? 'connected' : 'not-connected',
        detail: has('ANTHROPIC_API_KEY')
          ? 'Claude answer surface + LLM copy/debate paths are live.'
          : 'Set ANTHROPIC_API_KEY to enable the Claude surface and all LLM-optional paths.',
        configHint: 'ANTHROPIC_API_KEY',
        connectUrl: null,
        docsPath: 'backend/src/modules/measurement/README.md',
      },
      {
        key: 'perplexity',
        name: 'Perplexity',
        category: 'ai-surface',
        connected: has('PERPLEXITY_API_KEY'),
        status: has('PERPLEXITY_API_KEY') ? 'connected' : 'not-connected',
        detail: has('PERPLEXITY_API_KEY')
          ? 'Perplexity (sonar) answer surface is live.'
          : 'Set PERPLEXITY_API_KEY to add the Perplexity answer surface.',
        configHint: 'PERPLEXITY_API_KEY',
        connectUrl: null,
        docsPath: 'backend/src/modules/measurement/README.md',
      },

      // ── SERP data ──────────────────────────────────────────
      {
        key: 'dataforseo',
        name: 'DataForSEO',
        category: 'serp',
        connected: has('DATAFORSEO_LOGIN') && has('DATAFORSEO_PASSWORD'),
        status: has('DATAFORSEO_LOGIN') && has('DATAFORSEO_PASSWORD') ? 'connected' : 'not-connected',
        detail:
          has('DATAFORSEO_LOGIN') && has('DATAFORSEO_PASSWORD')
            ? swarmLive
              ? 'Licensed SERP data feed is live (rankings, AI Overview, competitors).'
              : 'Credentials set, but live capture also needs SWARM_ALLOW_LIVE=1.'
            : 'Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD for SERP rankings, AI-Overview presence, and authority discovery.',
        configHint: 'DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (+ SWARM_ALLOW_LIVE=1)',
        connectUrl: null,
        docsPath: 'backend/src/modules/serp-intelligence/README.md',
      },

      // PageSpeed Insights is deliberately NOT listed as a connector. It is a
      // server-side API key (PSI_API_KEY) consumed by `technical-audit` for Core
      // Web Vitals, not something an operator connects per workspace. The key is
      // still read by `fetcher`'s PsiAdapter, which fails that one check with a
      // stated reason when it is unset.

      // ── infrastructure ─────────────────────────────────────
      {
        key: 'database',
        name: 'Database (SQLite/Postgres)',
        category: 'infrastructure',
        connected: true,
        status: 'connected',
        detail: 'Prisma datasource is reachable (every request that got here proves it).',
        configHint: 'DATABASE_URL / prisma/dev.db',
        connectUrl: null,
        docsPath: 'backend/src/modules/database/README.md',
      },
      {
        key: 'redis',
        name: 'Redis (queue + cache)',
        category: 'infrastructure',
        connected: redisConnected,
        status: redisConnected ? 'connected' : 'not-connected',
        detail: redisConnected
          ? 'Redis is reachable — scheduling / job queue available.'
          : 'Redis unreachable — scheduled re-runs and swarm campaigns queue are offline. Start it with `docker compose up -d`.',
        configHint: 'REDIS_URL',
        connectUrl: null,
        docsPath: 'backend/src/modules/scheduling/README.md',
      },

      // ── monetization ───────────────────────────────────────
      {
        key: 'stripe',
        name: 'Stripe Checkout',
        category: 'monetization',
        connected: has('STRIPE_CHECKOUT_URL_FULL') || has('STRIPE_CHECKOUT_URL_MONITORING'),
        status: has('STRIPE_CHECKOUT_URL_FULL') || has('STRIPE_CHECKOUT_URL_MONITORING') ? 'connected' : 'not-connected',
        detail:
          has('STRIPE_CHECKOUT_URL_FULL') || has('STRIPE_CHECKOUT_URL_MONITORING')
            ? 'Upgrade checkout links are configured.'
            : 'Set STRIPE_CHECKOUT_URL_FULL / _MONITORING to issue upgrade checkout links.',
        configHint: 'STRIPE_CHECKOUT_URL_FULL, STRIPE_CHECKOUT_URL_MONITORING',
        connectUrl: null,
        docsPath: 'backend/src/modules/delivery/README.md',
      },

      // ── email ──────────────────────────────────────────────
      {
        key: 'plunk',
        name: 'Plunk (transactional email)',
        category: 'email',
        connected: has('PLUNK_API_KEY'),
        status: has('PLUNK_API_KEY') ? 'connected' : 'not-connected',
        detail: has('PLUNK_API_KEY')
          ? 'Report-delivery + testimonial emails can send.'
          : 'Set PLUNK_API_KEY to send report-delivery emails.',
        configHint: 'PLUNK_API_KEY',
        connectUrl: null,
        docsPath: 'backend/src/modules/delivery/README.md',
      },

      // ── mode ───────────────────────────────────────────────
      {
        key: 'swarm-live',
        name: 'Swarm live mode',
        category: 'mode',
        connected: swarmLive,
        status: swarmLive ? 'enabled' : 'disabled',
        detail: swarmLive
          ? 'SWARM_ALLOW_LIVE=1 — journeys, campaigns, and SERP capture may spend on real AI surfaces / DataForSEO.'
          : 'SWARM_ALLOW_LIVE is off — the swarm runs on deterministic adapters only (no live spend).',
        configHint: 'SWARM_ALLOW_LIVE=1',
        connectUrl: null,
        docsPath: 'docs/analysis/swarm-layer.md',
      },
    ];

    const connected = integrations.filter((i) => i.connected).length;
    return { integrations, summary: { total: integrations.length, connected } };
  }

  /** Short, non-blocking Redis reachability check. */
  private async pingRedis(): Promise<boolean> {
    const url = this.config.get<string>('REDIS_URL') || 'redis://localhost:6380';
    let client: Redis | null = null;
    try {
      client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 600,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        enableOfflineQueue: false,
      });
      const pong = await Promise.race([
        client.connect().then(() => client!.ping()),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 700)),
      ]);
      return pong === 'PONG';
    } catch {
      return false;
    } finally {
      try {
        client?.disconnect();
      } catch {
        /* noop */
      }
    }
  }
}

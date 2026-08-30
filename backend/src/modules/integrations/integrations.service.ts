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

    const integrations: Integration[] = [
      // ── analytics (OAuth — not wired yet) ────────────────────
      {
        key: 'google-analytics',
        name: 'Google Analytics',
        category: 'analytics',
        connected: false,
        status: 'not-connected',
        detail: 'Traffic & behaviour. OAuth connection is an external prerequisite and is not wired yet.',
        configHint: 'Google OAuth (GA4 Data API)',
        connectUrl: null,
        docsPath: 'backend/src/modules/sleeper-refresh/README.md',
      },
      {
        key: 'google-search-console',
        name: 'Google Search Console',
        category: 'analytics',
        connected: false,
        status: 'not-connected',
        detail: 'Search rankings & impressions. OAuth connection is an external prerequisite; today GSC data is imported via pasted CSV in sleeper-refresh.',
        configHint: 'Google OAuth (Search Console API)',
        connectUrl: null,
        docsPath: 'backend/src/modules/sleeper-refresh/README.md',
      },

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

      // ── performance ────────────────────────────────────────
      {
        key: 'pagespeed',
        name: 'Google PageSpeed Insights',
        category: 'performance',
        connected: has('PSI_API_KEY'),
        status: has('PSI_API_KEY') ? 'connected' : 'not-connected',
        detail: has('PSI_API_KEY')
          ? 'Core Web Vitals are pulled for the technical audit.'
          : 'Set PSI_API_KEY to include Core Web Vitals in the technical audit (free 25k/day).',
        configHint: 'PSI_API_KEY',
        connectUrl: null,
        docsPath: 'backend/src/modules/technical-audit/README.md',
      },

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

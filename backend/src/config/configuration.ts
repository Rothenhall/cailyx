/**
 * Application configuration.
 * Provides a validated, typed configuration object loaded from environment variables.
 *
 * @module configuration
 */

export const configuration = () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://cailyx:cailyx_dev@localhost:5436/cailyx?schema=public',
  },

  // Fetcher module
  fetcher: {
    timeoutMs: parseInt(process.env.FETCHER_TIMEOUT_MS || '30000', 10),
    retryCount: parseInt(process.env.FETCHER_RETRY_COUNT || '3', 10),
    retryBackoffMs: parseInt(process.env.FETCHER_RETRY_BACKOFF_MS || '1000', 10),
    rateLimitPerDomainMs: parseInt(process.env.FETCHER_RATE_LIMIT_PER_DOMAIN_MS || '3000', 10),
    rateLimitGlobalPerSec: parseInt(process.env.FETCHER_RATE_LIMIT_GLOBAL_PER_SEC || '10', 10),
  },

  // Technical Audit module
  technicalAudit: {
    psiApiKey: process.env.PSI_API_KEY || '',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',
    // Severity thresholds — configurable per engagement (P2 #13)
    thresholds: {
      jsRenderDependencyPercent: parseInt(process.env.TA_JS_DEPENDENCY_PERCENT || '70', 10),
      jsRenderContentLossFailPercent: parseInt(process.env.TA_JS_CONTENT_LOSS_FAIL || '30', 10),
      lcpGoodMs: parseInt(process.env.TA_LCP_GOOD_MS || '2500', 10),
      lcpNeedsImprovementMs: parseInt(process.env.TA_LCP_NEEDS_IMPROVEMENT_MS || '4000', 10),
      clsGood: parseFloat(process.env.TA_CLS_GOOD || '0.1'),
      clsNeedsImprovement: parseFloat(process.env.TA_CLS_NEEDS_IMPROVEMENT || '0.25'),
      inpGoodMs: parseInt(process.env.TA_INP_GOOD_MS || '200', 10),
      inpNeedsImprovementMs: parseInt(process.env.TA_INP_NEEDS_IMPROVEMENT_MS || '500', 10),
    },
    // Cost governance (P2 #15) — per-run cost budget in USD
    maxCostPerRunUsd: parseFloat(process.env.TA_MAX_COST_PER_RUN || '5.00'),
  },
});
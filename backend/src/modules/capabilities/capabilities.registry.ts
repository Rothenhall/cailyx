/**
 * The capability registry — G18's catalogue of every provider-backed thing
 * this backend can do.
 *
 * This file is the **source of truth for the keys**, and it is deliberately
 * code rather than data: a capability that no longer exists should stop being
 * reported, and that only happens if adding one means editing a file.
 *
 * Two kinds of fact live here, and keeping them apart is the whole point of
 * the package:
 *
 * - **Config facts** (`configured`, `mockMode`, `blockedBy`, `action`,
 *   `envVars`, `configDetail`) come from the `probe` below and are recomputed
 *   on every read. They are never persisted, because env does not change
 *   while the process runs and a stale copy is worse than none.
 * - **Observed facts** (`verified`, `lastSuccessAt`, `lastError*`) live in the
 *   `CapabilityStatus` row and are written *only* by
 *   `CapabilitiesService.recordSuccess` / `recordFailure`. Nothing in this
 *   file may imply them — that is the acceptance criterion.
 *
 * Env var names here are the ones the provider code actually reads, taken from
 * each module's own `config.get` calls (see the module README for the
 * provenance of each).
 *
 * @module capabilities.registry
 */

import { existsSync } from 'node:fs';
import type {
  CapabilityCategory,
  CapabilityProbe,
  BlockedBy,
  ProjectResourceKind,
} from './capabilities.types';

/** Minimal env access, so the registry is testable without a ConfigService. */
export interface EnvReader {
  get(key: string, fallback?: string): string | undefined;
  /** Trimmed non-empty check — the strictest predicate in the codebase. */
  has(key: string): boolean;
  /**
   * Names of the set variables starting with `prefix`. Needed for the one
   * capability whose env var name is derived from data rather than fixed:
   * `PUBLISH_CREDENTIAL_<SLUG>` is built from a destination's `credentialRef`
   * (`publishing/lib/credentials.util.ts`), so "is it configured?" can only be
   * answered by looking for the family.
   */
  list(prefix: string): string[];
}

/** How a capability appears to a client, when it appears to one at all. */
export interface ClientFacing {
  /** Client-meaningful slug. Never an internal key. */
  capability: string;
  label: string;
  description: string;
  /** What the client can do themselves, if anything. */
  clientAction: string | null;
  produces: string[];
}

export interface CapabilityDefinition {
  /** Dotted `domain.subject`, matching the convention on the Prisma model. */
  key: string;
  label: string;
  category: CapabilityCategory;
  /** Task kinds this capability serves — drives the scheduler-state read. */
  taskKinds: string[];
  /** Action ids the UI binds buttons to. Only offered when `state === 'ready'`. */
  actions: string[];
  /** Output types this capability produces. */
  outputs: string[];
  /** Engine/provider ids this capability can drive. */
  supports: string[];
  /** Capability keys that must be ready first. */
  prerequisites: string[];
  /** Runtime ceilings: rate limits, batch caps, cost caps. */
  limits: Record<string, unknown>;
  /** The project-scoped resource it needs, if any. */
  projectResource: ProjectResourceKind | null;
  /** True when authorization is per-operator (OAuth) rather than per-project. */
  perUserAuthorization: boolean;
  probe: (env: EnvReader) => CapabilityProbe;
  clientFacing: ClientFacing | null;
}

/** Build a probe result. Keeps the thirty-odd entries below readable. */
function probe(
  configured: boolean,
  mockMode: boolean,
  blockedBy: BlockedBy | null,
  action: string,
  envVars: string[],
  configDetail: string | null = null,
): CapabilityProbe {
  return { configured, mockMode, blockedBy, action, envVars, configDetail };
}

const MOCK_DISCLOSURE =
  'Results from this capability come from fixtures, not from the live provider. They are not measurements.';

/** The DataForSEO credential every DataForSEO surface shares. */
const DATAFORSEO_CREDS = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'];

/** One Cloro credential, five surfaces — emit them from one place. */
function cloroSurface(
  key: string,
  label: string,
  taskType: string,
  creditsPerTask: number,
): CapabilityDefinition {
  return {
    key,
    label,
    category: 'aeo-engine',
    taskKinds: ['aeo-audit'],
    actions: ['aeo.measure'],
    outputs: ['answer-text', 'citations', 'sources'],
    supports: [taskType],
    prerequisites: ['aeo.cloro'],
    limits: { creditsPerTask, maxConcurrency: 'CLORO_MAX_CONCURRENCY' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('CLORO_API_KEY')
        ? probe(
            true,
            false,
            null,
            'Ready to run once a call has actually succeeded. If it has not, run one measurement and the result is recorded here.',
            ['CLORO_API_KEY'],
            `Cloro task type ${taskType}; ${creditsPerTask} credits per task.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set CLORO_API_KEY (sign up at cloro.dev), then run one measurement so this surface is verified.',
            ['CLORO_API_KEY'],
            null,
          ),
    clientFacing: null,
  };
}

/**
 * A browser-driven answer engine. Three checks, in the adapter's own order,
 * each producing its own actionable state — "we never turned it on" and "the
 * session expired" are different problems with different fixes.
 */
function browserSurface(
  key: string,
  label: string,
  envPrefix: string,
  signInUrl: string,
): CapabilityDefinition {
  return {
    key,
    label,
    category: 'aeo-engine',
    taskKinds: ['aeo-audit'],
    actions: ['aeo.measure'],
    outputs: ['answer-text', 'sources'],
    supports: [key.replace('aeo.', '')],
    prerequisites: [],
    limits: {
      timeoutMsEnvVar: `${envPrefix}_TIMEOUT_MS`,
      minGapMsEnvVar: `${envPrefix}_MIN_GAP_MS`,
    },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const sessionVar = `${envPrefix}_SESSION_PATH`;
      const enabled = env.get('AEO_ALLOW_BROWSER_SURFACE') === '1';
      if (!enabled) {
        return probe(
          false,
          false,
          'master-switch-off',
          'Set AEO_ALLOW_BROWSER_SURFACE=1 to enable the browser surfaces, after reading the Terms-of-Use note in the AEO module README.',
          ['AEO_ALLOW_BROWSER_SURFACE', sessionVar],
          null,
        );
      }
      const sessionPath = env.get(sessionVar);
      if (!sessionPath) {
        return probe(
          false,
          false,
          'session-missing',
          `Sign in to ${signInUrl} once in a browser you control and save the Playwright storageState to ${sessionVar}. ` +
            'Cailyx never handles the password and never a client’s account.',
          ['AEO_ALLOW_BROWSER_SURFACE', sessionVar],
          null,
        );
      }
      if (!existsSync(sessionPath)) {
        return probe(
          false,
          false,
          'session-file-missing',
          `${sessionVar} points at ${sessionPath}, which is not on disk. Sign in again and re-save the session there.`,
          ['AEO_ALLOW_BROWSER_SURFACE', sessionVar],
          `Configured session path: ${sessionPath}`,
        );
      }
      return probe(
        true,
        false,
        null,
        'Configured with a session on disk. It becomes usable once a call has actually succeeded.',
        ['AEO_ALLOW_BROWSER_SURFACE', sessionVar, `${envPrefix}_URL`],
        `Session file present; headless=${env.get('AEO_BROWSER_HEADLESS', '1')}.`,
      );
    },
    clientFacing: null,
  };
}

/** One DataForSEO surface behind the shared credential and the live master switch. */
function dataForSeoSurface(
  key: string,
  label: string,
  opts: {
    taskKinds: string[];
    outputs: string[];
    costCapEnvVar: string;
    rejectReasonEnvVar?: string;
    fixtureGate?: boolean;
    extraLimits?: Record<string, unknown>;
  },
): CapabilityDefinition {
  return {
    key,
    label,
    category: 'serp-data',
    taskKinds: opts.taskKinds,
    actions: ['data.capture'],
    outputs: opts.outputs,
    supports: ['dataforseo'],
    prerequisites: ['serp.dataforseo'],
    limits: { costCapEnvVar: opts.costCapEnvVar, ...(opts.extraLimits ?? {}) },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      if (!env.has('DATAFORSEO_LOGIN') || !env.has('DATAFORSEO_PASSWORD')) {
        return probe(
          false,
          false,
          'credential-missing',
          'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD — one funded account serves SERP, keywords, backlinks and business data.',
          DATAFORSEO_CREDS,
          null,
        );
      }
      if (env.get('SWARM_ALLOW_LIVE') !== '1') {
        // Fixture mode is a real state, not an error: the surface can run and
        // will produce fixture output. It must not be presented as measured.
        const fixtureOn = opts.fixtureGate === true && env.get('SERP_ALLOW_FIXTURE') === '1';
        return probe(
          fixtureOn,
          fixtureOn,
          'master-switch-off',
          fixtureOn
            ? 'Running against fixtures because SWARM_ALLOW_LIVE is not 1. Set it to allow paid calls; until then every result from here is simulated.'
            : 'Set SWARM_ALLOW_LIVE=1 to allow paid DataForSEO calls. Credentials alone do not permit a live request.',
          [...DATAFORSEO_CREDS, 'SWARM_ALLOW_LIVE', ...(opts.fixtureGate ? ['SERP_ALLOW_FIXTURE'] : [])],
          fixtureOn ? 'Fixture provider active.' : null,
        );
      }
      return probe(
        true,
        false,
        null,
        'Credentials present and live calls permitted. It becomes usable once a real call has succeeded.',
        [...DATAFORSEO_CREDS, 'SWARM_ALLOW_LIVE', opts.costCapEnvVar],
        opts.rejectReasonEnvVar ? `Reject reason env var: ${opts.rejectReasonEnvVar}` : null,
      );
    },
    clientFacing: null,
  };
}

/** Provider-preference string the LLM-backed features share. */
const LLM_CREDS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];

/**
 * An app feature whose only external dependency is the shared LLM caller:
 * OpenRouter when `OPENROUTER_API_KEY` is set, Anthropic otherwise
 * (`common/llm/llm.service.ts` — the order is that file's, not this one's).
 *
 * These are separate keys rather than one "llm" row because each feature
 * answers its own question: they can break independently (a model id that the
 * provider has retired degrades one feature, not all of them), and `verified`
 * is per call site — the point of recording observations is to know *which*
 * feature has actually worked.
 */
function llmFeature(opts: {
  key: string;
  label: string;
  /** Task kinds this feature serves, when the scheduler tracks one. */
  taskKinds?: string[];
  actions: string[];
  outputs: string[];
  limits: Record<string, unknown>;
  /** Model-override env vars this feature reads, spelled exactly as its code reads them. */
  modelEnvVars: string[];
  /** What the feature produces, in the sentence an operator reads when it is not ready. */
  needs: string;
}): CapabilityDefinition {
  const envVars = [...LLM_CREDS, ...opts.modelEnvVars];
  return {
    key: opts.key,
    label: opts.label,
    category: 'content',
    taskKinds: opts.taskKinds ?? [],
    actions: opts.actions,
    outputs: opts.outputs,
    supports: ['openrouter', 'anthropic'],
    prerequisites: [],
    limits: opts.limits,
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      // Provider order is OPENROUTER -> ANTHROPIC, which is an either/or and so
      // cannot be a flat prerequisite list. The OR lives here.
      if (!env.has('OPENROUTER_API_KEY') && !env.has('ANTHROPIC_API_KEY')) {
        return probe(
          false,
          false,
          'credential-missing',
          `Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY: ${opts.needs} needs an LLM provider, and it ` +
            'degrades honestly rather than substituting template text for a result.',
          envVars,
          null,
        );
      }
      const preferred = env.has('OPENROUTER_API_KEY');
      return probe(
        true,
        false,
        null,
        `Configured. It becomes usable once a call has actually succeeded — configuration is not evidence.`,
        envVars,
        preferred
          ? `Provider OpenRouter. Model overrides: ${opts.modelEnvVars.join(', ')} (unset falls through to the shared caller's default).`
          : `OPENROUTER_API_KEY is unset, so the Anthropic fallback carries this feature. Model overrides: ${opts.modelEnvVars.join(', ')}.`,
      );
    },
    clientFacing: null,
  };
}

/** The whole catalogue. Order is the order the connections screen renders. */
export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
  // ── AEO: the shared Cloro credential ──────────────────────────────────
  {
    key: 'aeo.cloro',
    label: 'Cloro (answer engines via API)',
    category: 'aeo-engine',
    taskKinds: ['aeo-audit'],
    actions: [],
    outputs: [],
    supports: ['cloro'],
    prerequisites: [],
    limits: {
      creditUsdEnvVar: 'CLORO_CREDIT_USD',
      maxConcurrencyEnvVar: 'CLORO_MAX_CONCURRENCY',
      maxCostPerAuditEnvVar: 'AEO_MAX_COST_PER_AUDIT',
      defaultSurfacesEnvVar: 'AEO_SURFACES',
      matrixTierEnvVar: 'AEO_MATRIX_TIER',
      contextMaxPagesEnvVar: 'AEO_CONTEXT_MAX_PAGES',
    },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('CLORO_API_KEY')
        ? probe(
            true,
            false,
            null,
            'Cloro is configured. It becomes usable once a call has succeeded — the credit balance is read at request time, not assumed.',
            ['CLORO_API_KEY', 'CLORO_CREDIT_USD', 'CLORO_MAX_CONCURRENCY'],
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set CLORO_API_KEY. Without it every cloro-* engine fails closed; the browser surfaces are the only alternative.',
            ['CLORO_API_KEY'],
            null,
          ),
    clientFacing: null,
  },
  cloroSurface('aeo.cloro.chatgpt', 'ChatGPT (via Cloro)', 'CHATGPT', 5),
  cloroSurface('aeo.cloro.perplexity', 'Perplexity (via Cloro)', 'PERPLEXITY', 4),
  cloroSurface('aeo.cloro.gemini', 'Gemini (via Cloro)', 'GEMINI', 4),
  cloroSurface('aeo.cloro.ai-overview', 'Google AI Overview (via Cloro)', 'GOOGLE', 5),
  cloroSurface('aeo.cloro.ai-mode', 'Google AI Mode (via Cloro)', 'AIMODE', 4),

  // ── AEO: browser surfaces ────────────────────────────────────────────
  browserSurface('aeo.chatgpt-browser', 'ChatGPT (browser session)', 'AEO_CHATGPT', 'https://chatgpt.com/'),
  browserSurface(
    'aeo.perplexity-browser',
    'Perplexity (browser session)',
    'AEO_PERPLEXITY',
    'https://www.perplexity.ai/',
  ),
  browserSurface('aeo.gemini-browser', 'Gemini (browser session)', 'AEO_GEMINI', 'https://gemini.google.com/app'),

  // ── AEO: the test-only mock ──────────────────────────────────────────
  {
    key: 'aeo.mock',
    label: 'Mock answer surface (test only)',
    category: 'aeo-engine',
    taskKinds: ['aeo-audit'],
    actions: [],
    outputs: ['answer-text'],
    supports: ['mock'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const on = env.get('MEASUREMENT_ALLOW_MOCK') === '1';
      return on
        ? probe(
            true,
            true,
            'mock-only',
            'This is the test-only deterministic adapter. It must never be enabled in production — unset MEASUREMENT_ALLOW_MOCK.',
            ['MEASUREMENT_ALLOW_MOCK'],
            'Deterministic fixture adapter; produces no real observation.',
          )
        : probe(
            false,
            false,
            null,
            'Off, which is correct. MEASUREMENT_ALLOW_MOCK exists only so the smoke harness can run without spending money.',
            ['MEASUREMENT_ALLOW_MOCK'],
            null,
          );
    },
    clientFacing: null,
  },

  // ── AEO: the LLM analysis passes ─────────────────────────────────────
  {
    key: 'aeo.analysis',
    label: 'AEO analysis passes (context, matrix phrasing, stance)',
    category: 'aeo-engine',
    taskKinds: ['aeo-audit'],
    actions: [],
    outputs: ['context-synthesis', 'matrix-phrasing', 'stance-verdicts'],
    supports: ['openrouter', 'anthropic'],
    prerequisites: [],
    limits: { modelEnvVar: 'AEO_LLM_MODEL', timeoutMsEnvVar: 'AEO_LLM_TIMEOUT_MS' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      // Provider order is OPENROUTER -> ANTHROPIC. Expressing that as a flat
      // prerequisite list is impossible (they are alternatives, not both), so
      // the OR lives in the probe and the reason string names the winner.
      if (env.has('OPENROUTER_API_KEY')) {
        return probe(
          true,
          false,
          null,
          'Analysis passes run on OpenRouter. They become usable once a call has succeeded.',
          ['OPENROUTER_API_KEY', 'AEO_LLM_MODEL'],
          `Preferred provider OpenRouter, model ${env.get('AEO_LLM_MODEL', 'deepseek/deepseek-v4.1-flash')}.`,
        );
      }
      if (env.has('ANTHROPIC_API_KEY')) {
        return probe(
          true,
          false,
          null,
          'Analysis passes run on the Anthropic fallback. They become usable once a call has succeeded.',
          ['ANTHROPIC_API_KEY', 'AEO_STANCE_JUDGE_MODEL'],
          `OpenRouter is unset, so the Anthropic fallback carries the analysis (model ${env.get('AEO_STANCE_JUDGE_MODEL', 'claude-opus-5')}).`,
        );
      }
      return probe(
        false,
        false,
        'credential-missing',
        'Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY for the analysis passes. ' +
          'Without one the counted metrics still work — mention rate, citation rate and share of voice never depended on a model — but stance is left unjudged.',
        ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'],
        null,
      );
    },
    clientFacing: null,
  },

  // ── LLM providers ────────────────────────────────────────────────────
  {
    key: 'llm.openrouter',
    label: 'OpenRouter (LLM)',
    category: 'llm',
    taskKinds: [],
    actions: [],
    outputs: ['text', 'json'],
    supports: ['openrouter'],
    prerequisites: [],
    limits: { modelEnvVar: 'OPENROUTER_MODEL' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('OPENROUTER_API_KEY')
        ? probe(
            true,
            false,
            null,
            'OpenRouter is the preferred LLM provider for every module that uses the shared caller.',
            ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'],
            `Default model ${env.get('OPENROUTER_MODEL', 'deepseek/deepseek-v4.1-flash')}.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set OPENROUTER_API_KEY to enable the shared LLM caller’s preferred provider. Everything it powers degrades honestly without it.',
            ['OPENROUTER_API_KEY'],
            null,
          ),
    clientFacing: null,
  },
  {
    key: 'llm.anthropic',
    label: 'Anthropic (LLM fallback + Claude surface)',
    category: 'llm',
    taskKinds: [],
    actions: [],
    outputs: ['text', 'json'],
    supports: ['anthropic'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('ANTHROPIC_API_KEY')
        ? probe(true, false, null, 'Anthropic is available as the fallback LLM provider.', ['ANTHROPIC_API_KEY'], null)
        : probe(
            false,
            false,
            'credential-missing',
            'Set ANTHROPIC_API_KEY to enable the fallback LLM provider. It is only reached when OPENROUTER_API_KEY is unset.',
            ['ANTHROPIC_API_KEY'],
            null,
          ),
    clientFacing: null,
  },

  // ── Provider-backed features: content and research (G18 breadth) ──────
  //
  // Every one of these invokes a provider and had no key of its own, so the
  // connections screen had nothing to show for it and fell back to copy that
  // said less than the backend knows. Each is registered with the model and
  // cost-cap env vars its own module reads.
  llmFeature({
    key: 'content.article',
    label: 'Article generation',
    taskKinds: ['content-generation'],
    actions: ['content.generate'],
    outputs: ['article-draft', 'revisions'],
    limits: {
      articleModelEnvVar: 'CONTENT_ARTICLE_MODEL',
      growthExecutionArticleModelEnvVar: 'GROWTH_EXECUTION_ARTICLE_MODEL',
      anthropicModelEnvVar: 'CONTENT_ARTICLE_ANTHROPIC_MODEL',
    },
    modelEnvVars: ['CONTENT_ARTICLE_MODEL', 'CONTENT_ARTICLE_ANTHROPIC_MODEL'],
    needs: 'Article generation',
  }),
  llmFeature({
    key: 'content.ad',
    label: 'Ad copy generation',
    taskKinds: ['content-generation'],
    actions: ['content.generate'],
    outputs: ['ad-draft'],
    limits: {
      adModelEnvVar: 'CONTENT_AD_MODEL',
      growthExecutionAdModelEnvVar: 'GROWTH_EXECUTION_AD_MODEL',
      anthropicModelEnvVar: 'CONTENT_AD_ANTHROPIC_MODEL',
    },
    modelEnvVars: ['CONTENT_AD_MODEL', 'CONTENT_AD_ANTHROPIC_MODEL'],
    needs: 'Ad copy generation',
  }),
  llmFeature({
    key: 'content.persona',
    label: 'Persona generation',
    actions: ['persona.generate'],
    outputs: ['personas'],
    limits: {
      modelEnvVar: 'PERSONA_LLM_MODEL',
      anthropicModelEnvVar: 'PERSONA_LLM_ANTHROPIC_MODEL',
      maxCostPerGenerateEnvVar: 'PERSONA_MAX_COST_PER_GENERATE',
      maxPerProjectEnvVar: 'PERSONA_MAX_PER_PROJECT',
    },
    modelEnvVars: ['PERSONA_LLM_MODEL', 'PERSONA_LLM_ANTHROPIC_MODEL'],
    needs: 'Persona generation',
  }),
  llmFeature({
    key: 'content.page-analysis',
    label: 'Page analysis',
    actions: ['page.analyze'],
    outputs: ['page-analysis'],
    limits: {
      modelEnvVar: 'PAGE_ANALYSIS_LLM_MODEL',
      anthropicModelEnvVar: 'PAGE_ANALYSIS_LLM_ANTHROPIC_MODEL',
    },
    modelEnvVars: ['PAGE_ANALYSIS_LLM_MODEL', 'PAGE_ANALYSIS_LLM_ANTHROPIC_MODEL'],
    needs: 'Page analysis',
  }),
  llmFeature({
    key: 'content.authority',
    label: 'Authority scan',
    actions: ['authority.scan'],
    outputs: ['authority-candidates'],
    limits: {
      modelEnvVar: 'AUTHORITY_LLM_MODEL',
      anthropicModelEnvVar: 'AUTHORITY_LLM_ANTHROPIC_MODEL',
    },
    modelEnvVars: ['AUTHORITY_LLM_MODEL', 'AUTHORITY_LLM_ANTHROPIC_MODEL'],
    needs: 'The authority scan',
  }),
  llmFeature({
    key: 'content.council',
    label: 'Council sessions (multi-model review)',
    actions: ['council.run'],
    outputs: ['council-session'],
    limits: {
      modelEnvVar: 'COUNCIL_LLM_MODEL',
      anthropicModelEnvVar: 'COUNCIL_LLM_ANTHROPIC_MODEL',
    },
    modelEnvVars: ['COUNCIL_LLM_MODEL', 'COUNCIL_LLM_ANTHROPIC_MODEL'],
    needs: 'Council sessions',
  }),
  llmFeature({
    key: 'content.internal-link',
    label: 'Internal link graph',
    actions: ['link-graph.build'],
    outputs: ['link-graph', 'link-recommendations'],
    limits: {
      modelEnvVar: 'INTERNAL_LINK_LLM_MODEL',
      anthropicModelEnvVar: 'INTERNAL_LINK_LLM_ANTHROPIC_MODEL',
      /** Fixture roots are an offline test affordance; the LLM pass is still real. */
      fixtureRootsEnvVar: 'INTERNAL_LINK_ALLOW_FIXTURE',
    },
    modelEnvVars: ['INTERNAL_LINK_LLM_MODEL', 'INTERNAL_LINK_LLM_ANTHROPIC_MODEL'],
    needs: 'The link graph',
  }),
  llmFeature({
    key: 'content.findings',
    label: 'Findings narrative',
    actions: ['findings.generate'],
    outputs: ['findings-copy'],
    limits: {
      modelEnvVar: 'FINDINGS_MODEL',
      anthropicModelEnvVar: 'FINDINGS_ANTHROPIC_MODEL',
      /** The model-free path: gap rows are still produced, the prose is not. */
      fallback: 'raw-gap-rows',
    },
    modelEnvVars: ['FINDINGS_MODEL', 'FINDINGS_ANTHROPIC_MODEL'],
    needs: 'The findings narrative',
  }),

  // ── First-party answer surfaces (measurement) ────────────────────────
  {
    key: 'ai-surface.claude',
    label: 'Claude (measured answer surface)',
    category: 'ai-surface',
    taskKinds: ['aeo-audit'],
    actions: ['aeo.measure'],
    outputs: ['answer-text', 'sources'],
    supports: ['claude'],
    prerequisites: ['llm.anthropic'],
    limits: { modelEnvVar: 'MEASUREMENT_CLAUDE_MODEL', maxCostPerRunEnvVar: 'MEASUREMENT_MAX_COST_PER_RUN' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('ANTHROPIC_API_KEY')
        ? probe(
            true,
            false,
            null,
            'The Claude answer surface is configured. It becomes usable once a call has succeeded.',
            ['ANTHROPIC_API_KEY', 'MEASUREMENT_CLAUDE_MODEL'],
            `Model ${env.get('MEASUREMENT_CLAUDE_MODEL', 'claude-opus-5')}.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set ANTHROPIC_API_KEY to add Claude as a measured answer surface.',
            ['ANTHROPIC_API_KEY'],
            null,
          ),
    clientFacing: {
      capability: 'claude-visibility',
      label: 'Claude visibility',
      description: 'How often Claude’s answers mention or cite your brand for your tracked questions.',
      clientAction: null,
      produces: ['Mention rate', 'Citations', 'Share of voice'],
    },
  },
  {
    key: 'ai-surface.perplexity',
    label: 'Perplexity (measured answer surface)',
    category: 'ai-surface',
    taskKinds: ['aeo-audit'],
    actions: ['aeo.measure'],
    outputs: ['answer-text', 'sources'],
    supports: ['perplexity'],
    prerequisites: [],
    limits: { modelEnvVar: 'MEASUREMENT_PERPLEXITY_MODEL', maxCostPerRunEnvVar: 'MEASUREMENT_MAX_COST_PER_RUN' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('PERPLEXITY_API_KEY')
        ? probe(
            true,
            false,
            null,
            'The Perplexity answer surface is configured. It becomes usable once a call has succeeded.',
            ['PERPLEXITY_API_KEY', 'MEASUREMENT_PERPLEXITY_MODEL'],
            `Model ${env.get('MEASUREMENT_PERPLEXITY_MODEL', 'sonar')}.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set PERPLEXITY_API_KEY to add Perplexity as a measured answer surface.',
            ['PERPLEXITY_API_KEY'],
            null,
          ),
    clientFacing: {
      capability: 'perplexity-visibility',
      label: 'Perplexity visibility',
      description: 'How often Perplexity’s answers mention or cite your brand for your tracked questions.',
      clientAction: null,
      produces: ['Mention rate', 'Citations', 'Share of voice'],
    },
  },

  {
    key: 'entity.model-diff',
    label: 'Entity model-diff (how models describe the brand)',
    category: 'ai-surface',
    taskKinds: [],
    actions: ['entity.model-diff'],
    outputs: ['model-answers', 'description-divergence'],
    supports: ['anthropic', 'perplexity'],
    prerequisites: [],
    limits: { llmModelEnvVar: 'MEASUREMENT_LLM_MODEL', claudeModelEnvVar: 'MEASUREMENT_CLAUDE_MODEL' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const vars = ['ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY', 'MEASUREMENT_LLM_MODEL', 'OPENROUTER_API_KEY'];
      if (!env.has('ANTHROPIC_API_KEY') && !env.has('PERPLEXITY_API_KEY')) {
        return probe(
          false,
          false,
          'credential-missing',
          'Set ANTHROPIC_API_KEY (Claude) or PERPLEXITY_API_KEY (Perplexity) to ask the models how they describe ' +
            'this entity. With neither set the divergence judgement cannot run at all.',
          vars,
          null,
        );
      }
      const asking = [
        env.has('ANTHROPIC_API_KEY') ? `Claude (${env.get('MEASUREMENT_CLAUDE_MODEL', 'claude-opus-5')})` : null,
        env.has('PERPLEXITY_API_KEY') ? `Perplexity (${env.get('MEASUREMENT_PERPLEXITY_MODEL', 'sonar')})` : null,
      ].filter((s): s is string => s !== null);
      // The divergence verdict is a separate, LLM-backed pass: with only
      // PERPLEXITY set the answers arrive and the verdict is left unjudged,
      // which the module itself reports rather than guessing at.
      const judge = env.has('OPENROUTER_API_KEY') || env.has('ANTHROPIC_API_KEY');
      return probe(
        true,
        false,
        null,
        'Configured. It becomes usable once a model-diff call has actually succeeded.',
        vars,
        `Models asked: ${asking.join(', ')}. Divergence judge: ${
          judge ? 'available (shared LLM caller)' : 'unavailable — the judge needs OPENROUTER_API_KEY or ANTHROPIC_API_KEY'
        }.`,
      );
    },
    clientFacing: null,
  },

  // ── DataForSEO ───────────────────────────────────────────────────────
  {
    key: 'serp.dataforseo',
    label: 'DataForSEO (shared credential)',
    category: 'serp-data',
    taskKinds: [],
    actions: [],
    outputs: [],
    supports: ['dataforseo'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('DATAFORSEO_LOGIN') && env.has('DATAFORSEO_PASSWORD')
        ? probe(
            true,
            false,
            null,
            'One funded DataForSEO account serves SERP, keywords, backlinks and business data. Live calls additionally need SWARM_ALLOW_LIVE=1.',
            DATAFORSEO_CREDS,
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable SERP, keyword, backlink and business-data collection.',
            DATAFORSEO_CREDS,
            null,
          ),
    clientFacing: null,
  },
  dataForSeoSurface('serp.dataforseo.serp', 'SERP results (DataForSEO)', {
    taskKinds: ['serp'],
    outputs: ['organic-results', 'ai-overview-presence', 'competitor-positions'],
    costCapEnvVar: 'SERP_MAX_COST_PER_CAPTURE',
    fixtureGate: true,
    extraLimits: { fixtureGateEnvVar: 'SERP_ALLOW_FIXTURE', presenceMaxQueriesEnvVar: 'PRESENCE_SERP_MAX_QUERIES' },
  }),
  dataForSeoSurface('keywords.dataforseo', 'Keyword data (DataForSEO)', {
    taskKinds: [],
    outputs: ['search-volume', 'related-keywords'],
    costCapEnvVar: 'KEYWORD_RESEARCH_MAX_COST_PER_RUN',
  }),
  dataForSeoSurface('backlinks.dataforseo', 'Backlinks (DataForSEO)', {
    taskKinds: ['backlinks'],
    outputs: ['backlink-profile', 'referring-domains', 'authority-signals'],
    costCapEnvVar: 'BACKLINKS_MAX_COST_PER_RUN',
  }),
  dataForSeoSurface('business-data.dataforseo', 'Business profile & reviews (DataForSEO)', {
    taskKinds: ['presence'],
    outputs: ['business-profile', 'rating', 'review-counts'],
    costCapEnvVar: 'PRESENCE_SERP_MAX_QUERIES',
    rejectReasonEnvVar: 'PRESENCE_BUSINESS_LOCATION',
  }),

  // ── Google Search Console + Analytics ────────────────────────────────
  {
    key: 'google.oauth',
    label: 'Google OAuth (Search Console + Analytics)',
    category: 'analytics',
    taskKinds: [],
    actions: ['google.connect'],
    outputs: [],
    supports: ['google'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: true,
    probe: (env) =>
      env.has('GOOGLE_OAUTH_CLIENT_ID') && env.has('GOOGLE_OAUTH_CLIENT_SECRET')
        ? probe(
            true,
            false,
            null,
            'The OAuth client is configured. Each operator still has to connect their own Google account before any project can be mapped.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'],
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from a Google Cloud project with the Search Console API and Analytics Admin/Data APIs enabled, then add the redirect URI to that client.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'],
            null,
          ),
    clientFacing: null,
  },
  {
    key: 'google.search-console',
    label: 'Google Search Console',
    category: 'analytics',
    taskKinds: ['seo-audit'],
    actions: ['google.gsc.read'],
    outputs: ['clicks', 'impressions', 'ctr', 'position', 'top-queries', 'url-inspection'],
    supports: ['search-console'],
    prerequisites: ['google.oauth'],
    limits: { inspectBudgetEnvVar: 'SEO_INSPECT_BUDGET' },
    projectResource: 'google-search-console',
    perUserAuthorization: true,
    probe: (env) =>
      env.has('GOOGLE_OAUTH_CLIENT_ID') && env.has('GOOGLE_OAUTH_CLIENT_SECRET')
        ? probe(
            true,
            false,
            null,
            'Configured. It becomes usable once the operator has connected a Google account AND this project has a Search Console site mapped to it.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SEO_INSPECT_BUDGET'],
            `URL Inspection calls capped at ${env.get('SEO_INSPECT_BUDGET', '40')} per run.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set the Google OAuth client id and secret first (see google.oauth), then connect a Google account and map the site.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
            null,
          ),
    clientFacing: {
      capability: 'search-performance',
      label: 'Search performance',
      description: 'Real clicks, impressions and average position from Google Search Console.',
      clientAction: 'Connect your Google Search Console account, then choose the site for this project.',
      produces: ['Clicks', 'Impressions', 'Average position', 'Top queries'],
    },
  },
  {
    key: 'google.analytics',
    label: 'Google Analytics 4',
    category: 'analytics',
    taskKinds: ['report', 'score'],
    actions: ['google.ga4.read'],
    outputs: ['sessions', 'users', 'channels', 'top-pages'],
    supports: ['analytics'],
    prerequisites: ['google.oauth'],
    limits: {},
    projectResource: 'google-analytics',
    perUserAuthorization: true,
    probe: (env) =>
      env.has('GOOGLE_OAUTH_CLIENT_ID') && env.has('GOOGLE_OAUTH_CLIENT_SECRET')
        ? probe(
            true,
            false,
            null,
            'Configured. It becomes usable once the operator has connected a Google account AND this project has a GA4 property mapped to it.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set the Google OAuth client id and secret first (see google.oauth), then connect a Google account and map a GA4 property.',
            ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
            null,
          ),
    clientFacing: {
      capability: 'site-traffic',
      label: 'Site traffic',
      description: 'Sessions, users and channels from Google Analytics 4.',
      clientAction: 'Connect your Google Analytics account, then choose the property for this project.',
      produces: ['Sessions', 'Users', 'Channels', 'Top pages'],
    },
  },

  // ── Journey execution (live probes across every data source) ─────────
  {
    key: 'journey.execute',
    label: 'Journey execution (live probe run)',
    category: 'analytics',
    taskKinds: [],
    actions: ['journey.execute'],
    outputs: ['journey-steps', 'surface-answers', 'analytics-readings'],
    supports: ['dataforseo', 'perplexity', 'anthropic', 'search-console', 'analytics'],
    prerequisites: [],
    limits: {
      maxCostPerRunEnvVar: 'JOURNEY_MAX_COST_PER_RUN',
      llmModelEnvVar: 'JOURNEY_LLM_MODEL',
      analyticsFlagEnvVar: 'GA4_PROPERTY_ID',
      searchConsoleFlagEnvVar: 'GSC_SITE_URL',
    },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const vars = [
        'SWARM_ALLOW_LIVE',
        'DATAFORSEO_LOGIN',
        'DATAFORSEO_PASSWORD',
        'PERPLEXITY_API_KEY',
        'JOURNEY_MAX_COST_PER_RUN',
      ];
      // Journey executes steps against live providers, so it is behind the
      // same master switch as every other paid collection path.
      if (env.get('SWARM_ALLOW_LIVE') !== '1') {
        return probe(
          false,
          false,
          'master-switch-off',
          'Set SWARM_ALLOW_LIVE=1 to execute journeys against live providers. Until then a journey can be planned ' +
            'but not run.',
          vars,
          null,
        );
      }
      if (!env.has('DATAFORSEO_LOGIN') || !env.has('DATAFORSEO_PASSWORD')) {
        return probe(
          false,
          false,
          'credential-missing',
          'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD — the SERP-seeking steps of a journey run through them.',
          vars,
          null,
        );
      }
      const optional = [
        env.has('PERPLEXITY_API_KEY') ? 'Perplexity surface' : null,
        // These two only mark the integration as available in the journey
        // suggestion wheel; the property itself comes from the connected
        // Google account, not from env.
        env.has('GA4_PROPERTY_ID') ? 'GA4 flag' : null,
        env.has('GSC_SITE_URL') ? 'Search Console flag' : null,
      ].filter((s): s is string => s !== null);
      return probe(
        true,
        false,
        null,
        'Live journey execution is permitted. It becomes usable once a journey has actually executed.',
        vars,
        optional.length > 0
          ? `Also present: ${optional.join(', ')}.`
          : 'No AI-surface or Google integration flags are set, so journey steps will skip those sources with a stated reason.',
      );
    },
    clientFacing: null,
  },

  // ── Site health ──────────────────────────────────────────────────────
  {
    key: 'site-health.psi',
    label: 'PageSpeed Insights (Core Web Vitals)',
    category: 'site-health',
    taskKinds: ['technical-audit'],
    actions: ['site-health.cwv'],
    outputs: ['core-web-vitals', 'lighthouse-scores'],
    supports: ['psi'],
    prerequisites: [],
    limits: { freeTierRequestsPerDay: 25_000 },
    projectResource: 'domain',
    perUserAuthorization: false,
    probe: (env) =>
      env.has('PSI_API_KEY')
        ? probe(
            true,
            false,
            null,
            'The PSI key is set. It becomes usable once a check has succeeded.',
            ['PSI_API_KEY'],
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set PSI_API_KEY (free tier, 25,000 requests/day). Without it the Core Web Vitals check fails and every other audit check still runs.',
            ['PSI_API_KEY'],
            null,
          ),
    clientFacing: {
      capability: 'site-speed',
      label: 'Site speed',
      description: 'Core Web Vitals and Lighthouse scores for your site.',
      clientAction: null,
      produces: ['Core Web Vitals', 'Lighthouse scores'],
    },
  },

  // ── Social ───────────────────────────────────────────────────────────
  {
    key: 'presence.apify',
    label: 'Apify (social activity)',
    category: 'social',
    taskKinds: ['presence', 'mentions'],
    actions: ['social.pull'],
    outputs: ['posting-cadence', 'followers', 'engagement'],
    supports: ['apify'],
    prerequisites: [],
    limits: {
      platformsEnvVar: 'APIFY_PLATFORMS',
      postsPerPlatformEnvVar: 'APIFY_POSTS_PER_PLATFORM',
      actorsEnvVar: 'APIFY_ACTORS',
      requiresConfirmSpend: true,
    },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('APIFY_API_KEY')
        ? probe(
            true,
            false,
            null,
            'Configured. Every pull still requires confirmSpend: true on the request — configuring the key is not enough to spend the account credit.',
            ['APIFY_API_KEY', 'APIFY_PLATFORMS', 'APIFY_POSTS_PER_PLATFORM'],
            `Platforms: ${env.get('APIFY_PLATFORMS', 'linkedin,instagram,facebook,twitter')}.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set APIFY_API_KEY to pull social activity. The account carries a monthly usage credit, so pulls are separately gated behind confirmSpend.',
            ['APIFY_API_KEY'],
            null,
          ),
    clientFacing: {
      capability: 'social-activity',
      label: 'Social activity',
      description: 'Posting cadence, follower counts and engagement on your public social profiles.',
      clientAction: null,
      produces: ['Posting cadence', 'Followers', 'Engagement'],
    },
  },

  // ── Content ──────────────────────────────────────────────────────────
  {
    key: 'content.agent-readiness',
    label: 'Agent-readiness scan (is-agentic CLI)',
    category: 'content',
    taskKinds: ['technical-audit'],
    actions: ['content.agent-readiness'],
    outputs: ['agent-readiness-report'],
    supports: ['is-agentic'],
    prerequisites: [],
    limits: { timeoutMsEnvVar: 'AGENT_READINESS_TIMEOUT_MS' },
    projectResource: 'domain',
    perUserAuthorization: false,
    probe: (env) =>
      env.get('AGENT_READINESS_CLI', 'true') !== 'false'
        ? probe(
            true,
            false,
            null,
            'Enabled by default. It publishes a public report page at is-agentic.com/scan/<domain> — set AGENT_READINESS_CLI=false to disable the scan entirely.',
            ['AGENT_READINESS_CLI', 'AGENT_READINESS_TIMEOUT_MS'],
            'Spawns `npx is-agentic <domain> --json`, which needs npm network egress.',
          )
        : probe(
            false,
            false,
            null,
            'Disabled with AGENT_READINESS_CLI=false. Stored reports are still read; no new scan runs.',
            ['AGENT_READINESS_CLI'],
            null,
          ),
    clientFacing: null,
  },

  // ── Publishing ───────────────────────────────────────────────────────
  {
    key: 'publishing.custom-webhook',
    label: 'Publishing destinations (customer-configured webhooks)',
    category: 'content',
    taskKinds: [],
    actions: ['publish.release'],
    outputs: ['published-url', 'delivery-attempt'],
    supports: ['custom-webhook'],
    prerequisites: [],
    limits: { credentialEnvPrefix: 'PUBLISH_CREDENTIAL_', schedulerEnabledEnvVar: 'PUBLISHING_SCHEDULER_ENABLED' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const prefix = 'PUBLISH_CREDENTIAL_';
      const configured = env.list(prefix);
      const schedulerOn = env.get('PUBLISHING_SCHEDULER_ENABLED', 'true') !== 'false';
      if (!schedulerOn) {
        return probe(
          false,
          false,
          'master-switch-off',
          'PUBLISHING_SCHEDULER_ENABLED=false — scheduled publication dispatch is off, so nothing publishes on a ' +
            'schedule. Manual release still resolves credentials the same way.',
          ['PUBLISHING_SCHEDULER_ENABLED', `${prefix}<SLUG>`],
          null,
        );
      }
      if (configured.length === 0) {
        return probe(
          false,
          false,
          'credential-missing',
          `No destination credential is set. Each destination's credentialRef resolves to ${prefix}<UPPER_SNAKE_SLUG> ` +
            '(e.g. "acme-wordpress" → PUBLISH_CREDENTIAL_ACME_WORDPRESS) — a release to a destination with no ' +
            'resolvable credential is refused rather than attempted.',
          ['PUBLISHING_SCHEDULER_ENABLED', `${prefix}<SLUG>`],
          null,
        );
      }
      return probe(
        true,
        false,
        null,
        'At least one destination credential resolves. It becomes usable once a release has actually succeeded.',
        ['PUBLISHING_SCHEDULER_ENABLED', ...configured],
        // Names only, never values: these are the resolved var names an
        // operator has to match against their destinations.
        `Configured destination credentials: ${configured.join(', ')}.`,
      );
    },
    clientFacing: null,
  },

  // ── Email ────────────────────────────────────────────────────────────
  {
    key: 'email.plunk',
    label: 'Plunk (transactional email)',
    category: 'email',
    taskKinds: ['report'],
    actions: ['email.send'],
    outputs: ['email-delivery'],
    supports: ['plunk'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('PLUNK_SECRET_KEY')
        ? probe(
            true,
            false,
            null,
            'Plunk is configured and report delivery emails can send. It becomes usable once a send has succeeded.',
            ['PLUNK_SECRET_KEY'],
            'The secret key is used server-side only; the public key is not read by this backend.',
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set PLUNK_SECRET_KEY to send report-delivery and notification emails. Nothing is sent without it, and nothing pretends to be.',
            ['PLUNK_SECRET_KEY'],
            null,
          ),
    clientFacing: null,
  },

  // ── Billing ──────────────────────────────────────────────────────────
  {
    key: 'billing.stripe-links',
    label: 'Stripe Checkout links',
    category: 'billing',
    taskKinds: [],
    actions: [],
    outputs: ['checkout-link'],
    supports: ['stripe'],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('STRIPE_CHECKOUT_URL_FULL') || env.has('STRIPE_CHECKOUT_URL_MONITORING')
        ? probe(
            true,
            false,
            null,
            'Checkout links are configured and can be issued. This is a link ledger, not a verified payment integration — G16 replaces it.',
            ['STRIPE_CHECKOUT_URL_FULL', 'STRIPE_CHECKOUT_URL_MONITORING'],
            null,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set STRIPE_CHECKOUT_URL_FULL / _MONITORING to issue upgrade checkout links.',
            ['STRIPE_CHECKOUT_URL_FULL', 'STRIPE_CHECKOUT_URL_MONITORING'],
            null,
          ),
    clientFacing: null,
  },

  {
    key: 'billing.stripe-webhooks',
    label: 'Stripe webhook verification (signed payment events)',
    category: 'billing',
    taskKinds: [],
    actions: [],
    outputs: ['payment-events', 'entitlements'],
    supports: ['stripe'],
    prerequisites: [],
    limits: { toleranceSecondsEnvVar: 'STRIPE_WEBHOOK_TOLERANCE_SECONDS' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('STRIPE_WEBHOOK_SECRET')
        ? probe(
            true,
            false,
            null,
            'Signed webhook deliveries can be verified. It becomes usable once a delivery has actually been accepted.',
            ['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_TOLERANCE_SECONDS'],
            'Replay and forgery are refused by HMAC verification; a delivery is never trusted on its payload alone.',
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set STRIPE_WEBHOOK_SECRET. Without it every delivery is refused and recorded as rejected rather than ' +
              'accepted unverified — an unverified payment event is never treated as a payment.',
            ['STRIPE_WEBHOOK_SECRET'],
            null,
          ),
    clientFacing: null,
  },
  {
    key: 'billing.public-intake',
    label: 'Public diagnostic intake (challenge-protected)',
    category: 'billing',
    taskKinds: ['diagnostic-request'],
    actions: [],
    outputs: ['diagnostic-request'],
    supports: ['cailyx'],
    prerequisites: [],
    limits: { challengeBitsEnvVar: 'PUBLIC_INTAKE_CHALLENGE_BITS', publicSwitchEnvVar: 'SCORECARD_PUBLIC' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const vars = ['PUBLIC_INTAKE_CHALLENGE_SECRET', 'PUBLIC_INTAKE_CHALLENGE_BITS', 'SCORECARD_PUBLIC'];
      if (!env.has('PUBLIC_INTAKE_CHALLENGE_SECRET')) {
        return probe(
          false,
          false,
          'credential-missing',
          'Set PUBLIC_INTAKE_CHALLENGE_SECRET. Unset, the public intake is closed rather than accepting ' +
            'unverified submissions — the endpoint is operator-only until this is configured.',
          vars,
          null,
        );
      }
      return probe(
        true,
        false,
        null,
        env.get('SCORECARD_PUBLIC') === '1'
          ? 'The public intake is open and submissions are challenge-verified. It becomes usable once a request has actually been accepted.'
          : 'The challenge secret is set, but SCORECARD_PUBLIC is not 1 — the public funnel stays closed.',
        vars,
        `Proof-of-work difficulty: ${env.get('PUBLIC_INTAKE_CHALLENGE_BITS', '16')} bits.`,
      );
    },
    clientFacing: null,
  },

  // ── Infrastructure and mode ──────────────────────────────────────────
  {
    key: 'infra.redis',
    label: 'Redis (queue, cache, scheduling)',
    category: 'infrastructure',
    taskKinds: ['technical-audit', 'seo-audit', 'aeo-audit', 'presence'],
    actions: ['infra.queue'],
    outputs: [],
    supports: ['redis'],
    prerequisites: [],
    limits: { schedulingBackendEnvVar: 'SCHEDULING_BACKEND' },
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) =>
      env.has('REDIS_URL')
        ? probe(
            true,
            false,
            null,
            'Redis is configured. Reachability is a runtime fact, not a config one — it is recorded here once a queue operation has actually succeeded.',
            ['REDIS_URL', 'SCHEDULING_BACKEND'],
            `Scheduling backend: ${env.get('SCHEDULING_BACKEND', 'cron')}.`,
          )
        : probe(
            false,
            false,
            'credential-missing',
            'Set REDIS_URL. Without Redis the audit pipelines cannot be queued; in-process cron still runs recurring work.',
            ['REDIS_URL'],
            null,
          ),
    clientFacing: null,
  },
  {
    key: 'scorecard.public',
    label: 'Public scorecard and diagnostic funnel',
    category: 'mode',
    taskKinds: [],
    actions: [],
    outputs: ['public-scorecard', 'lead-capture'],
    supports: [],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const on = env.get('SCORECARD_PUBLIC') === '1';
      return on
        ? probe(
            true,
            false,
            null,
            'The public scorecard and its lead capture are open. Submissions still go through the intake challenge.',
            ['SCORECARD_PUBLIC', 'PUBLIC_INTAKE_CHALLENGE_SECRET'],
            null,
          )
        : probe(
            false,
            false,
            'master-switch-off',
            'Off by design: the scorecard is operator-only until SCORECARD_PUBLIC=1. Set it when the funnel should ' +
              'be reachable by anyone with the link.',
            ['SCORECARD_PUBLIC'],
            null,
          );
    },
    clientFacing: null,
  },
  {
    key: 'swarm.live',
    label: 'Swarm live mode',
    category: 'mode',
    taskKinds: [],
    actions: [],
    outputs: [],
    supports: [],
    prerequisites: [],
    limits: {},
    projectResource: null,
    perUserAuthorization: false,
    probe: (env) => {
      const on = env.get('SWARM_ALLOW_LIVE') === '1';
      return on
        ? probe(
            true,
            false,
            null,
            'SWARM_ALLOW_LIVE=1 — journeys, campaigns, SERP capture, keyword research, backlinks and business-data lookups may spend on live providers.',
            ['SWARM_ALLOW_LIVE'],
            null,
          )
        : probe(
            true,
            false,
            null,
            'Off. Live spend is blocked and the affected modules run on deterministic adapters, or skip with a stated reason.',
            ['SWARM_ALLOW_LIVE'],
            'Reporting "configured" because the switch is present and off by design — the off state is not a misconfiguration.',
          );
    },
    clientFacing: null,
  },
];

/** Lookup by key. */
export function findCapability(key: string): CapabilityDefinition | undefined {
  return CAPABILITY_REGISTRY.find((c) => c.key === key);
}

export { MOCK_DISCLOSURE };

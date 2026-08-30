/**
 * Suggestion wheel — a deterministic, layered set of buyer search queries for a
 * project: awareness stage → theme → query, where each query carries the buyer
 * PAIN POINT it maps to and the SUGGESTION Cailyx would make. Feeds the frontend
 * Flywheel card (an answerthepublic-style radial). No LLM, no spend.
 *
 * @module journey.suggestions
 */

import type { PersonaAwareness } from '../persona/persona.types';

export type SuggestionSource = 'template' | 'persona' | 'journey';

export interface SuggestionLeaf {
  text: string;
  source: SuggestionSource;
  /** the buyer frustration this query maps to */
  painPoint: string;
  /** what Cailyx recommends doing about it */
  suggestion: string;
}

export interface SuggestionTheme {
  label: string;
  queries: SuggestionLeaf[];
}

export interface SuggestionStage {
  key: PersonaAwareness;
  label: string;
  themes: SuggestionTheme[];
}

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  stages: SuggestionStage[];
  total: number;
  generatedAt: string;
}

const STAGES: PersonaAwareness[] = ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'];
const STAGE_LABEL: Record<PersonaAwareness, string> = {
  'problem-aware': 'Problem aware',
  'solution-aware': 'Solution aware',
  'product-aware': 'Product aware',
  'most-aware': 'Most aware',
};

interface LibEntry {
  theme: string;
  query: string;
  painPoint: string;
  suggestion: string;
}

/** The content library. `{cat}` = category, `{brand}` = client, `{comp}` = a competitor. */
const LIBRARY: Record<PersonaAwareness, LibEntry[]> = {
  'problem-aware': [
    {
      theme: 'Is this a real problem',
      query: 'is {cat} actually a problem worth solving for a company like mine',
      painPoint: 'Not convinced AI visibility affects pipeline yet.',
      suggestion: 'Run a measurement baseline (n≥5 prompts per surface) so the gap is a real number, not a hunch.',
    },
    {
      theme: 'Is this a real problem',
      query: 'what is {cat}',
      painPoint: 'Team uses AEO / GEO loosely with no shared definition.',
      suggestion: 'Publish a one-page internal primer anchored to your own category and buyers.',
    },
    {
      theme: 'Cost of inaction',
      query: 'what happens if we ignore {cat} for another year',
      painPoint: 'Hard to justify budget without a downside story.',
      suggestion: 'Model branded-search decline + AI-referral share to show the trajectory of doing nothing.',
    },
    {
      theme: 'How teams approach it',
      query: 'how do teams usually approach {cat}',
      painPoint: 'No playbook — reinventing the approach from scratch.',
      suggestion: 'Adopt the fix → build → influence roadmap the gap-analysis produces.',
    },
    {
      theme: 'How teams approach it',
      query: 'best ways to measure {cat}',
      painPoint: 'Rank trackers say one thing, AI answers say another.',
      suggestion: 'Measure mention rate and citation rate across surfaces, not positions.',
    },
  ],
  'solution-aware': [
    {
      theme: 'Compare approaches',
      query: 'compare the main approaches to {cat}',
      painPoint: 'Agency vs in-house vs tool — trade-offs are unclear.',
      suggestion: 'Score each on time-to-value and operator hours per week, not feature lists.',
    },
    {
      theme: 'Compare approaches',
      query: 'aeo vs seo for {cat}',
      painPoint: 'The team treats AEO as just more SEO.',
      suggestion: 'Separate the metrics: AI mention + citation rate are a different scoreboard from rankings.',
    },
    {
      theme: 'Evaluation criteria',
      query: 'what should I look for in a {cat} tool',
      painPoint: 'Every vendor demo sounds identical.',
      suggestion: 'Demand the measurement methodology and a row-level observation export.',
    },
    {
      theme: 'Named options',
      query: 'best {cat} tools in 2026',
      painPoint: 'The shortlist keeps changing.',
      suggestion: 'Track your own share of voice against the named set over time.',
    },
    {
      theme: 'Named options',
      query: '{brand} vs {comp} for {cat}',
      painPoint: 'Not sure how {brand} differs from {comp}.',
      suggestion: 'Ask both the same 5 buyer prompts and compare what the AI answers actually cite.',
    },
  ],
  'product-aware': [
    {
      theme: 'Head to head',
      query: '{brand} vs {comp}: which is better for my goal',
      painPoint: 'Can’t separate real differentiation from marketing.',
      suggestion: 'Run a side-by-side measurement on your prompt set; the citations decide it.',
    },
    {
      theme: 'Fit & value',
      query: 'is {brand} worth it for a company at our stage',
      painPoint: 'Might be over- or under-scoped for us.',
      suggestion: 'Start at the free Rung-0 scorecard; upgrade only on a named, specific finding.',
    },
    {
      theme: 'Fit & value',
      query: 'how do I get started with {brand}',
      painPoint: 'Unclear what the first two weeks look like.',
      suggestion: 'Week 1: query set + baseline. Week 2: technical audit + the top 3 findings.',
    },
    {
      theme: 'Objections',
      query: 'is this just seo with a new name',
      painPoint: 'Skeptical that AI visibility is a real category.',
      suggestion: 'Show a finding SEO tools miss — a silent CDN block or a hallucinated 404.',
    },
    {
      theme: 'Objections',
      query: 'can i not just do this myself with prompting',
      painPoint: 'Thinks a weekend of manual prompting is enough.',
      suggestion: 'Contrast one manual pass with n≥5 sampled runs across surfaces and geos.',
    },
  ],
  'most-aware': [
    {
      theme: 'Getting started',
      query: 'fastest way to get value from {brand}',
      painPoint: 'Needs a visible win quickly.',
      suggestion: 'Ship the technical-audit fixes first — they move machine-access before anything else.',
    },
    {
      theme: 'Pricing',
      query: '{brand} pricing and what is included',
      painPoint: 'Fixed-fee sprint vs retainer is confusing.',
      suggestion: 'Frame it: a sprint buys one outcome, a retainer buys ongoing operating.',
    },
    {
      theme: 'Onboarding',
      query: 'what does onboarding with {brand} look like',
      painPoint: 'Worried about the internal lift on their team.',
      suggestion: 'One operator owns delivery; your team only reviews between calls.',
    },
    {
      theme: 'Onboarding',
      query: 'how do i know the numbers are real',
      painPoint: 'Been burned by vanity metrics before.',
      suggestion: 'Every claim carries a sample size and an A/B/C evidence grade — check the claims log.',
    },
  ],
};

function fill(t: string, ctx: { category: string; brand: string; competitor: string }): string {
  return t
    .replace(/\{cat\}/g, ctx.category)
    .replace(/\{brand\}/g, ctx.brand)
    .replace(/\{comp\}/g, ctx.competitor)
    .trim();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** rough stage bucket for a free-text query (persona vocab / real journey step). */
function bucketStage(q: string): PersonaAwareness {
  const s = q.toLowerCase();
  if (/\bpricing|onboard|get started|getting started|how to start|fastest way\b/.test(s)) return 'most-aware';
  if (/\bvs\b|review|worth it|is .* worth|which is better|alternative/.test(s)) return 'product-aware';
  if (/\bbest\b|compare|top \d|approaches|tool|how to solve|how do teams/.test(s)) return 'solution-aware';
  return 'problem-aware';
}

export interface SuggestionInputs {
  project: { name: string; domain: string; category: string | null; competitors: string | null };
  personas: Array<{ awareness: string; vocabulary: string }>;
  journeySteps: Array<{ awareness: string; query: string }>;
}

/** Build the layered wheel. Deterministic for a given project + personas + journeys. */
export function buildSuggestionWheel(input: SuggestionInputs): SuggestionWheel {
  const competitors = parseJsonList(input.project.competitors).map((c) =>
    typeof c === 'string' ? c : (c as { name?: string })?.name ?? '',
  );
  const ctx = {
    category: input.project.category?.trim() || 'this category',
    brand: input.project.name,
    competitor: competitors.find((c) => c.length > 1) || 'the incumbent tool',
  };

  const stages: SuggestionStage[] = STAGES.map((stageKey) => {
    // group the library entries for this stage by theme
    const byTheme = new Map<string, SuggestionLeaf[]>();
    const seen = new Set<string>();
    const add = (theme: string, leaf: SuggestionLeaf) => {
      if (!leaf.text || leaf.text.length < 3 || seen.has(norm(leaf.text))) return;
      seen.add(norm(leaf.text));
      const arr = byTheme.get(theme) ?? [];
      arr.push(leaf);
      byTheme.set(theme, arr);
    };

    // real journey queries first (highest signal) — attach to a "From your journeys" theme
    for (const s of input.journeySteps) {
      if (bucketStage(s.query) !== stageKey && (s.awareness as PersonaAwareness) !== stageKey) continue;
      add('From your journeys', {
        text: s.query.trim(),
        source: 'journey',
        painPoint: 'A real buyer search your simulated journeys already ran.',
        suggestion: 'Check whether you are mentioned / cited for it, then plan a branch from it.',
      });
    }

    // persona vocabulary
    for (const p of input.personas) {
      if ((p.awareness as PersonaAwareness) !== stageKey) continue;
      for (const v of parseStrList(p.vocabulary).slice(0, 4)) {
        add('From your personas', {
          text: v,
          source: 'persona',
          painPoint: 'A phrase a target persona types into a search box.',
          suggestion: 'Make sure a page answers it in the first 40–60 words (BLUF).',
        });
      }
    }

    // the library
    for (const e of LIBRARY[stageKey]) {
      add(e.theme, {
        text: fill(e.query, ctx),
        source: 'template',
        painPoint: fill(e.painPoint, ctx),
        suggestion: fill(e.suggestion, ctx),
      });
    }

    const themes: SuggestionTheme[] = [...byTheme.entries()]
      .map(([label, queries]) => ({ label, queries: queries.slice(0, 6) }))
      .filter((t) => t.queries.length > 0);

    return { key: stageKey, label: STAGE_LABEL[stageKey], themes };
  });

  return {
    hub: { label: input.project.name, domain: input.project.domain, category: ctx.category },
    stages,
    total: stages.reduce((n, s) => n + s.themes.reduce((m, t) => m + t.queries.length, 0), 0),
    generatedAt: new Date().toISOString(),
  };
}

function parseJsonList(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function parseStrList(raw: string | null): string[] {
  return parseJsonList(raw).filter((x): x is string => typeof x === 'string');
}

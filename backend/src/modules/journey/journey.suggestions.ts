/**
 * Suggestion wheel — a deterministic set of buyer search queries for a project,
 * grouped by awareness stage. Feeds the frontend Flywheel card (an
 * answerthepublic-style radial). Built from the journey planner's query
 * templates + the project's personas + any queries real journeys already
 * produced. No LLM.
 *
 * @module journey.suggestions
 */

import { FOLLOWUPS, OPENERS } from './journey.planner';
import type { PersonaAwareness } from '../persona/persona.types';

export type SuggestionSource = 'template' | 'persona' | 'journey';

export interface SuggestionSpoke {
  key: PersonaAwareness;
  label: string;
  queries: Array<{ text: string; source: SuggestionSource }>;
}

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  spokes: SuggestionSpoke[];
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

const PER_SPOKE = 7;

function fill(t: string, ctx: { category: string; brand: string; competitor: string }, vocab: string, objection: string): string {
  return t
    .replace(/\{cat\}/g, ctx.category)
    .replace(/\{brand\}/g, ctx.brand)
    .replace(/\{comp\}/g, ctx.competitor)
    .replace(/\{goal\}/g, 'this')
    .replace(/\{vocab\}/g, vocab)
    .replace(/\{objection\}/g, objection)
    .trim();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface SuggestionInputs {
  project: { name: string; domain: string; category: string | null; competitors: string | null };
  personas: Array<{ awareness: string; vocabulary: string; objections: string }>;
  journeySteps: Array<{ awareness: string; query: string }>;
}

/** Build the wheel. Deterministic for a given project + persona + journey set. */
export function buildSuggestionWheel(input: SuggestionInputs): SuggestionWheel {
  const competitors = parseJsonList(input.project.competitors).map((c) =>
    typeof c === 'string' ? c : (c as { name?: string })?.name ?? '',
  );
  const ctx = {
    category: input.project.category?.trim() || 'this category',
    brand: input.project.name,
    competitor: competitors.find((c) => c.length > 1) || 'the incumbent tool',
  };

  // persona vocabulary + objections bucketed by the persona's awareness
  const personaByStage = new Map<PersonaAwareness, { vocab: string[]; objections: string[] }>();
  for (const p of input.personas) {
    const stage = STAGES.includes(p.awareness as PersonaAwareness) ? (p.awareness as PersonaAwareness) : 'solution-aware';
    const b = personaByStage.get(stage) ?? { vocab: [], objections: [] };
    b.vocab.push(...parseStrList(p.vocabulary));
    b.objections.push(...parseStrList(p.objections));
    personaByStage.set(stage, b);
  }

  // real journey queries bucketed by step awareness
  const journeyByStage = new Map<PersonaAwareness, string[]>();
  for (const s of input.journeySteps) {
    const stage = STAGES.includes(s.awareness as PersonaAwareness) ? (s.awareness as PersonaAwareness) : 'solution-aware';
    const arr = journeyByStage.get(stage) ?? [];
    if (s.query && s.query.trim()) arr.push(s.query.trim());
    journeyByStage.set(stage, arr);
  }

  const spokes: SuggestionSpoke[] = STAGES.map((stage) => {
    const seen = new Set<string>();
    const out: Array<{ text: string; source: SuggestionSource }> = [];
    const push = (text: string, source: SuggestionSource) => {
      const t = text.replace(/^\{vocab\}$/, '').trim();
      if (!t || t.length < 3 || seen.has(norm(t))) return;
      seen.add(norm(t));
      out.push({ text: t, source });
    };

    // 1) real journey queries first (highest signal)
    for (const q of (journeyByStage.get(stage) ?? []).slice(0, PER_SPOKE)) push(q, 'journey');

    // 2) persona vocabulary
    const pv = personaByStage.get(stage);
    for (const v of (pv?.vocab ?? []).slice(0, PER_SPOKE)) push(v, 'persona');

    // 3) planner templates (openers + follow-ups), filled
    const objection = (pv?.objections ?? [])[0] ?? 'how do I know this is worth it';
    for (const tpl of OPENERS[stage]) push(fill(tpl, ctx, ctx.category, objection), 'template');
    for (const frame of FOLLOWUPS[stage]) push(fill(frame.query, ctx, ctx.category, objection), 'template');

    return { key: stage, label: STAGE_LABEL[stage], queries: out.slice(0, PER_SPOKE) };
  });

  return {
    hub: { label: input.project.name, domain: input.project.domain, category: ctx.category },
    spokes,
    total: spokes.reduce((n, s) => n + s.queries.length, 0),
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

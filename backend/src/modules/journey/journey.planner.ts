/**
 * Journey Planner — deterministic branching search-journey builder (Agent #2).
 *
 * Given a persona + project context, emits a tree of realistic search steps:
 * an opening query, then depth-wise follow-ups that (a) advance the persona's
 * awareness toward "most-aware" and (b) get more specific — category → brand vs
 * competitor → pricing / getting-started. Seeded by the persona's own seed, so
 * the same persona always produces the same journey.
 *
 * This is a real planner, not a stub. The optional LLM planner in
 * `journey.service` only substitutes a richer tree of the same shape.
 *
 * @module journey.planner
 */

import { rngFromSeed, seededPick } from '../../common/utils/prng';
import { JOURNEY_LIMITS } from './journey.types';
import type { JourneyPlan, JourneyStepKind, PlannedStep } from './journey.types';
import type { PersonaAwareness } from '../persona/persona.types';

/** Awareness ladder — a follow-up may advance one rung or hold. */
const AWARENESS_LADDER: readonly PersonaAwareness[] = [
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

/** Persona fields the planner needs. */
export interface PlannerPersona {
  id: string;
  label: string;
  role: string;
  awareness: PersonaAwareness;
  primaryGoal: string;
  researchObjective: string;
  vocabulary: string[];
  objections: string[];
  seed: string | null;
}

export interface PlannerContext {
  category: string;
  brand: string;
  /** First competitor name, or a neutral stand-in. */
  competitor: string;
}

interface QueryFrame {
  kind: JourneyStepKind;
  query: string;
  rationale: string;
  /** awareness rung delta: 0 hold, 1 advance. */
  advance: 0 | 1;
}

/** Candidate follow-ups for a given awareness rung. The planner picks up to
 * `maxBranches` of these per node, seeded. `{cat}/{brand}/{comp}/{goal}` fill. */
const FOLLOWUPS: Record<PersonaAwareness, QueryFrame[]> = {
  'problem-aware': [
    { kind: 'refinement', advance: 0, query: 'is {cat} actually a problem worth solving for a company like mine', rationale: 'Pressure-tests whether the problem is real before spending time.' },
    { kind: 'branch', advance: 0, query: 'what happens if we ignore {cat} for another year', rationale: 'Explores the cost of doing nothing.' },
    { kind: 'refinement', advance: 1, query: 'how do teams usually approach {cat}', rationale: 'Moves from "is this real" to "how is it solved".' },
    { kind: 'branch', advance: 1, query: 'best ways to measure {cat}', rationale: 'Looks for a concrete handle on the problem.' },
  ],
  'solution-aware': [
    { kind: 'comparison', advance: 0, query: 'compare the main approaches to {cat}', rationale: 'Weighs approach categories against each other.' },
    { kind: 'refinement', advance: 0, query: 'what should I look for in a {cat} tool', rationale: 'Builds evaluation criteria.' },
    { kind: 'branch', advance: 1, query: 'best {cat} tools in 2026', rationale: 'Shifts from approach to named products.' },
    { kind: 'comparison', advance: 1, query: '{brand} vs {comp} for {cat}', rationale: 'Names the shortlist explicitly.' },
  ],
  'product-aware': [
    { kind: 'comparison', advance: 0, query: '{brand} vs {comp}: which is better for {goal}', rationale: 'Direct head-to-head on the persona goal.' },
    { kind: 'refinement', advance: 0, query: 'is {brand} worth it for a company at our stage', rationale: 'Fit and value check.' },
    { kind: 'objection', advance: 0, query: '{objection}', rationale: "Runs the persona's own objection as a query." },
    { kind: 'branch', advance: 1, query: 'how do I get started with {brand}', rationale: 'Advances toward action.' },
  ],
  'most-aware': [
    { kind: 'refinement', advance: 0, query: 'fastest way to get value from {brand}', rationale: 'Time-to-value focus.' },
    { kind: 'objection', advance: 0, query: '{objection}', rationale: 'Last-mile objection before committing.' },
    { kind: 'branch', advance: 0, query: '{brand} pricing and what is included', rationale: 'Commercial detail.' },
    { kind: 'refinement', advance: 0, query: 'what does onboarding with {brand} look like', rationale: 'Reduces perceived switching cost.' },
  ],
};

const OPENERS: Record<PersonaAwareness, string[]> = {
  'problem-aware': ['{vocab}', 'why is {cat} hard', 'what is {cat}'],
  'solution-aware': ['{vocab}', 'how to solve {cat}', 'approaches to {cat}'],
  'product-aware': ['{vocab}', 'best {cat} tools', '{brand} review'],
  'most-aware': ['{vocab}', 'how to start with {brand}', '{brand} pricing'],
};

function fill(t: string, ctx: PlannerContext, p: PlannerPersona, objection: string, vocab: string): string {
  return t
    .replace(/\{cat\}/g, ctx.category)
    .replace(/\{brand\}/g, ctx.brand)
    .replace(/\{comp\}/g, ctx.competitor)
    .replace(/\{goal\}/g, p.primaryGoal.toLowerCase())
    .replace(/\{objection\}/g, objection)
    .replace(/\{vocab\}/g, vocab);
}

function rungIndex(a: PersonaAwareness): number {
  return Math.max(0, AWARENESS_LADDER.indexOf(a));
}

/**
 * Build a deterministic branching journey for one persona.
 *
 * @param persona  Persona to walk (its `seed` drives every random choice).
 * @param ctx      Project context (category / brand / competitor).
 * @param opts     `maxDepth` (1-6) and `maxBranches` (1-4); step count is hard-capped.
 */
export function planJourney(
  persona: PlannerPersona,
  ctx: PlannerContext,
  opts: { maxDepth: number; maxBranches: number },
): JourneyPlan {
  const maxDepth = Math.min(Math.max(opts.maxDepth, JOURNEY_LIMITS.maxDepth.min), JOURNEY_LIMITS.maxDepth.max);
  const maxBranches = Math.min(
    Math.max(opts.maxBranches, JOURNEY_LIMITS.maxBranches.min),
    JOURNEY_LIMITS.maxBranches.max,
  );
  const seedBase = persona.seed || `${persona.id}:journey`;
  const objections = persona.objections.length > 0 ? persona.objections : ['how do I know this is worth it'];
  const vocab = persona.vocabulary.length > 0 ? persona.vocabulary : [persona.researchObjective];

  const steps: PlannedStep[] = [];
  let counter = 0;
  const nextId = () => `s${counter++}`;

  // ── root ────────────────────────────────────────────────────
  const rootRng = rngFromSeed(`${seedBase}:root`);
  const openerTpl = seededPick(OPENERS[persona.awareness], rootRng);
  const rootQuery = fill(openerTpl, ctx, persona, seededPick(objections, rootRng), seededPick(vocab, rootRng));
  const root: PlannedStep = {
    localId: nextId(),
    parentLocalId: null,
    depth: 0,
    ordinal: 0,
    kind: 'query',
    awareness: persona.awareness,
    query: rootQuery,
    rationale: `Opening search for a ${persona.role} whose objective is: ${persona.researchObjective}`,
  };
  steps.push(root);

  // ── breadth-first expansion ────────────────────────────────
  const frontier: PlannedStep[] = [root];
  while (frontier.length > 0) {
    if (steps.length >= JOURNEY_LIMITS.maxStepsPerJourney) break;
    const node = frontier.shift() as PlannedStep;
    if (node.depth >= maxDepth) continue;
    if (node.awareness === 'most-aware' && node.depth >= 2) continue; // most-aware leaves end quickly

    const rng = rngFromSeed(`${seedBase}:${node.localId}`);
    const pool = [...FOLLOWUPS[node.awareness]];
    const branches = Math.min(maxBranches, pool.length);
    for (let i = 0; i < branches; i++) {
      if (steps.length >= JOURNEY_LIMITS.maxStepsPerJourney) break;
      const frame = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      const childAwareness =
        frame.advance === 1
          ? AWARENESS_LADDER[Math.min(rungIndex(node.awareness) + 1, AWARENESS_LADDER.length - 1)]
          : node.awareness;
      const objection = seededPick(objections, rng);
      const child: PlannedStep = {
        localId: nextId(),
        parentLocalId: node.localId,
        depth: node.depth + 1,
        ordinal: i,
        kind: frame.kind,
        awareness: childAwareness,
        query: fill(frame.query, ctx, persona, objection, seededPick(vocab, rng)),
        rationale: frame.rationale
          .replace(/\{cat\}/g, ctx.category)
          .replace(/\{brand\}/g, ctx.brand),
      };
      steps.push(child);
      frontier.push(child);
    }
  }

  return {
    label: `${persona.label} — ${persona.awareness} journey`,
    objective: persona.researchObjective,
    source: 'deterministic',
    model: null,
    steps,
  };
}

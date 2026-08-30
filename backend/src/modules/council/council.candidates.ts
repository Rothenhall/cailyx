/**
 * Council candidate builder — turns existing artefacts into a de-duplicated set
 * of candidate interventions for the debate. Reads only; proposes no new work
 * to measure.
 *
 * @module council.candidates
 */

import { COUNCIL_LIMITS } from './council.types';
import type { Candidate } from './council.types';

/** gap-analysis dimension → council dimension. */
const GAP_DIM: Record<string, Candidate['dimension']> = {
  visibility: 'machine-access',
  narrative: 'entity-clarity',
  topic: 'extractability',
  format: 'extractability',
  'web-mentions': 'authority',
  demand: 'authority',
};

const EFFORT_BY_DIM: Record<Candidate['dimension'], Candidate['effort']> = {
  'machine-access': 'medium',
  extractability: 'medium',
  authority: 'high',
  'entity-clarity': 'low',
  narrative: 'medium',
  architecture: 'low',
};

export interface ArtefactBundle {
  gaps: Array<{ id: string; dimension: string; title: string; status: string; priorityScore: number | null }>;
  linkGraph: { id: string; orphanCount: number; recommendationCount: number } | null;
  journeys: { completed: number; executedSteps: number; mentionedSteps: number; citedSteps: number };
  measurement: { runId: string; observations: number; mentionRate: number; citationRate: number } | null;
  technicalFailures: Array<{ id: string; type: string }>;
  entitySchemaFailures: number;
}

/** Merge helper — collapse candidates by key, unioning refs + widening breadth. */
function upsert(map: Map<string, Candidate>, c: Candidate): void {
  const existing = map.get(c.key);
  if (!existing) {
    map.set(c.key, c);
    return;
  }
  const refs = Array.from(new Set([...existing.sourceRefs, ...c.sourceRefs]));
  map.set(c.key, {
    ...existing,
    sourceRefs: refs,
    evidenceBreadth: Math.max(existing.evidenceBreadth, c.evidenceBreadth) + 1,
  });
}

/**
 * Build the candidate list. Returns `{ candidates, evidenceRefs }` where
 * `evidenceRefs` records which artefacts were in scope.
 */
export function buildCandidates(b: ArtefactBundle): {
  candidates: Candidate[];
  evidenceRefs: Record<string, unknown>;
} {
  const map = new Map<string, Candidate>();

  // 1) open gap-analysis rows
  for (const g of b.gaps) {
    if (g.status !== 'open') continue;
    const dim = GAP_DIM[g.dimension] ?? 'narrative';
    upsert(map, {
      key: `gap:${g.dimension}`,
      title: g.title || `Close ${g.dimension} gaps`,
      dimension: dim,
      sourceRefs: [`gap:${g.id}`],
      evidenceBreadth: 1,
      effort: EFFORT_BY_DIM[dim],
    });
  }

  // 2) internal-link architecture
  if (b.linkGraph && (b.linkGraph.orphanCount > 0 || b.linkGraph.recommendationCount > 0)) {
    upsert(map, {
      key: 'architecture:internal-links',
      title: `Fix internal linking (${b.linkGraph.orphanCount} orphan(s), ${b.linkGraph.recommendationCount} suggested link(s))`,
      dimension: 'architecture',
      sourceRefs: [`linkGraph:${b.linkGraph.id}`],
      evidenceBreadth: 1,
      effort: 'low',
    });
  }

  // 3) journeys — low mention / citation rates across simulated buyer journeys
  if (b.journeys.completed > 0 && b.journeys.executedSteps > 0) {
    const mRate = b.journeys.mentionedSteps / b.journeys.executedSteps;
    const cRate = b.journeys.citedSteps / b.journeys.executedSteps;
    if (mRate < 0.5) {
      upsert(map, {
        key: 'authority:earn-mentions',
        title: `Raise brand mention rate in AI answers (journeys: ${(mRate * 100).toFixed(0)}%)`,
        dimension: 'authority',
        sourceRefs: [`journeys:${b.journeys.completed}`],
        evidenceBreadth: 1,
        effort: 'high',
      });
    }
    if (cRate < 0.35) {
      upsert(map, {
        key: 'extractability:answer-structure',
        title: `Make pages more citable (journeys cite rate: ${(cRate * 100).toFixed(0)}%)`,
        dimension: 'extractability',
        sourceRefs: [`journeys:${b.journeys.completed}`],
        evidenceBreadth: 1,
        effort: 'medium',
      });
    }
  }

  // 4) measurement moat — same levers, independent evidence
  if (b.measurement && b.measurement.observations > 0) {
    if (b.measurement.mentionRate < 0.5) {
      upsert(map, {
        key: 'authority:earn-mentions',
        title: 'Raise brand mention rate in AI answers',
        dimension: 'authority',
        sourceRefs: [`measurementRun:${b.measurement.runId}`],
        evidenceBreadth: 1,
        effort: 'high',
      });
    }
    if (b.measurement.citationRate < 0.35) {
      upsert(map, {
        key: 'extractability:answer-structure',
        title: 'Make pages more citable',
        dimension: 'extractability',
        sourceRefs: [`measurementRun:${b.measurement.runId}`],
        evidenceBreadth: 1,
        effort: 'medium',
      });
    }
  }

  // 5) technical-audit hard failures
  for (const f of b.technicalFailures.slice(0, 6)) {
    upsert(map, {
      key: `machine-access:${f.type}`,
      title: `Fix technical blocker: ${f.type}`,
      dimension: 'machine-access',
      sourceRefs: [`auditFinding:${f.id}`],
      evidenceBreadth: 1,
      effort: 'medium',
    });
  }

  // 6) entity-audit schema failures
  if (b.entitySchemaFailures > 0) {
    upsert(map, {
      key: 'entity-clarity:schema',
      title: `Fix entity schema (${b.entitySchemaFailures} failing check(s))`,
      dimension: 'entity-clarity',
      sourceRefs: [`entitySchemaFailures:${b.entitySchemaFailures}`],
      evidenceBreadth: 1,
      effort: 'low',
    });
  }

  const candidates = [...map.values()]
    .sort((a, b2) => b2.evidenceBreadth - a.evidenceBreadth || a.key.localeCompare(b2.key))
    .slice(0, COUNCIL_LIMITS.maxCandidates);

  return {
    candidates,
    evidenceRefs: {
      gaps: b.gaps.length,
      linkGraph: b.linkGraph?.id ?? null,
      journeysCompleted: b.journeys.completed,
      measurementRun: b.measurement?.runId ?? null,
      technicalFailures: b.technicalFailures.length,
      entitySchemaFailures: b.entitySchemaFailures,
    },
  };
}

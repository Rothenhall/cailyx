/**
 * Council Engine — deterministic multi-agent debate + synthesis.
 *
 * Pure functions: given a set of candidate interventions (already derived from
 * real artefacts), each role-agent votes with a rule-based bias, then a
 * synthesizer aggregates votes into a ranked list with a recorded dissent.
 * Deterministic — same candidates → same debate → same ranking.
 *
 * @module council.engine
 */

import { AGENT_ROLES } from './council.types';
import type {
  AgentContribution,
  AgentPosition,
  AgentRole,
  Candidate,
  RankedIntervention,
  Vote,
} from './council.types';

/** Which dimensions each role champions / is wary of. */
const ROLE_BIAS: Record<
  AgentRole,
  { champions: Candidate['dimension'][]; wary: Candidate['dimension'][]; voice: string }
> = {
  technical: {
    champions: ['machine-access', 'architecture'],
    wary: ['narrative'],
    voice: 'If crawlers can’t read it or the architecture leaks authority, nothing else matters.',
  },
  content: {
    champions: ['extractability', 'architecture'],
    wary: ['machine-access'],
    voice: 'Answer engines cite what they can extract — structure and clarity move the needle.',
  },
  authority: {
    champions: ['authority'],
    wary: ['machine-access'],
    voice: 'Models recommend brands they’ve seen vouched for elsewhere. Earn the mentions.',
  },
  measurement: {
    champions: [],
    wary: [],
    voice: 'Back the levers with the most independent evidence; discount the thinly-supported ones.',
  },
  narrative: {
    champions: ['entity-clarity', 'narrative'],
    wary: ['architecture'],
    voice: 'If the AI can’t say who you are and why you’re different, presence doesn’t convert.',
  },
  skeptic: {
    champions: [],
    wary: ['narrative', 'authority'],
    voice: 'Prefer cheap, well-evidenced fixes. Be suspicious of high-effort bets on weak signals.',
  },
};

function voteFor(
  role: AgentRole,
  c: Candidate,
): { vote: Vote; weight: number; rationale: string } {
  const bias = ROLE_BIAS[role];

  if (role === 'measurement') {
    if (c.evidenceBreadth >= 2) {
      return { vote: 'for', weight: 0.8, rationale: `${c.evidenceBreadth} independent artefact types back this.` };
    }
    return { vote: 'against', weight: 0.5, rationale: 'Only one artefact points here — too thin to prioritise yet.' };
  }
  if (role === 'skeptic') {
    if (c.effort === 'high' && c.evidenceBreadth < 2) {
      return { vote: 'against', weight: 0.7, rationale: 'High effort on a single weak signal — not now.' };
    }
    if (c.effort === 'low') {
      return { vote: 'for', weight: 0.6, rationale: 'Cheap enough to just do.' };
    }
    return { vote: 'conditional', weight: 0.4, rationale: 'Fine if it’s scoped tightly and measured after.' };
  }

  if (bias.champions.includes(c.dimension)) {
    return { vote: 'for', weight: 0.9, rationale: `${role} lever: ${bias.voice}` };
  }
  if (bias.wary.includes(c.dimension)) {
    return { vote: 'conditional', weight: 0.35, rationale: `Not ${role}'s first priority, but not opposed.` };
  }
  return { vote: 'conditional', weight: 0.5, rationale: `Supportive if it doesn’t crowd out ${bias.champions[0] ?? 'core'} work.` };
}

/** One agent's contribution for one round. */
function agentContribution(role: AgentRole, round: number, candidates: Candidate[], priorTally?: Map<string, number>): AgentContribution {
  const positions: AgentPosition[] = candidates.map((c) => {
    const base = voteFor(role, c);
    // Round 2+: the skeptic concedes on items with strong prior consensus.
    if (round >= 2 && role === 'skeptic' && priorTally && (priorTally.get(c.key) ?? 0) >= 0.6 && base.vote !== 'for') {
      return { interventionKey: c.key, vote: 'for', weight: 0.55, rationale: 'Consensus is strong enough; withdrawing my objection.' };
    }
    return { interventionKey: c.key, ...base };
  });
  const forKeys = positions.filter((p) => p.vote === 'for').map((p) => p.interventionKey);
  const summary =
    `${ROLE_BIAS[role].voice} ` +
    (forKeys.length
      ? `Backing: ${forKeys.slice(0, 4).join(', ')}${forKeys.length > 4 ? ' …' : ''}.`
      : 'No strong backing this round.');
  return { round, agentRole: role, summary, positions };
}

/** Run the full deterministic debate. */
export function runDebate(
  candidates: Candidate[],
  roles: AgentRole[],
  rounds: number,
): { contributions: AgentContribution[]; rankings: RankedIntervention[] } {
  const activeRoles = roles.length > 0 ? roles : [...AGENT_ROLES];
  const contributions: AgentContribution[] = [];
  let tally = new Map<string, number>();

  for (let round = 1; round <= rounds; round++) {
    const roundContribs = activeRoles.map((r) => agentContribution(r, round, candidates, tally));
    contributions.push(...roundContribs);
    tally = tallyConsensus(candidates, roundContribs);
  }

  // Synthesis uses the final round's contributions.
  const finalRound = Math.max(...contributions.map((c) => c.round));
  const finalContribs = contributions.filter((c) => c.round === finalRound);
  const rankings = synthesize(candidates, finalContribs);
  return { contributions, rankings };
}

function tallyConsensus(candidates: Candidate[], contribs: AgentContribution[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of candidates) {
    let forW = 0;
    let total = 0;
    for (const contrib of contribs) {
      const p = contrib.positions.find((x) => x.interventionKey === c.key);
      if (!p) continue;
      total += p.weight;
      if (p.vote === 'for') forW += p.weight;
      else if (p.vote === 'conditional') forW += p.weight * 0.4;
    }
    m.set(c.key, total > 0 ? forW / total : 0);
  }
  return m;
}

function synthesize(candidates: Candidate[], contribs: AgentContribution[]): RankedIntervention[] {
  const consensus = tallyConsensus(candidates, contribs);
  const effortImpact: Record<Candidate['dimension'], number> = {
    'machine-access': 85,
    extractability: 70,
    authority: 65,
    'entity-clarity': 60,
    architecture: 55,
    narrative: 50,
  };

  const ranked = candidates
    .map((c) => {
      const cons = Number((consensus.get(c.key) ?? 0).toFixed(4));
      const expectedImpact = Math.round(
        Math.min(100, effortImpact[c.dimension] + c.evidenceBreadth * 6),
      );
      const dissenting = contribs
        .flatMap((ct) => ct.positions.filter((p) => p.interventionKey === c.key && p.vote !== 'for').map((p) => ({ role: ct.agentRole, p })))
        .sort((a, b) => b.p.weight - a.p.weight)[0];
      const confidence: RankedIntervention['confidence'] =
        cons >= 0.66 && c.evidenceBreadth >= 2 ? 'high' : cons >= 0.4 ? 'medium' : 'low';
      return {
        interventionKey: c.key,
        title: c.title,
        rationale:
          `${Math.round(cons * 100)}% weighted agreement across ${contribs.length} agents; ` +
          `${c.evidenceBreadth} artefact type(s) back it; dimension = ${c.dimension}.`,
        consensus: cons,
        expectedImpact,
        effort: c.effort,
        confidence,
        sourceRefs: c.sourceRefs,
        dissent: dissenting ? `${dissenting.role}: ${dissenting.p.rationale}` : null,
        _score: cons * expectedImpact,
      };
    })
    .sort((a, b) => b._score - a._score || a.interventionKey.localeCompare(b.interventionKey))
    .map(({ _score, ...r }, i) => {
      void _score;
      return { rank: i + 1, ...r } as RankedIntervention;
    });

  return ranked;
}

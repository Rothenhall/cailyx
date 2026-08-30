/**
 * Suggestion wheel — a deterministic, layered set of buyer search queries for a
 * project (awareness stage → theme → query), plus a list of concrete AEO/GEO
 * BOOSTS the site should ship. Everything is derived from the project's own
 * data: category, competitors, personas (vocabulary / objections / triggers),
 * real journey queries, the latest technical audit, link graph and authority
 * scan. No LLM, no spend — the same inputs always produce the same wheel.
 *
 * Feeds the frontend Flywheel card.
 *
 * @module journey.suggestions
 */

import { hashString } from '../../common/utils/prng';
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

/** Lane a boost belongs to — mirrors how an AEO/GEO engagement is organised. */
export type BoostLane = 'AEO' | 'GEO' | 'Content' | 'Technical' | 'Authority' | 'Measurement';

/** One concrete, site-specific thing to do to improve answer-engine visibility. */
export interface SuggestionBoost {
  id: string;
  lane: BoostLane;
  title: string;
  /** why it matters for THIS site */
  why: string;
  /** the action to take */
  action: string;
  /** where the recommendation came from (a real artefact, or "Best practice") */
  evidence: string;
  effort: 'quick' | 'project';
}

export interface SuggestionWheel {
  hub: { label: string; domain: string; category: string };
  stages: SuggestionStage[];
  boosts: SuggestionBoost[];
  total: number;
  boostCount: number;
  generatedAt: string;
}

/* ── inputs ──────────────────────────────────────────────────── */

export interface SuggestionInputs {
  project: { name: string; domain: string; category: string | null; competitors: string | null };
  personas: Array<{
    awareness: string;
    role?: string | null;
    seniority?: string | null;
    companyStage?: string | null;
    primaryGoal?: string | null;
    painPoints?: string | null;
    buyingTriggers?: string | null;
    objections?: string | null;
    vocabulary?: string | null;
  }>;
  journeySteps: Array<{ awareness: string; query: string; status?: string | null }>;
  /** latest technical audit findings (optional) */
  auditFindings?: Array<{ type: string; status: string; severity: string; detail: string; recommendedFix: string }>;
  /** top internal-link recommendations (optional) */
  linkRecs?: Array<{ fromPath: string; toPath: string; suggestedAnchor: string; reason: string; priority: number }>;
  /** orphan pages from the link graph (optional) */
  orphanPages?: Array<{ path: string; title?: string | null }>;
  /** a caveat recorded on the latest link graph (e.g. JS-rendered nav) */
  linkGraphNote?: string | null;
  /** authority discovery candidates (optional) */
  authorityCandidates?: Array<{ domain: string; type: string; rationale: string; relevance: number }>;
  /** integration connectivity flags that matter for measurement (optional) */
  integrations?: { aiSurface: boolean; serp: boolean; analytics: boolean };
}

/* ── stage scaffold ──────────────────────────────────────────── */

const STAGES: PersonaAwareness[] = ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'];
const STAGE_LABEL: Record<PersonaAwareness, string> = {
  'problem-aware': 'Problem aware',
  'solution-aware': 'Solution aware',
  'product-aware': 'Product aware',
  'most-aware': 'Most aware',
};

interface ThemeTemplate {
  label: string;
  pain: string;
  fix: string;
  queries: string[];
}

/**
 * Per-stage theme templates. Slots: {brand} {domain} {cat} {comp1} {comp2}
 * {role} {stage}. Lines that reference {comp2} are dropped when the project has
 * fewer than two competitors; {comp1} falls back to "the incumbent".
 */
const TEMPLATES: Record<PersonaAwareness, ThemeTemplate[]> = {
  'problem-aware': [
    {
      label: 'Symptoms',
      pain: 'They can see the brand is thin in AI answers but have no number for it.',
      fix: 'Run a measurement baseline (n≥5 prompts per surface) so "invisible in AI" becomes a tracked rate.',
      queries: [
        "why isn't {brand} showing up in chatgpt answers",
        'does chatgpt know about {brand}',
        'is {domain} cited in google ai overviews',
        'how to check if perplexity mentions {brand}',
      ],
    },
    {
      label: 'Is this worth attention',
      pain: 'Not convinced AEO/GEO affects pipeline for a company at their stage.',
      fix: 'Model branded-search decline + AI-referral share to show the trajectory of doing nothing.',
      queries: [
        'is {cat} a real problem for a {role}',
        'how much pipeline now comes from ai search',
        'what happens if we ignore {cat} for another year',
        'does aeo matter for {stage} companies',
      ],
    },
    {
      label: 'Cost of inaction',
      pain: 'Hard to justify budget without a downside story.',
      fix: 'Track AI answer share of voice against the named competitor set so the gap has a size.',
      queries: [
        'branded search declining what it means',
        'ai answers sending less traffic to our site',
        'competitors getting cited by ai and we are not',
      ],
    },
  ],
  'solution-aware': [
    {
      label: 'AEO vs SEO',
      pain: 'The team treats AEO/GEO as just more SEO and measures it with rank trackers.',
      fix: 'Separate the scoreboards: AI mention rate + citation rate are not rankings.',
      queries: [
        'aeo vs seo for {cat}',
        'geo vs seo which matters more',
        'is answer engine optimization just seo with a new name',
        'do i need aeo and seo or just one',
      ],
    },
    {
      label: 'How to measure',
      pain: 'Rank trackers say one thing, AI answers say another — no shared metric.',
      fix: 'Measure mention rate and citation rate across surfaces with a fixed prompt set.',
      queries: [
        'how to measure {cat}',
        'how to track brand mentions in ai answers',
        'citation rate vs ranking position',
        'tools to monitor chatgpt and perplexity mentions',
      ],
    },
    {
      label: 'How to get cited',
      pain: 'No playbook for actually earning a citation in an AI answer.',
      fix: 'Ship BLUF answers + FAQ/HowTo structured data on the pages that map to top buyer questions.',
      queries: [
        'how to get cited by chatgpt',
        'how to show up in perplexity answers',
        'how to rank in google ai overviews',
        'structured data for answer engines',
      ],
    },
    {
      label: 'Approaches',
      pain: 'Agency vs in-house vs tool — trade-offs are unclear.',
      fix: 'Score each on time-to-value and operator hours per week, not feature lists.',
      queries: [
        '{cat} agency vs in-house vs tool',
        'best {cat} tools in 2026',
        'how do teams approach {cat}',
      ],
    },
  ],
  'product-aware': [
    {
      label: 'Head to head',
      pain: "Can't separate real differentiation from marketing between the named options.",
      fix: 'Ask every tool the same 5 buyer prompts; the citations in the answers decide it.',
      queries: [
        '{brand} vs {comp1}',
        '{brand} vs {comp2}',
        '{comp1} vs {comp2} for {cat}',
        '{brand} alternatives',
      ],
    },
    {
      label: 'Proof it works',
      pain: 'Needs evidence the approach moves a real metric, not a vanity one.',
      fix: 'Show a before/after on citation rate for a comparable account with sample sizes attached.',
      queries: [
        'does {brand} actually improve citation rate',
        '{brand} case studies for {cat}',
        'how long until {brand} shows results',
      ],
    },
    {
      label: 'Fit & value',
      pain: 'Might be over- or under-scoped for a company their size.',
      fix: 'Start at the free Rung-0 scorecard; upgrade only on a named, specific finding.',
      queries: [
        'is {brand} worth it for a {role}',
        'is {brand} right for a {stage} company',
        'how do i get started with {brand}',
      ],
    },
  ],
  'most-aware': [
    {
      label: 'Pricing & scope',
      pain: 'Fixed-fee sprint vs retainer is confusing.',
      fix: 'Frame it: a sprint buys one outcome, a retainer buys ongoing operating.',
      queries: [
        '{brand} pricing',
        '{brand} sprint vs retainer',
        'what is included in {brand}',
      ],
    },
    {
      label: 'Onboarding',
      pain: 'Worried about the internal lift on their own team.',
      fix: 'One operator owns delivery; the client team only reviews between calls.',
      queries: [
        'what does onboarding with {brand} look like',
        'how much work is {brand} for my team',
        'how do i know {brand} numbers are real',
      ],
    },
    {
      label: 'Getting value fast',
      pain: 'Needs a visible win quickly.',
      fix: 'Ship the technical-audit fixes first — they move machine access before anything else.',
      queries: [
        'fastest way to get value from {brand}',
        '{brand} first 30 days',
      ],
    },
  ],
};

/* ── helpers ─────────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const STOP = new Set(['and', 'or', 'for', 'the', 'a', 'an', 'of', 'to', 'with', '&', 'in', 'on']);

function catShort(category: string | null): string {
  const raw = (category ?? '').trim();
  if (!raw) return 'this category';
  const toks = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t && !STOP.has(t));
  if (toks.length === 0) return raw.toLowerCase();
  return toks.slice(0, 4).join(' ');
}

function readableRole(role: string | null | undefined): string {
  if (!role) return 'growth lead';
  return role.replace(/-/g, ' ');
}
function readableStage(stage: string | null | undefined): string {
  if (!stage) return 'growth-stage';
  return stage.replace(/-/g, ' ');
}

function parseJsonList(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function parseStrList(raw: string | null | undefined): string[] {
  return parseJsonList(raw)
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Signals {
  brand: string;
  domain: string;
  cat: string;
  comp1: string;
  comp2: string | null;
  role: string;
  stage: string;
}

function deriveSignals(input: SuggestionInputs): Signals {
  const competitors = parseJsonList(input.project.competitors)
    .map((c) => (typeof c === 'string' ? c : (c as { name?: string })?.name ?? ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  // the most common persona role / stage wins (deterministic — first in a
  // stable count order)
  const tally = (vals: Array<string | null | undefined>) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  };

  return {
    brand: input.project.name.trim(),
    domain: input.project.domain.trim(),
    cat: catShort(input.project.category),
    comp1: competitors[0] ?? 'the incumbent',
    comp2: competitors[1] ?? null,
    role: readableRole(tally(input.personas.map((p) => p.role))),
    stage: readableStage(tally(input.personas.map((p) => p.companyStage))),
  };
}

function fill(t: string, s: Signals): string | null {
  if (/\{comp2\}/.test(t) && !s.comp2) return null;
  const out = t
    .replace(/\{brand\}/g, s.brand.toLowerCase())
    .replace(/\{domain\}/g, s.domain)
    .replace(/\{cat\}/g, s.cat)
    .replace(/\{comp1\}/g, s.comp1.toLowerCase())
    .replace(/\{comp2\}/g, (s.comp2 ?? '').toLowerCase())
    .replace(/\{role\}/g, s.role)
    .replace(/\{stage\}/g, s.stage)
    .replace(/\s+/g, ' ')
    .trim();
  return out.length >= 3 ? out : null;
}

/** rough stage bucket for a free-text query (persona vocab / real journey step). */
function bucketStage(q: string): PersonaAwareness {
  const s = q.toLowerCase();
  if (/\bpricing|onboard|get started|getting started|how to start|fastest way\b/.test(s)) return 'most-aware';
  if (/\bvs\b|review|worth it|is .* worth|which is better|alternative/.test(s)) return 'product-aware';
  if (/\bbest\b|compare|top \d|approaches|tool|how to solve|how do teams|how to measure|how to get/.test(s))
    return 'solution-aware';
  return 'problem-aware';
}

/* ── stages ──────────────────────────────────────────────────── */

function buildStages(input: SuggestionInputs, sig: Signals): SuggestionStage[] {
  return STAGES.map((stageKey) => {
    const byTheme = new Map<string, SuggestionLeaf[]>();
    const order: string[] = [];
    const seen = new Set<string>();
    const add = (theme: string, leaf: SuggestionLeaf) => {
      if (!leaf.text || leaf.text.length < 3 || seen.has(norm(leaf.text))) return;
      seen.add(norm(leaf.text));
      if (!byTheme.has(theme)) {
        byTheme.set(theme, []);
        order.push(theme);
      }
      byTheme.get(theme)!.push(leaf);
    };

    // 1) personalised templates
    for (const tpl of TEMPLATES[stageKey]) {
      for (const q of tpl.queries) {
        const text = fill(q, sig);
        if (text) add(tpl.label, { text, source: 'template', painPoint: tpl.pain, suggestion: tpl.fix });
      }
    }

    // 2) real persona vocabulary (problem/solution stages) — actual phrases
    let pv = 0;
    for (const p of input.personas) {
      if (pv >= 4) break;
      const words = parseStrList(p.vocabulary);
      for (const v of words.slice(0, 2)) {
        if (pv >= 4) break;
        if (bucketStage(v) !== stageKey && (p.awareness as PersonaAwareness) !== stageKey) continue;
        add('Your personas search', {
          text: v.toLowerCase(),
          source: 'persona',
          painPoint: 'A phrase a target persona types into a search box.',
          suggestion: 'Make sure a page answers it in the first 40–60 words (BLUF), then earn a citation for it.',
        });
        pv++;
      }
    }

    // 3) real persona objections → most-aware queries
    if (stageKey === 'most-aware') {
      let on = 0;
      for (const p of input.personas) {
        if (on >= 4) break;
        for (const obj of parseStrList(p.objections).slice(0, 2)) {
          if (on >= 4) break;
          const q = obj.replace(/[?.!]+$/, '').toLowerCase();
          add('Objections your buyers raise', {
            text: q,
            source: 'persona',
            painPoint: obj,
            suggestion:
              'Publish a short page that names this objection and rebuts it head-on, so AI answers cite your framing, not a competitor’s.',
          });
          on++;
        }
      }
    }

    // 4) real persona buying triggers → product/most-aware
    if (stageKey === 'product-aware' || stageKey === 'most-aware') {
      let bn = 0;
      for (const p of input.personas) {
        if (bn >= 3) break;
        for (const trg of parseStrList(p.buyingTriggers).slice(0, 2)) {
          if (bn >= 3) break;
          add('What triggers a buy', {
            text: trg.replace(/[?.!]+$/, '').toLowerCase(),
            source: 'persona',
            painPoint: 'The event that turns a passive reader into an active buyer.',
            suggestion: 'Have a page ready for the moment this trigger fires — it is a high-intent entry point.',
          });
          bn++;
        }
      }
    }

    // 5) real journey queries — capped
    let jn = 0;
    for (const s of input.journeySteps) {
      if (jn >= 4) break;
      if (bucketStage(s.query) !== stageKey && (s.awareness as PersonaAwareness) !== stageKey) continue;
      add('Your journeys ran', {
        text: s.query.trim().toLowerCase(),
        source: 'journey',
        painPoint: 'A real buyer search your simulated journeys already walked.',
        suggestion: 'Check whether you are mentioned / cited for it, then branch a new journey from the gap.',
      });
      jn++;
    }

    const themes: SuggestionTheme[] = order
      .map((label) => ({ label, queries: (byTheme.get(label) ?? []).slice(0, 6) }))
      .filter((t) => t.queries.length > 0)
      .slice(0, 6);

    return { key: stageKey, label: STAGE_LABEL[stageKey], themes };
  });
}

/* ── boosts (the AEO/GEO to-do list) ─────────────────────────── */

const bid = (parts: string[]) => `b_${(hashString(parts.join('|')) >>> 0).toString(36)}`;
const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/**
 * Audit finding `detail` / `recommendedFix` can be a raw error blob (JSON,
 * box-drawing, stack noise). Pull out the human sentence and flatten it.
 */
function cleanDetail(raw: string): string {
  let s = (raw ?? '').trim();
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') {
      s = (j as { error: string }).error;
    }
  } catch {
    /* not JSON — keep as-is */
  }
  s = s
    .replace(/[╔╗╚╝║═╭╮╰╯│─]+/g, ' ')
    .replace(/<3 Playwright Team/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(s, 150);
}

/** friendly titles for the known technical-audit finding types */
const FINDING_TITLE: Record<string, string> = {
  cwv: 'Core Web Vitals',
  'js-render': 'JavaScript rendering',
  robots: 'Robots / crawl access',
  'cdn-inferred': 'CDN bot access',
  schema: 'Structured data',
  'entity-clarity': 'Entity clarity',
  sitemap: 'XML sitemap',
  canonical: 'Canonical tags',
};
const findingTitle = (t: string) =>
  FINDING_TITLE[t.toLowerCase()] ?? t.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function buildBoosts(input: SuggestionInputs, sig: Signals): SuggestionBoost[] {
  const out: SuggestionBoost[] = [];
  const push = (b: Omit<SuggestionBoost, 'id'>, idParts: string[]) => out.push({ id: bid(idParts), ...b });

  // 1a) technical audit findings that the site actually failed / was warned on
  const failed = (input.auditFindings ?? [])
    .filter((f) => f.status.toLowerCase() === 'fail' || f.status.toLowerCase() === 'warn')
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.type.localeCompare(b.type))
    .slice(0, 4);
  for (const f of failed) {
    push(
      {
        lane: 'Technical',
        title: findingTitle(f.type),
        why: cleanDetail(f.detail),
        action: cleanDetail(f.recommendedFix),
        evidence: 'Technical audit',
        effort: f.severity === 'critical' || f.severity === 'high' ? 'project' : 'quick',
      },
      ['audit', f.type, f.detail],
    );
  }

  // 1b) audit checks that could not run — an incomplete diagnostic is itself a
  // gap worth closing, but it is not framed as a site defect.
  const errored = (input.auditFindings ?? [])
    .filter((f) => f.status.toLowerCase() === 'error')
    .sort((a, b) => a.type.localeCompare(b.type))
    .slice(0, 3);
  for (const f of errored) {
    push(
      {
        lane: 'Measurement',
        title: `Audit incomplete — ${findingTitle(f.type)} check didn't run`,
        why: `The technical audit couldn't evaluate this for ${sig.domain}: ${cleanDetail(f.detail)}`,
        action: 'Resolve the audit prerequisite, then re-run the technical audit so this check produces a real result.',
        evidence: 'Technical audit',
        effort: 'quick',
      },
      ['audit-err', f.type],
    );
  }

  // 2) internal-link recommendations (top priority)
  const recs = [...(input.linkRecs ?? [])].sort((a, b) => b.priority - a.priority).slice(0, 3);
  for (const r of recs) {
    push(
      {
        lane: 'Content',
        title: `Internal link → ${r.toPath}`,
        why: clip(r.reason),
        action: `Add a link from ${r.fromPath} to ${r.toPath} with anchor “${r.suggestedAnchor}”.`,
        evidence: 'Link graph',
        effort: 'quick',
      },
      ['linkrec', r.fromPath, r.toPath],
    );
  }

  // 2b) a degraded link-graph crawl (JS-rendered nav) — one honest boost that
  // replaces the orphan/under-linked noise it would otherwise emit
  if (input.linkGraphNote) {
    push(
      {
        lane: 'Content',
        title: 'Internal navigation is not crawlable',
        why: clip(input.linkGraphNote, 200),
        action: 'Render real <a href> navigation and cross-links in the server HTML so crawlers and AI retrievers can follow the site.',
        evidence: 'Link graph',
        effort: 'project',
      },
      ['linkgraph-note', sig.domain],
    );
  }

  // 3) orphan pages
  for (const o of (input.orphanPages ?? []).slice(0, 2)) {
    push(
      {
        lane: 'Content',
        title: `Orphan page: ${o.path}`,
        why: `${o.title ? `“${clip(o.title, 60)}” ` : ''}has no inbound internal links, so crawlers and AI retrievers may never reach it.`,
        action: `Add at least two contextual links from hub pages to ${o.path}.`,
        evidence: 'Link graph',
        effort: 'quick',
      },
      ['orphan', o.path],
    );
  }

  // 4) authority candidates — sources AI answers already cite for this category
  const cands = [...(input.authorityCandidates ?? [])]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 3);
  for (const c of cands) {
    push(
      {
        lane: 'Authority',
        title: `Earn a place on ${c.domain}`,
        why: clip(c.rationale),
        action: `Pitch a listing or contribution to ${c.domain} (${c.type}) — AI answers cite it when asked about ${sig.cat}.`,
        evidence: 'Authority scan',
        effort: 'project',
      },
      ['authority', c.domain],
    );
  }

  // 5) persona objections with no page to point at
  const objections = new Set<string>();
  for (const p of input.personas) for (const o of parseStrList(p.objections)) objections.add(o);
  for (const o of [...objections].sort().slice(0, 2)) {
    push(
      {
        lane: 'Content',
        title: `Answer the objection: “${clip(o, 70)}”`,
        why: 'A target persona raises this. With no page that addresses it head-on, AI answers will surface a competitor’s framing.',
        action: 'Publish a short, BLUF-first page (40–60 word answer up top) that names and rebuts it.',
        evidence: 'Persona',
        effort: 'quick',
      },
      ['objection', o],
    );
  }

  // 6) measurement gaps — no completed journey means nothing to improve against
  const anyDone = input.journeySteps.some((s) => s.status === 'done');
  if (!anyDone) {
    push(
      {
        lane: 'Measurement',
        title: 'Baseline your AI answer share',
        why: `No completed journey runs for ${sig.domain} yet — there is no measured mention / citation rate to improve against.`,
        action: 'Run a measurement baseline (n≥5 prompts per surface) so every later change has a number.',
        evidence: 'Journeys',
        effort: 'quick',
      },
      ['baseline', sig.domain],
    );
  }
  if (input.integrations && !input.integrations.aiSurface) {
    push(
      {
        lane: 'Measurement',
        title: 'Connect an AI answer surface',
        why: `Without an AI surface key, Cailyx cannot check whether ${sig.domain} is cited in live ChatGPT / Perplexity answers.`,
        action: 'Add ANTHROPIC_API_KEY (and optionally PERPLEXITY_API_KEY) and re-run journeys off the mock adapter.',
        evidence: 'Integrations',
        effort: 'quick',
      },
      ['integ', 'ai-surface'],
    );
  }
  if (input.integrations && !input.integrations.serp) {
    push(
      {
        lane: 'GEO',
        title: 'Connect licensed SERP data',
        why: `AI Overview presence and authority discovery for ${sig.cat} need real SERP data, not a fixture.`,
        action: 'Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD so SERP rankings and AI-Overview checks run live.',
        evidence: 'Integrations',
        effort: 'quick',
      },
      ['integ', 'serp'],
    );
  }

  // 7) two evidence-labelled best-practice baselines (clearly not per-site data)
  push(
    {
      lane: 'AEO',
      title: 'Ship FAQ + HowTo structured data on money pages',
      why: 'Answer engines lift Q&A blocks and structured markup straight into responses.',
      action: `Add FAQPage / HowTo JSON-LD to the ${sig.domain} pages that map to your top buyer questions.`,
      evidence: 'Best practice',
      effort: 'project',
    },
    ['bp', 'structured-data'],
  );
  push(
    {
      lane: 'AEO',
      title: 'Put a BLUF answer in the first 40–60 words',
      why: 'Retrieval favours a self-contained answer near the top of the page over one buried below the fold.',
      action: 'Rewrite the intro of each buyer-question page so the answer stands alone in the opening paragraph.',
      evidence: 'Best practice',
      effort: 'quick',
    },
    ['bp', 'bluf'],
  );

  // stable order: real-artefact lanes first, best-practice last
  const laneRank: Record<BoostLane, number> = { Technical: 0, Content: 1, Authority: 2, Measurement: 3, GEO: 4, AEO: 5 };
  return out
    .filter((b, i, a) => a.findIndex((x) => x.id === b.id) === i)
    .sort((a, b) => laneRank[a.lane] - laneRank[b.lane])
    .slice(0, 14);
}

function sevRank(s: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s.toLowerCase()] ?? 0;
}

/* ── entry point ─────────────────────────────────────────────── */

/** Build the layered wheel + boosts. Deterministic for a given set of inputs. */
export function buildSuggestionWheel(input: SuggestionInputs): SuggestionWheel {
  const sig = deriveSignals(input);
  const stages = buildStages(input, sig);
  const boosts = buildBoosts(input, sig);

  return {
    hub: { label: input.project.name, domain: input.project.domain, category: sig.cat },
    stages,
    boosts,
    total: stages.reduce((n, s) => n + s.themes.reduce((m, t) => m + t.queries.length, 0), 0),
    boostCount: boosts.length,
    generatedAt: new Date().toISOString(),
  };
}

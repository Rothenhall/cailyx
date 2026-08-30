/**
 * Persona Generator — deterministic synthetic-buyer builder (Agent #1).
 *
 * Given a project's context (category, brand, competitors) and an index, emits
 * a fully-formed {@link PersonaProfile}. Deterministic: the same
 * `(projectId, index, role)` always yields the same persona, so smoke tests
 * assert exact output and regenerating is idempotent per slot.
 *
 * This is a real generator, not a stub: each role carries its own goal / pain /
 * trigger / objection / vocabulary pools, and the project category + a rotating
 * competitor are interpolated in. The optional LLM refinement pass
 * (`persona.service`) only rewrites the freeform strings — never the taxonomy.
 *
 * @module persona.generator
 */

import { mulberry32, hashString, seededSample } from '../../common/utils/prng';
import type {
  PersonaAwareness,
  PersonaCompanyStage,
  PersonaGenerationContext,
  PersonaProfile,
  PersonaRole,
  PersonaSeniority,
} from './persona.types';

interface RolePreset {
  readonly seniority: PersonaSeniority;
  readonly stageBias: readonly PersonaCompanyStage[];
  /** Awareness weights, one entry per draw slot (round-robin over the array). */
  readonly awarenessCycle: readonly PersonaAwareness[];
  readonly labelForms: readonly string[];
  readonly goals: readonly string[];
  readonly painPoints: readonly string[];
  readonly buyingTriggers: readonly string[];
  readonly objections: readonly string[];
  readonly vocabulary: readonly string[];
}

/**
 * Per-role content pools. `{cat}` = project category, `{brand}` = client brand,
 * `{comp}` = a rotating competitor name (or "the incumbent tool" when none).
 */
const ROLE_PRESETS: Record<PersonaRole, RolePreset> = {
  founder: {
    seniority: 'founder',
    stageBias: ['idea', 'seed', 'series-a'],
    awarenessCycle: ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'],
    labelForms: [
      'Early-stage founder scoping {cat}',
      'Seed-stage founder comparing {cat} options',
      'Technical co-founder evaluating {cat} vs building in-house',
    ],
    goals: [
      'Decide whether {cat} is worth paying for at our stage',
      'Find the fastest path to being recommended by AI assistants',
      'Understand what {cat} actually changes for a company our size',
    ],
    painPoints: [
      'No time to run a formal evaluation',
      'Burned before by tools that were all dashboard and no outcome',
      'Board is asking why we are invisible in AI answers',
    ],
    buyingTriggers: [
      'A competitor got named in a ChatGPT answer and we did not',
      'Inbound from organic search fell off a cliff this quarter',
      'An advisor mentioned "answer engine optimization" on a call',
    ],
    objections: [
      'Is this just SEO with a new name?',
      'Can I not just do this myself with a weekend of prompting?',
      'How do I know the numbers are real and not vanity metrics?',
    ],
    vocabulary: [
      'how to show up in AI search',
      'get cited by chatgpt',
      'ai visibility for startups',
      'is aeo worth it',
    ],
  },
  cmo: {
    seniority: 'c-level',
    stageBias: ['series-a', 'growth', 'enterprise'],
    awarenessCycle: ['solution-aware', 'product-aware', 'most-aware', 'problem-aware'],
    labelForms: [
      'CMO building the {cat} business case',
      'VP Marketing comparing {cat} vendors for a pilot',
      'CMO reporting AI-channel risk to the board',
    ],
    goals: [
      'Quantify how much pipeline is exposed to AI-answer disintermediation',
      'Choose a {cat} vendor the team can operationalise, not just a report',
      'Defend the marketing budget with a defensible visibility metric',
    ],
    painPoints: [
      'Attribution is already messy; a new channel makes it worse',
      'Team is stretched and cannot absorb another tool',
      'Every vendor claims the same thing with different words',
    ],
    buyingTriggers: [
      'Quarterly business review flagged declining branded search',
      'CEO forwarded an article about AI killing SEO',
      '{comp} published a study we got compared against',
    ],
    objections: [
      'What is the measurement methodology, exactly?',
      'How is this different from {comp}?',
      'What does the team have to do every week to get value?',
    ],
    vocabulary: [
      'ai visibility platform',
      'measure brand mentions in llm answers',
      'aeo vs seo for b2b',
      'share of voice in ai search',
    ],
  },
  'head-of-growth': {
    seniority: 'director',
    stageBias: ['seed', 'series-a', 'growth'],
    awarenessCycle: ['solution-aware', 'product-aware', 'problem-aware', 'most-aware'],
    labelForms: [
      'Head of Growth running a {cat} trial',
      'Growth lead wiring {cat} into the experiment backlog',
      'Head of Growth benchmarking {cat} against {comp}',
    ],
    goals: [
      'Turn AI visibility into a channel with a testable growth loop',
      'Find where we are losing citations to {comp}',
      'Ship content changes that measurably move mention rate',
    ],
    painPoints: [
      'Cannot A/B test something I cannot measure yet',
      'Content team wants a prioritised list, not a 40-page audit',
      'No baseline for how often AI assistants recommend us',
    ],
    buyingTriggers: [
      'Set a Q-objective around AI-answer presence',
      'Noticed Perplexity sends traffic but never cites our docs',
      'A growth peer demoed their {cat} setup',
    ],
    objections: [
      'How frequently does the measurement refresh?',
      'Can I export the raw observations into our warehouse?',
      'Does it tell me what to change, or just what is wrong?',
    ],
    vocabulary: [
      'increase ai citations',
      'perplexity not citing our site',
      'growth playbook for answer engines',
      'track llm recommendations',
    ],
  },
  'seo-lead': {
    seniority: 'lead',
    stageBias: ['series-a', 'growth', 'enterprise'],
    awarenessCycle: ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'],
    labelForms: [
      'SEO lead extending the program into {cat}',
      'Organic search lead auditing AI-crawler access',
      'SEO lead comparing {cat} tooling to {comp}',
    ],
    goals: [
      'Confirm AI crawlers can actually reach and parse our site',
      'Map which queries surface us in AI Overviews vs classic SERPs',
      'Fold AEO fixes into the existing technical-SEO sprint',
    ],
    painPoints: [
      'Suspect a CDN or bot rule is silently blocking AI crawlers',
      'Rank tracking says one thing, AI answers say another',
      'Schema is inconsistent across templates',
    ],
    buyingTriggers: [
      'GSC impressions flat but AI-referral sessions appearing in analytics',
      'Core update shook rankings and leadership wants an AI answer',
      'Found GPTBot 403s in the server logs',
    ],
    objections: [
      'Does it just re-badge Screaming Frog output?',
      'How does it verify a crawler block vs a transient error?',
      'Can it track more than one AI surface?',
    ],
    vocabulary: [
      'gptbot blocked by cloudflare',
      'ai overview tracking tool',
      'schema for answer engine optimization',
      'do llms crawl javascript sites',
    ],
  },
  'content-lead': {
    seniority: 'lead',
    stageBias: ['seed', 'series-a', 'growth'],
    awarenessCycle: ['solution-aware', 'product-aware', 'problem-aware', 'most-aware'],
    labelForms: [
      'Content lead prioritising a {cat} backlog',
      'Managing editor mapping content gaps for AI answers',
      'Content lead deciding what to write to get cited',
    ],
    goals: [
      'Get a ranked list of pages to create or rewrite for citations',
      'Understand what "extractable" content actually looks like',
      'Stop guessing which topics AI assistants pull from',
    ],
    painPoints: [
      'Briefs are based on keyword tools that ignore AI answers',
      'No feedback loop between publishing and getting cited',
      'Writers ask "why this page" and I do not have a crisp answer',
    ],
    buyingTriggers: [
      'A cornerstone post stopped getting cited after a redesign',
      'Competitor content keeps showing up in Claude answers',
      'Editorial planning for next quarter starts now',
    ],
    objections: [
      'Will it generate slop, or briefs a human can use?',
      'How does it decide a page is "missing"?',
      'Does it respect our style and claims rules?',
    ],
    vocabulary: [
      'what content gets cited by ai',
      'content gap analysis for llms',
      'how to write extractable content',
      'ai answer optimization checklist',
    ],
  },
  'demand-gen': {
    seniority: 'director',
    stageBias: ['series-a', 'growth', 'enterprise'],
    awarenessCycle: ['problem-aware', 'solution-aware', 'product-aware', 'most-aware'],
    labelForms: [
      'Demand gen lead sizing AI-channel pipeline risk',
      'Demand gen manager adding {cat} to the mix',
      'Demand gen lead comparing {cat} ROI vs paid',
    ],
    goals: [
      'Model how many opportunities depend on being recommended by AI',
      'Find a channel that is not getting more expensive every quarter',
      'Prove {cat} moves a metric finance recognises',
    ],
    painPoints: [
      'CAC keeps climbing on every paid channel',
      'Hard to attribute a pipeline number to AI answers',
      'Leadership wants proof before funding a new motion',
    ],
    buyingTriggers: [
      'Paid budget got cut and organic has to make it up',
      'Noticed demo requests citing "ChatGPT recommended you"',
      'Annual planning needs a new-channel line item',
    ],
    objections: [
      'What is the path from "mention rate" to "pipeline"?',
      'How long until we see a defensible number?',
      'Is the addressable demand actually there?',
    ],
    vocabulary: [
      'ai search pipeline impact',
      'aeo roi',
      'llm recommendations to pipeline',
      'is ai search a real channel',
    ],
  },
  'saas-operator': {
    seniority: 'vp',
    stageBias: ['growth', 'enterprise'],
    awarenessCycle: ['product-aware', 'most-aware', 'solution-aware', 'problem-aware'],
    labelForms: [
      'RevOps/ops leader standardising a {cat} process',
      'SaaS operator rolling {cat} across product lines',
      'Ops leader comparing {cat} vendors on integration cost',
    ],
    goals: [
      'Make AI-visibility measurement a repeatable monthly process',
      'Integrate {cat} output into existing reporting',
      'Pick a vendor that will not create manual work',
    ],
    painPoints: [
      'Every new tool becomes someone\'s unowned side job',
      'Data lives in ten places already',
      'Need cadence and alerting, not a one-off audit',
    ],
    buyingTriggers: [
      'Standardising the marketing tech stack this half',
      'A board deck now has an "AI visibility" slide',
      'Contract renewal forced a vendor review',
    ],
    objections: [
      'Does it have an API and scheduled runs?',
      'What is the total cost at our volume?',
      'How does it handle multiple brands / domains?',
    ],
    vocabulary: [
      'ai visibility monitoring api',
      'scheduled aeo audits',
      'multi-brand ai search tracking',
      'answer engine reporting integration',
    ],
  },
  'product-marketer': {
    seniority: 'lead',
    stageBias: ['series-a', 'growth', 'enterprise'],
    awarenessCycle: ['solution-aware', 'product-aware', 'most-aware', 'problem-aware'],
    labelForms: [
      'PMM checking how AI describes our category and us',
      'Product marketer auditing entity/positioning drift in AI answers',
      'PMM comparing our AI narrative to {comp}',
    ],
    goals: [
      'Make sure AI assistants describe us accurately and in-category',
      'Catch positioning drift before sales does on a call',
      'Own the "how AI talks about us" narrative',
    ],
    painPoints: [
      'AI answers conflate us with a similarly named product',
      'Our differentiation does not survive an AI summary',
      'No system to monitor how the story degrades over time',
    ],
    buyingTriggers: [
      'Sales flagged a prospect quoting a wrong AI description',
      'A category-defining launch needs an AI-answer baseline',
      'Analyst report referenced an AI mischaracterisation',
    ],
    objections: [
      'Can it detect entity confusion, not just presence?',
      'How often does it re-check the narrative?',
      'Does it show the exact wording AI used?',
    ],
    vocabulary: [
      'how does ai describe my company',
      'entity confusion in ai answers',
      'positioning in llm responses',
      'ai got our product wrong',
    ],
  },
  'agency-owner': {
    seniority: 'founder',
    stageBias: ['seed', 'series-a', 'growth'],
    awarenessCycle: ['solution-aware', 'product-aware', 'most-aware', 'problem-aware'],
    labelForms: [
      'Agency owner evaluating {cat} to resell to clients',
      'Consultancy principal adding an AEO service line',
      'Agency owner comparing {cat} white-label options',
    ],
    goals: [
      'Add a defensible AEO offering without hiring specialists',
      'Show clients a metric that renews retainers',
      'Deliver findings clients can act on between calls',
    ],
    painPoints: [
      'Clients want AI-visibility help and we have no system',
      'Manual audits do not scale across a client book',
      'Need branded reporting, not a competitor\'s logo',
    ],
    buyingTriggers: [
      'Three clients asked about ChatGPT visibility this month',
      'Lost a pitch to an agency that had an AEO deck',
      'Retainer scope review coming up',
    ],
    objections: [
      'Is there white-label / multi-client support?',
      'What is per-client cost at scale?',
      'How much operator time per client per month?',
    ],
    vocabulary: [
      'white label ai visibility tool',
      'aeo service for agencies',
      'client reporting ai search',
      'resell answer engine optimization',
    ],
  },
  'rev-ops': {
    seniority: 'director',
    stageBias: ['growth', 'enterprise'],
    awarenessCycle: ['product-aware', 'most-aware', 'problem-aware', 'solution-aware'],
    labelForms: [
      'RevOps lead wiring {cat} data into the funnel model',
      'RevOps analyst validating {cat} measurement rigour',
      'RevOps lead comparing {cat} data exports',
    ],
    goals: [
      'Get AI-visibility signals into the same model as everything else',
      'Validate the measurement is reproducible before trusting it',
      'Attach a confidence grade to every number leadership sees',
    ],
    painPoints: [
      'Marketing brings numbers with no methodology attached',
      'One-run "rates" that are really single samples',
      'No lineage from claim back to evidence',
    ],
    buyingTriggers: [
      'Building the FY plan and need every channel modelled',
      'A QBR number could not be reproduced',
      'Data team asked for an AI-visibility source of truth',
    ],
    objections: [
      'Is the sample size disclosed on every metric?',
      'Can I get row-level observations, not just summaries?',
      'How are claims graded A/B/C?',
    ],
    vocabulary: [
      'ai visibility data export',
      'measurement methodology aeo',
      'reproducible ai search metrics',
      'evidence grading marketing claims',
    ],
  },
};

/** Interpolate `{cat}` / `{brand}` / `{comp}` into a template string. */
function fill(template: string, ctx: PersonaGenerationContext, competitor: string): string {
  return template
    .replace(/\{cat\}/g, ctx.category)
    .replace(/\{brand\}/g, ctx.brand)
    .replace(/\{comp\}/g, competitor);
}

/** Local alias — `seededSample` from the shared PRNG util. */
const sample = seededSample;

/**
 * Build one deterministic persona for `(projectId, index, role)`.
 *
 * @param role   Buyer role to instantiate.
 * @param index  Slot index within the project — part of the seed, so slot 0 is
 *               always the same persona for a given role + project.
 * @param ctx    Project context (category / brand / competitors).
 * @returns A fully-populated {@link PersonaProfile} plus its reproducibility seed.
 */
export function generatePersona(
  role: PersonaRole,
  index: number,
  ctx: PersonaGenerationContext,
): { profile: PersonaProfile; seed: string } {
  const seed = `${ctx.projectId}:${index}:${role}`;
  const rng = mulberry32(hashString(seed));
  const preset = ROLE_PRESETS[role];

  const competitors = ctx.competitors.length > 0 ? ctx.competitors : ['the incumbent tool'];
  const competitor = competitors[index % competitors.length];

  const awareness = preset.awarenessCycle[index % preset.awarenessCycle.length];
  const companyStage = preset.stageBias[Math.floor(rng() * preset.stageBias.length)];
  const label = fill(
    preset.labelForms[Math.floor(rng() * preset.labelForms.length)],
    ctx,
    competitor,
  );
  const primaryGoal = fill(preset.goals[Math.floor(rng() * preset.goals.length)], ctx, competitor);

  // The research objective is awareness-shaped so journey branching has somewhere to go.
  const objectiveByAwareness: Record<PersonaAwareness, string> = {
    'problem-aware': `Work out whether "${ctx.category}" is even a real, solvable problem worth budget`,
    'solution-aware': `Compare the main approaches to ${ctx.category} and which fits a ${companyStage} company`,
    'product-aware': `Decide between ${ctx.brand} and ${competitor} for ${ctx.category}`,
    'most-aware': `Find the fastest, lowest-risk way to get started with ${ctx.brand}`,
  };

  return {
    seed,
    profile: {
      label,
      role,
      seniority: preset.seniority,
      companyStage,
      awareness,
      primaryGoal,
      researchObjective: objectiveByAwareness[awareness],
      painPoints: sample(preset.painPoints, 3, rng).map((s) => fill(s, ctx, competitor)),
      buyingTriggers: sample(preset.buyingTriggers, 2, rng).map((s) => fill(s, ctx, competitor)),
      objections: sample(preset.objections, 3, rng).map((s) => fill(s, ctx, competitor)),
      vocabulary: sample(preset.vocabulary, 4, rng).map((s) => fill(s, ctx, competitor)),
    },
  };
}

/** Round-robin the requested roles (or the full catalogue) across `count` slots,
 * starting after `existingCount` so regeneration keeps filling new slots. */
export function planGeneration(
  count: number,
  existingCount: number,
  roles: readonly PersonaRole[],
): Array<{ role: PersonaRole; index: number }> {
  const plan: Array<{ role: PersonaRole; index: number }> = [];
  for (let i = 0; i < count; i++) {
    const index = existingCount + i;
    plan.push({ role: roles[index % roles.length], index });
  }
  return plan;
}

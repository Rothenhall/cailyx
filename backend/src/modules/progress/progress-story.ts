/**
 * Writing the progress page from a ledger — two writers, one contract.
 *
 * The template writer is deterministic and always available. The LLM writer
 * speaks as the account team (confident, specific, commercial) but may only
 * restate the ledger: {@link validateStory} rejects any output carrying a
 * number the facts did not contain, a link that is not an A/B claim, causal
 * language, agency self-naming or hype — and the caller then falls back to
 * the template, so a bad generation costs quality, never truth.
 *
 * @module progress-story
 */

import type { LlmJsonRequest } from '../aeo-audit/aeo-llm.service';
import { PAGE_CAPS, TEXT_CAPS, clip, movementText, shortDate, windowText } from './progress-format';
import type { MetricMovement, ProgressLedger, ProgressLink, ProgressStory, WorkEvidence } from './progress.types';

// ─── Ordering ───────────────────────────────────────────────────

const SCOPE_PRIORITY: Record<string, number> = { unbranded: 0, overall: 1, led: 2, citation: 3, dimension: 4, surface: 5, market: 6, competitor: 7 };

/**
 * Improvements in reading order: the cumulative (since-baseline) view when the
 * series has one — that is the "what has this engagement done" read — then
 * headline metrics before slices, larger changes first within a scope.
 */
export function rankedImprovements(ledger: ProgressLedger): MetricMovement[] {
  const inWindow = (window: MetricMovement['window']) =>
    ledger.movements
      .filter((m) => m.improvement && m.window === window)
      .sort((a, b) => SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope] || Math.abs(b.delta) - Math.abs(a.delta));
  // A gain can clear the floor against the last audit without clearing it
  // against the baseline (or the reverse) — use whichever window has one.
  const cumulative = inWindow('since-baseline');
  return cumulative.length > 0 ? cumulative : inWindow('since-previous');
}

const HEADLINE_SCOPES = new Set(['unbranded', 'overall', 'citation', 'led']);

/**
 * A/B links in reading order, one per slice.
 *
 * The headline numbers already have the page's headline and KPI tiles, so the
 * "what moved" lines lead with specific slices — a question type, an engine,
 * a rival — which is where "we targeted X and X moved" is actually specific.
 * Targeted (A) before same-period (B); each slice once, in the window the
 * page reads (cumulative when the series has one).
 */
export function rankedLinks(ledger: ProgressLedger): ProgressLink[] {
  const ranked = rankedImprovements(ledger);
  const preferredWindow = ranked[0]?.window ?? 'since-previous';
  const rank = new Map(ranked.map((m, i) => [m.id, i]));
  const candidates = ledger.links
    .filter((l) => l.grade !== 'C')
    .map((l) => ({ link: l, m: movementById(ledger, l.movementId) }))
    .sort(
      (a, b) =>
        a.link.grade.localeCompare(b.link.grade) ||
        Number(HEADLINE_SCOPES.has(a.m.scope)) - Number(HEADLINE_SCOPES.has(b.m.scope)) ||
        Number(a.m.window !== preferredWindow) - Number(b.m.window !== preferredWindow) ||
        (rank.get(a.m.id) ?? 999) - (rank.get(b.m.id) ?? 999) ||
        Math.abs(b.m.delta) - Math.abs(a.m.delta),
    );
  const seen = new Set<string>();
  const out: ProgressLink[] = [];
  for (const { link, m } of candidates) {
    const slice = `${m.scope}:${m.key ?? ''}`;
    if (seen.has(slice)) continue;
    seen.add(slice);
    out.push(link);
  }
  return out;
}

// ─── Template writer ────────────────────────────────────────────

export function templateStory(ledger: ProgressLedger): ProgressStory {
  const caps = PAGE_CAPS[ledger.layout];
  const engines = ledger.surfaceLabels.join(', ');
  const top = rankedImprovements(ledger)[0];

  const headline = top
    ? clip(`${sentenceFor(top, ledger)}${top.scope === 'competitor' || !engines ? '' : `, across ${engines}`}.`, TEXT_CAPS.headline)
    : '';

  // Work titles are listed under each line by the page itself, so the
  // sentence says what happened and how the work relates — it never quotes
  // (and never has to truncate) a title.
  const drivers = rankedLinks(ledger)
    .slice(0, caps.drivers)
    .map((link) => {
      const m = movementById(ledger, link.movementId);
      const tail =
        link.grade === 'A'
          ? ' We targeted this area directly, and the work was verified before the audit that measured the change.'
          : ` In the same period we delivered ${countWork(ledger, link)}.`;
      return { linkId: link.id, text: clip(`${sentenceFor(m, ledger)}.${tail}`, TEXT_CAPS.driver) };
    });

  const nextFocus = focusMovements(ledger)
    .slice(0, caps.nextFocus)
    .map((m) => {
      const t = movementText(m);
      return clip(`${m.label} slipped from ${t.from} to ${t.to} ${windowText(m, ledger)} — this is the next area we are working on.`, TEXT_CAPS.nextFocus);
    });

  return { headline, drivers, nextFocus };
}

function sentenceFor(m: MetricMovement, ledger: ProgressLedger): string {
  const t = movementText(m);
  const verb = m.to > m.from ? 'rose' : 'fell';
  const judged = m.unit === 'count' ? ' judged answers' : '';
  return `${m.label} ${verb} from ${t.from} to ${t.to}${judged} ${windowText(m, ledger)} (${t.change})`;
}

function countWork(ledger: ProgressLedger, link: ProgressLink): string {
  const m = movementById(ledger, link.movementId);
  const from = ledger.checkpoints.find((c) => c.auditId === m.fromAuditId)?.finishedAt ?? '';
  const n = ledger.work.filter((w) => w.completedAt > from).length || link.workIds.length;
  return `${n} piece${n === 1 ? '' : 's'} of verified work`;
}

/** Declines the page must name — mandatory disclosures first, then other slipping slices. */
export function focusMovements(ledger: ProgressLedger): MetricMovement[] {
  const disclosed = ledger.mustDisclose.map((id) => movementById(ledger, id));
  const others = ledger.movements
    .filter((m) => m.window === 'since-previous' && !m.improvement && !ledger.mustDisclose.includes(m.id))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return [...disclosed, ...others];
}

// ─── LLM writer ─────────────────────────────────────────────────

/** The facts handed to the model — preformatted, so it never computes or rounds. */
export function storyFacts(ledger: ProgressLedger) {
  const caps = PAGE_CAPS[ledger.layout];
  const links = rankedLinks(ledger);
  return {
    engines: ledger.surfaceLabels,
    markets: ledger.markets,
    auditsCompared: ledger.checkpoints.length,
    baselineDate: shortDate(ledger.checkpoints[0].finishedAt),
    thisAuditDate: shortDate(ledger.checkpoints[ledger.checkpoints.length - 1].finishedAt),
    movements: ledger.movements.map((m) => {
      const t = movementText(m);
      return {
        id: m.id,
        label: m.label,
        window: windowText(m, ledger),
        from: t.from,
        to: t.to,
        change: t.change,
        good: m.improvement,
      };
    }),
    links: links.map((l) => ({
      linkId: l.id,
      movementId: l.movementId,
      grade: l.grade,
      work: l.workIds
        .map((id) => workById(ledger, id))
        .filter((w): w is WorkEvidence => !!w)
        .map((w) => ({ title: w.title, verified: shortDate(w.completedAt) })),
    })),
    workDeliveredSinceBaseline: ledger.work.length,
    mustDisclose: ledger.mustDisclose,
    limits: {
      maxDrivers: Math.min(caps.drivers, links.length),
      maxNextFocus: caps.nextFocus,
      headlineChars: TEXT_CAPS.headline - 20,
      driverChars: TEXT_CAPS.driver - 20,
      nextFocusChars: TEXT_CAPS.nextFocus - 20,
    },
  };
}

const SYSTEM_PROMPT = `You write the progress page of a client's AI-visibility report, in the voice of the account team that did the work: confident, specific, plainly commercial. The reader should finish the page seeing exactly what improved, and which delivered work came before it.

RULES — output that breaks any of these is discarded:
1. Every number you write must appear in the input exactly as given ("33%", "+24 pts", "11 of 62", dates). Never compute, round, estimate or combine numbers.
2. Only describe changes listed in "movements". Connect work to a change only through "links". Grade A: the work was aimed at that area and verified before the audit that measured the change. Grade B: work delivered in the same period. Describe the sequence ("after", "since", "in the same period") — never say work caused, drove, led to or resulted in a change, and never say "thanks to" or "due to".
3. Speak as "we" for the team. Never name any agency, consultancy or product. The only company names you may use are competitor names already in the input.
4. Plain sentences. No exclamation marks, no emojis, no hype words (amazing, incredible, massive, huge, dramatic, skyrocketing, guaranteed).
5. Every id in "mustDisclose" is a decline that must be stated plainly in "nextFocus" with its numbers, framed as the next area of work.
6. headline: the single strongest real result, naming the engines when the change is project-wide. drivers: one per link you use, most important first, each opening with the change and then the work. nextFocus: declines first; empty when nothing declined.
7. Respect "limits". Return ONLY JSON: {"headline": "...", "drivers": [{"linkId": "...", "text": "..."}], "nextFocus": ["..."]}.`;

export function storyRequest(ledger: ProgressLedger): LlmJsonRequest {
  return {
    purpose: 'progress-story',
    maxTokens: 900,
    system: SYSTEM_PROMPT,
    user: JSON.stringify(storyFacts(ledger)),
  };
}

// ─── Output check ───────────────────────────────────────────────

const BANNED: RegExp[] = [
  /rothenhall/i,
  /cailyx/i,
  /!/,
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
  /\b(caus(e|ed|es|ing)|drove|driven by|led to|lead to|result(ed|s)? in|as a result of|thanks to|due to|because of)\b/i,
  /\b(amazing|incredible|massive|huge|dramatic(ally)?|skyrocket\w*|explosive|guarantee\w*|unprecedented)\b/i,
];

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** Explicitly signed figures ("+13", "-6", "−6"), normalised to an ASCII sign. */
function signedIn(text: string): string[] {
  return (text.match(/[+\-−]\s?\d+(?:\.\d+)?/g) ?? []).map((s) => s.replace('−', '-').replace(/\s/g, ''));
}

const RISE_WORDS = /\b(rose|risen|rising|increas\w*|grew|grown|growing|climb\w*|gain\w*|higher|up from|jump\w*)\b/i;
const FALL_WORDS = /\b(fell|fallen|falling|drop\w*|declin\w*|decreas\w*|slipp\w*|slid|lower|down from|shrank|shrunk)\b/i;

/** A sentence about `m` must not describe the opposite direction of travel. */
function directionMatches(text: string, m: MetricMovement): boolean {
  if (m.to > m.from) return !FALL_WORDS.test(text);
  if (m.to < m.from) return !RISE_WORDS.test(text);
  return true;
}

/** Does the text quote both endpoints of this movement exactly as the facts give them? */
function quotesMovement(text: string, m: MetricMovement): boolean {
  const t = movementText(m);
  const have = numbersIn(text);
  return [...numbersIn(t.from), ...numbersIn(t.to)].every((n) => have.includes(n));
}

/**
 * Coerce and check a model response. Throws with the first reason it fails —
 * the caller logs it and uses the template story instead.
 */
export function validateStory(raw: unknown, ledger: ProgressLedger): ProgressStory {
  const caps = PAGE_CAPS[ledger.layout];
  if (typeof raw !== 'object' || raw === null) throw new Error('story is not an object');
  const r = raw as { headline?: unknown; drivers?: unknown; nextFocus?: unknown };

  const facts = storyFacts(ledger);
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  // A digit match alone would pass "+6 pts" where the facts say "-6 pts".
  const allowedSigned = new Set(facts.movements.flatMap((m) => signedIn(m.change)));
  const allowedLinks = new Map(facts.links.map((l) => [l.linkId, l]));

  const checkText = (text: unknown, max: number, where: string): string => {
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${where}: empty`);
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length > max) throw new Error(`${where}: ${t.length} chars exceeds ${max}`);
    for (const re of BANNED) if (re.test(t)) throw new Error(`${where}: banned wording (${re.source})`);
    for (const n of numbersIn(t)) if (!allowed.has(n)) throw new Error(`${where}: number ${n} is not in the facts`);
    for (const s of signedIn(t)) if (!allowedSigned.has(s)) throw new Error(`${where}: signed figure ${s} is not in the facts`);
    return t;
  };

  const headline = checkText(r.headline, TEXT_CAPS.headline, 'headline');
  // The headline must be a real improvement, quoted end to end, told in its own direction.
  const headlineOk = ledger.movements.some((m) => m.improvement && quotesMovement(headline, m) && directionMatches(headline, m));
  if (!headlineOk) throw new Error('headline does not quote a real improvement in its true direction');

  if (!Array.isArray(r.drivers)) throw new Error('drivers is not an array');
  if (r.drivers.length > caps.drivers) throw new Error(`too many drivers (${r.drivers.length})`);
  const seen = new Set<string>();
  const drivers = r.drivers.map((d, i) => {
    const entry = d as { linkId?: unknown; text?: unknown };
    if (typeof entry.linkId !== 'string' || !allowedLinks.has(entry.linkId)) throw new Error(`driver ${i}: unknown linkId`);
    if (seen.has(entry.linkId)) throw new Error(`driver ${i}: duplicate linkId`);
    seen.add(entry.linkId);
    const text = checkText(entry.text, TEXT_CAPS.driver, `driver ${i}`);
    // The driver must actually be about its link's change: its end value must be quoted.
    const m = movementById(ledger, allowedLinks.get(entry.linkId)!.movementId);
    const endNumbers = numbersIn(movementText(m).to);
    if (!endNumbers.every((n) => numbersIn(text).includes(n))) throw new Error(`driver ${i}: does not quote its change`);
    if (!directionMatches(text, m)) throw new Error(`driver ${i}: describes the change in the wrong direction`);
    return { linkId: entry.linkId, text };
  });

  if (!Array.isArray(r.nextFocus)) throw new Error('nextFocus is not an array');
  if (r.nextFocus.length > caps.nextFocus) throw new Error(`too many nextFocus lines (${r.nextFocus.length})`);
  const nextFocus = r.nextFocus.map((t, i) => checkText(t, TEXT_CAPS.nextFocus, `nextFocus ${i}`));

  const focusText = nextFocus.join(' ');
  for (const id of ledger.mustDisclose.slice(0, caps.nextFocus)) {
    const m = movementById(ledger, id);
    const line = nextFocus.find((t) => numbersIn(movementText(m).to).every((n) => numbersIn(t).includes(n)));
    if (!line) throw new Error(`mandatory disclosure ${id} is missing from nextFocus`);
    // A decline disclosed as a rise is worse than no disclosure.
    if (!directionMatches(line, m)) throw new Error(`mandatory disclosure ${id} is described in the wrong direction`);
  }

  return { headline, drivers, nextFocus };
}

// ─── Lookups ────────────────────────────────────────────────────

export function movementById(ledger: ProgressLedger, id: string): MetricMovement {
  const m = ledger.movements.find((x) => x.id === id);
  if (!m) throw new Error('Unknown movement: ' + id);
  return m;
}

export function workById(ledger: ProgressLedger, id: string): WorkEvidence | undefined {
  return ledger.work.find((w) => w.id === id);
}

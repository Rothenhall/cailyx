/**
 * The progress ledger — a pure function from a comparable audit series plus
 * delivered work to graded evidence. No Prisma, no clock, no LLM: the same
 * inputs always give the same ledger, and every number the page quotes is
 * computed here, never by the writer.
 *
 * @module progress-ledger
 */

import { DIMENSION_LABELS, SURFACE_LABELS } from '../aeo-audit/aeo-audit.types';
import type { AeoSurface, AeoVerdict, PromptDimension } from '../aeo-audit/aeo-audit.types';
import type {
  ClaimGrade,
  MetricMovement,
  MovementScope,
  MovementWindow,
  ProgressCheckpoint,
  ProgressLedger,
  ProgressLink,
  WorkEvidence,
} from './progress.types';

/**
 * Materiality floors — the smallest change the page will report.
 *
 * A floor, not a significance test: the results module has no approved
 * statistical method (results/README), so nothing here claims confidence.
 * n>=5 repeats per prompt still leaves a few points of run-to-run wobble on a
 * few hundred answers, and a single question type or engine is a smaller
 * sample, so it gets the higher floor.
 */
export const HEADLINE_MIN_DELTA = 0.05;
export const HEADLINE_MIN_N = 30;
export const SLICE_MIN_DELTA = 0.08;
export const SLICE_MIN_N = 20;

/** Four or more comparable audits is the long-history case that earns a second page. */
export const EXTENDED_LAYOUT_MIN_CHECKPOINTS = 4;

export interface LedgerAudit {
  id: string;
  startedAt: Date | null;
  finishedAt: Date;
  verdict: AeoVerdict;
}

export interface LedgerInput {
  projectId: string;
  comparabilityKey: string;
  /** Comparable completed audits, chronological; the last one is the audit under review. */
  audits: LedgerAudit[];
  markets: string[];
  /** Client-visible work finished after the baseline audit and before this audit began. */
  work: WorkEvidence[];
}

const HEADLINE_SCOPES: ReadonlySet<MovementScope> = new Set(['overall', 'unbranded', 'citation', 'led']);

export function buildProgressLedger(input: LedgerInput): ProgressLedger {
  const { audits } = input;
  if (audits.length < 2) throw new Error('A progress ledger needs at least two comparable audits');

  const baseline = audits[0];
  const previous = audits[audits.length - 2];
  const current = audits[audits.length - 1];

  const movements: MetricMovement[] = [...compare(previous, current, 'since-previous')];
  if (baseline.id !== previous.id) movements.push(...compare(baseline, current, 'since-baseline'));

  const work = [...input.work].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const links = movements
    .filter((m) => m.improvement)
    .map((m) => linkFor(m, movements, work, auditById(audits, m.fromAuditId), auditById(audits, m.toAuditId)));

  const mustDisclose = movements
    .filter((m) => m.window === 'since-previous' && !m.improvement && (m.scope === 'unbranded' || m.scope === 'overall'))
    .map((m) => m.id);

  const surfaceLabels = current.verdict.counted.bySurface
    .filter((s) => s.status === 'completed' && s.observations > 0)
    .map((s) => s.label);

  return {
    version: 1,
    projectId: input.projectId,
    auditId: current.id,
    comparabilityKey: input.comparabilityKey,
    checkpoints: audits.map(toCheckpoint),
    baselineAuditId: baseline.id,
    previousAuditId: previous.id,
    surfaceLabels,
    markets: input.markets,
    movements,
    work,
    links,
    mustDisclose,
    realProgress: movements.some((m) => m.improvement),
    layout: audits.length >= EXTENDED_LAYOUT_MIN_CHECKPOINTS ? 'extended' : 'compact',
  };
}

// ─── Checkpoints ────────────────────────────────────────────────

function toCheckpoint(audit: LedgerAudit): ProgressCheckpoint {
  const c = audit.verdict.counted;
  const j = audit.verdict.judged;
  return {
    auditId: audit.id,
    finishedAt: audit.finishedAt.toISOString(),
    observations: c.overall.observations,
    unbrandedObservations: c.unbranded.observations,
    mentionRate: c.overall.mentionRate,
    unbrandedMentionRate: c.unbranded.mentionRate,
    citationRate: c.overall.citationRate,
    ledCount: j.available ? j.stanceCounts['recommended-primary'] ?? 0 : null,
    judgedCount: j.available ? j.observationsJudged : null,
  };
}

// ─── Movements ──────────────────────────────────────────────────

function compare(from: LedgerAudit, to: LedgerAudit, window: MovementWindow): MetricMovement[] {
  const a = from.verdict;
  const b = to.verdict;
  const out: MetricMovement[] = [];
  const push = (m: Omit<MetricMovement, 'window' | 'fromAuditId' | 'toAuditId' | 'delta' | 'id'> & { idKey: string }) => {
    const { idKey, ...rest } = m;
    out.push({
      ...rest,
      id: `${window}:${idKey}`,
      delta: rest.to - rest.from,
      window,
      fromAuditId: from.id,
      toAuditId: to.id,
    });
  };

  const rate = (
    idKey: string,
    scope: MovementScope,
    key: string | null,
    label: string,
    fromRate: number,
    toRate: number,
    fromN: number,
    toN: number,
    lowerIsBetter = false,
  ) => {
    const headline = HEADLINE_SCOPES.has(scope) || scope === 'competitor';
    const minN = headline ? HEADLINE_MIN_N : SLICE_MIN_N;
    const minDelta = headline ? HEADLINE_MIN_DELTA : SLICE_MIN_DELTA;
    if (fromN < minN || toN < minN) return;
    if (Math.abs(toRate - fromRate) + 1e-9 < minDelta) return;
    push({
      idKey,
      scope,
      key,
      label,
      unit: 'rate',
      from: fromRate,
      to: toRate,
      fromN,
      toN,
      improvement: lowerIsBetter ? toRate < fromRate : toRate > fromRate,
    });
  };

  rate('unbranded', 'unbranded', null, 'Unbranded AI visibility', a.counted.unbranded.mentionRate, b.counted.unbranded.mentionRate, a.counted.unbranded.observations, b.counted.unbranded.observations);
  rate('overall', 'overall', null, 'Overall mention rate', a.counted.overall.mentionRate, b.counted.overall.mentionRate, a.counted.overall.observations, b.counted.overall.observations);
  rate('citation', 'citation', null, 'Answers citing your site', a.counted.overall.citationRate, b.counted.overall.citationRate, a.counted.overall.observations, b.counted.overall.observations);

  // Judged — reported as counts out of the judged total, never as a rate (D4).
  if (a.judged.available && b.judged.available) {
    const fromLed = a.judged.stanceCounts['recommended-primary'] ?? 0;
    const toLed = b.judged.stanceCounts['recommended-primary'] ?? 0;
    const fromN = a.judged.observationsJudged;
    const toN = b.judged.observationsJudged;
    const rateDelta = fromN > 0 && toN > 0 ? toLed / toN - fromLed / fromN : 0;
    // Judged on the share, shown as counts. When the judged totals differ the
    // two can disagree (20 of 100 → 18 of 50 is a rising share on a falling
    // count), which would draw a "−2" as a win. Reported only when they agree.
    const sameDirection = Math.sign(toLed - fromLed) === Math.sign(rateDelta);
    if (fromN >= HEADLINE_MIN_N && toN >= HEADLINE_MIN_N && sameDirection && Math.abs(rateDelta) + 1e-9 >= HEADLINE_MIN_DELTA) {
      push({ idKey: 'led', scope: 'led', key: null, label: 'Answers that led with you', unit: 'count', from: fromLed, to: toLed, fromN, toN, improvement: rateDelta > 0 });
    }
  }

  for (const db of b.counted.byDimension) {
    const da = a.counted.byDimension.find((d) => d.dimension === db.dimension);
    if (!da) continue;
    const label = DIMENSION_LABELS[db.dimension as PromptDimension] ?? db.label;
    rate(`dimension:${db.dimension}`, 'dimension', db.dimension, `${label} questions`, da.mentionRate, db.mentionRate, da.observations, db.observations);
  }

  for (const sb of b.counted.bySurface) {
    if (sb.status !== 'completed') continue;
    const sa = a.counted.bySurface.find((s) => s.surface === sb.surface && s.status === 'completed');
    // The floor must test the sample the rate is computed on — the engine's
    // unbranded answers, not all its answers. Without that count, skip.
    if (!sa || sa.unbrandedObservations === undefined || sb.unbrandedObservations === undefined) continue;
    const label = SURFACE_LABELS[sb.surface as AeoSurface] ?? sb.label;
    rate(`surface:${sb.surface}`, 'surface', sb.surface, `Unbranded visibility on ${label}`, sa.unbrandedMentionRate, sb.unbrandedMentionRate, sa.unbrandedObservations, sb.unbrandedObservations);
  }

  if (b.counted.byMarket.length > 1) {
    for (const mb of b.counted.byMarket) {
      const ma = a.counted.byMarket.find((m) => m.market === mb.market);
      if (!ma) continue;
      rate(`market:${mb.market}`, 'market', mb.market, `Visibility in ${mb.market}`, ma.mentionRate, mb.mentionRate, ma.observations, mb.observations);
    }
  }

  // A rival named while the client was absent — the share falling is the win.
  const names = new Set([...a.counted.competitors, ...b.counted.competitors].map((c) => c.name));
  for (const name of names) {
    const ca = a.counted.competitors.find((c) => c.name === name);
    const cb = b.counted.competitors.find((c) => c.name === name);
    const fromN = a.counted.overall.observations;
    const toN = b.counted.overall.observations;
    if (fromN === 0 || toN === 0) continue;
    rate(
      `competitor:${name.toLowerCase()}`,
      'competitor',
      name,
      `Answers naming ${name} instead of you`,
      (ca?.wonWhileClientAbsent ?? 0) / fromN,
      (cb?.wonWhileClientAbsent ?? 0) / toN,
      fromN,
      toN,
      true,
    );
  }

  return out;
}

// ─── Links ──────────────────────────────────────────────────────

function linkFor(
  movement: MetricMovement,
  all: MetricMovement[],
  work: WorkEvidence[],
  from: LedgerAudit,
  to: LedgerAudit,
): ProgressLink {
  // Credit only work that finished after the earlier audit and before the
  // later one started measuring — work landing mid-measurement cannot be
  // behind a number that was already being collected.
  const start = from.finishedAt.toISOString();
  const end = (to.startedAt ?? to.finishedAt).toISOString();
  const inWindow = work.filter((w) => w.completedAt > start && w.completedAt <= end);

  let targeted: WorkEvidence[];
  if (HEADLINE_SCOPES.has(movement.scope)) {
    // A headline number is "targeted" only through a slice that also moved:
    // work aimed at comparison questions, where comparison questions improved
    // in this same window, is the specific story behind the headline.
    const improvedSlices = all.filter((m) => m.window === movement.window && m.improvement && !HEADLINE_SCOPES.has(m.scope));
    targeted = inWindow.filter((w) => improvedSlices.some((m) => targets(w, m)));
  } else {
    targeted = inWindow.filter((w) => targets(w, movement));
  }

  const grade: ClaimGrade = targeted.length > 0 ? 'A' : inWindow.length > 0 ? 'B' : 'C';
  const ordered = [...targeted, ...inWindow.filter((w) => !targeted.includes(w))];
  return {
    id: `link:${movement.id}`,
    movementId: movement.id,
    grade,
    workIds: ordered.slice(0, 3).map((w) => w.id),
  };
}

function targets(work: WorkEvidence, movement: MetricMovement): boolean {
  if (!movement.key) return false;
  const key = movement.key.toLowerCase();
  return work.targets.some((t) => t.kind === movement.scope && t.value.toLowerCase() === key);
}

function auditById(audits: LedgerAudit[], id: string): LedgerAudit {
  const found = audits.find((a) => a.id === id);
  if (!found) throw new Error('Ledger audit missing: ' + id);
  return found;
}

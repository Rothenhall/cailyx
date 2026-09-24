/**
 * Ledger + story → the report's progress page, fully resolved and capped.
 *
 * Every string a renderer draws is decided here, so the HTML page and the PDF
 * cannot disagree, and the page budget (one report page, two for a long
 * history) is enforced once rather than hoped for by each layout.
 *
 * @module progress-section
 */

import { HEADLINE_MIN_DELTA, SLICE_MIN_DELTA } from './progress-ledger';
import { PAGE_CAPS, TEXT_CAPS, clip, movementText, niceCountMax, niceMax, pctInt, shortDate, windowShort } from './progress-format';
import { rankedImprovements, templateStory, workById } from './progress-story';
import type {
  ProgressLedger,
  ProgressStory,
  ReportProgressCheckpointRow,
  ReportProgressSection,
  ReportProgressTile,
  WorkEvidence,
} from './progress.types';

export function toReportSection(
  ledger: ProgressLedger,
  story: ProgressStory | null,
  reviewId: string,
  frozenAt: string,
): ReportProgressSection {
  const caps = PAGE_CAPS[ledger.layout];
  const written = story ?? templateStory(ledger);

  const tiles: ReportProgressTile[] = rankedImprovements(ledger)
    .slice(0, caps.tiles)
    .map((m) => {
      const t = movementText(m);
      // Zero-based, topped at a round number just above the larger value —
      // the same rule as the audit-by-audit chart, so a 9% → 22% move is
      // visible rather than a sliver on a 0-100 track.
      const meter =
        m.unit === 'count'
          ? { from: m.from, to: m.to, max: niceCountMax(Math.max(m.from, m.to)) }
          : { from: pctInt(m.from), to: pctInt(m.to), max: niceMax(Math.max(pctInt(m.from), pctInt(m.to))) };
      return {
        label: m.label,
        now: t.to,
        before: t.from,
        delta: t.change,
        window: windowShort(m, ledger),
        improvement: m.improvement,
        rising: m.to > m.from,
        meter,
      };
    });

  const drivers = written.drivers.slice(0, caps.drivers).flatMap((d) => {
    const link = ledger.links.find((l) => l.id === d.linkId);
    if (!link) return [];
    const evidence = link.workIds
      .map((id) => workById(ledger, id))
      .filter((w): w is WorkEvidence => !!w)
      .slice(0, caps.evidencePerDriver)
      .map((w) => `${clip(w.title, TEXT_CAPS.workTitle)} — verified ${shortDate(w.completedAt)}`);
    return [{ text: clip(d.text, TEXT_CAPS.driver), grade: link.grade, evidence }];
  });

  const previousFinished = ledger.checkpoints[ledger.checkpoints.length - 2]?.finishedAt ?? '';
  const sincePrevious = ledger.work.filter((w) => w.completedAt > previousFinished);
  const checkpoints = checkpointRows(ledger, caps.checkpoints);

  return {
    reviewId,
    auditId: ledger.auditId,
    layout: ledger.layout,
    headline: clip(written.headline, TEXT_CAPS.headline),
    tiles,
    drivers,
    checkpoints,
    chartMax: niceMax(Math.max(...checkpoints.map((c) => c.unbrandedValue))),
    delivered: {
      items: sincePrevious.slice(0, caps.delivered).map((w) => ({
        title: clip(w.title, TEXT_CAPS.workTitle),
        date: shortDate(w.completedAt),
        kind: kindLabel(w),
      })),
      moreCount: Math.max(0, sincePrevious.length - caps.delivered),
      sinceBaselineTotal: ledger.work.length,
    },
    nextFocus: written.nextFocus.slice(0, caps.nextFocus).map((t) => clip(t, TEXT_CAPS.nextFocus)),
    provenanceNote: provenance(ledger),
    frozenAt,
  };
}

function checkpointRows(ledger: ProgressLedger, cap: number): ReportProgressCheckpointRow[] {
  const all = ledger.checkpoints.map((c, i) => ({ c, i }));
  // Keep the baseline — the comparison point the whole page argues from — plus the most recent audits.
  const kept = all.length <= cap ? all : [all[0], ...all.slice(all.length - (cap - 1))];
  const last = ledger.checkpoints.length - 1;
  return kept.map(({ c, i }) => ({
    label: i === 0 ? 'Baseline' : i === last ? 'This audit' : `Audit ${i + 1}`,
    date: shortDate(c.finishedAt),
    unbranded: `${pctInt(c.unbrandedMentionRate)}%`,
    overall: `${pctInt(c.mentionRate)}%`,
    // §6.3 — a stance pass that never ran is "not judged", never zero.
    led: c.ledCount === null || c.judgedCount === null ? 'Not judged' : `${c.ledCount} of ${c.judgedCount}`,
    unbrandedValue: pctInt(c.unbrandedMentionRate),
    overallValue: pctInt(c.mentionRate),
    isCurrent: i === last,
  }));
}

function kindLabel(w: WorkEvidence): string {
  if (w.kind === 'publication') return 'Published';
  if (w.kind === 'milestone') return 'Milestone';
  return w.discipline ? w.discipline.charAt(0).toUpperCase() + w.discipline.slice(1) : 'Work';
}

function provenance(ledger: ProgressLedger): string {
  const engines = ledger.surfaceLabels.join(', ') || 'the measured engines';
  const markets = ledger.markets.length ? ` in ${ledger.markets.join(', ')}` : '';
  return (
    `${ledger.checkpoints.length} audits, same questions, ${engines}${markets}. Changes under ${pctInt(HEADLINE_MIN_DELTA)} pts ` +
    `(${pctInt(SLICE_MIN_DELTA)} for one question type, engine or market) are omitted as normal variation. ` +
    'Work is shown beside a change it preceded — a sequence, not proof of cause.'
  );
}

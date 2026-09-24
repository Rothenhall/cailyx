/**
 * Report PDF — the paginated artifact, rendered from the *same*
 * `ReportDocument` the HTML page is built from.
 *
 * This file is deliberately the only part of the report pipeline that holds a
 * second layout. Everything a reader could check for meaning — which sections
 * exist, in what order, what an absent section says, whether a blank metric
 * means zero, which rubric scored it — is read from `report-document.ts`, so
 * the HTML page and the PDF cannot disagree about the report's content or its
 * coverage. What differs here is markup only: A4 pages, a cover, table
 * geometry, Helvetica.
 *
 * Two constraints shape the code:
 *
 *   - **No JSX.** The backend's `tsconfig.json` does not enable `jsx` and this
 *     module may not edit it, so elements are built with `React.createElement`
 *     (`h` below). Components are plain functions returning elements.
 *   - **Determinism.** §6.4: "Published reports are frozen snapshots. New data
 *     must not rewrite old reports." A released revision's PDF must therefore
 *     be the same document whenever it is rendered — so nothing here reads the
 *     clock. The document's own dates (`contentCreatedAt`, `snapshotAt`) are
 *     used for the PDF metadata, never `new Date()`.
 *
 * Fonts: the built-in Helvetica family is used rather than the HTML page's
 * Inter. That is a deliberate trade — it needs no font file, no network fetch
 * and no registration, so a render cannot fail or change because a font
 * endpoint moved. It also means the PDF carries no glyph outside the WinAnsi
 * set; see the module README's "what the PDF cannot represent faithfully".
 *
 * @module report-pdf
 */

import * as React from 'react';
import { Document, Page, Text, View, StyleSheet, Font, renderToStream } from '@react-pdf/renderer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportDocument, ReportSectionRef, ReportView, MetricView, Tone, AeoDimensionView } from './report-document';

/** `React.createElement`, under a name short enough to read a tree through. */
const h = React.createElement;

/** What a PDF render hands back to the route: the bytes, and how to name them. */
export interface ReportPdfArtifact {
  bytes: Buffer;
  /** Stable, informative download name — the slug plus which revision it is. */
  filename: string;
  view: ReportView;
  releasedRevision: number | null;
}

// ─── Palette (mirrors templates/report-html.hbs) ────────────────

const color = {
  ink: '#14120D',
  ink60: 'rgba(20,18,13,0.62)',
  line: 'rgba(20,18,13,0.15)',
  paper: '#F7F3EA',
  accent: '#B8703F',
  accentDeep: '#96592F',
  good: '#5f6a42',
  warn: '#96592F',
  bad: '#7A2E1F',
  code: '#14120D',
} as const;

/** The same four rubric bands the HTML page colours. */
const bandColor: Record<string, { bg: string; fg: string }> = {
  recommended: { bg: '#e5ecdb', fg: color.good },
  present: { bg: '#f4ecd8', fg: '#8a6d1f' },
  faint: { bg: '#f7e4cb', fg: color.accentDeep },
  invisible: { bg: '#f5d5d1', fg: color.bad },
};

const toneColor: Record<Tone, string> = {
  default: color.ink,
  good: color.good,
  bad: color.bad,
  warn: color.accentDeep,
  muted: color.ink60,
  accent: color.accentDeep,
};

// ─── Styles ─────────────────────────────────────────────────────

/**
 * A4/Letter height in points, which is what `@react-pdf/renderer` lays out
 * against here. The absolute-positioned footer and the page's own bottom
 * padding are both measured from it.
 */
/**
 * Fonts, registered once.
 *
 * These are **embedded**, not referenced. `@react-pdf/renderer` otherwise falls
 * back to the PDF base-14 fonts, which the reader's viewer must supply — that
 * renders correctly in Preview and CoreGraphics but comes out **completely
 * blank in poppler** (`pdftoppm`, and much server-side PDF tooling). Verified
 * with a one-line document: base-14 blank, embedded correct.
 *
 * Resolved relative to this file so it works from `src/` under ts-node and from
 * `dist/` after a build — `nest-cli.json` copies `assets/` into both.
 */
const FONT_DIR = join(__dirname, 'assets', 'fonts');

/** Registers the faces once; `renderToStream` can be called many times. */
let fontsRegistered = false;
function ensureFonts(): void {
  if (fontsRegistered) return;
  const faces: Array<{ family: string; src: string; fontWeight?: 'normal' | 'bold'; fontStyle?: 'normal' | 'italic' }> = [
    { family: 'Inter', src: 'Inter-Regular.ttf' },
    { family: 'Inter', src: 'Inter-Bold.ttf', fontWeight: 'bold' },
    { family: 'Inter', src: 'Inter-Italic.ttf', fontStyle: 'italic' },
    { family: 'Inter', src: 'Inter-BoldItalic.ttf', fontWeight: 'bold', fontStyle: 'italic' },
    { family: 'JetBrainsMono', src: 'JetBrainsMono-Regular.ttf' },
    { family: 'JetBrainsMono', src: 'JetBrainsMono-Bold.ttf', fontWeight: 'bold' },
  ];

  for (const face of faces) {
    const path = join(FONT_DIR, face.src);
    if (!existsSync(path)) {
      // Loud rather than silent: a missing font would produce an unembedded
      // document that renders blank in some viewers, which is far harder to
      // diagnose than a startup warning.
      throw new Error(
        `Report PDF font missing: ${path}. Run a build so nest-cli.json copies modules/reporting/assets into dist.`,
      );
    }
    // `...face` last would overwrite `src` with the bare filename.
    Font.register({ ...face, src: path });
  }
  fontsRegistered = true;
}

const PAGE_HEIGHT = 841.89;

/**
 * Where the fixed footer begins. Everything above this is the content band, so
 * the page's `paddingBottom` is computed from it rather than typed twice.
 */
const FOOTER_TOP = 770;

const s = StyleSheet.create({
  // `lineHeight` is set on text styles only, and always as a fraction of that
  // style's OWN fontSize. Two react-pdf behaviours make this load-bearing:
  // a unitless `lineHeight` on a container is resolved against the container's
  // font size and inherited as that absolute value (one `lineHeight: 1.45` on
  // the page collapsed a 21pt heading's box to ~14pt, so the line under it drew
  // through the heading), and a `lineHeight` on a text style is a multiplier of
  // that style's size (not points). Nothing here sets a leading on a View.
  page: {
    paddingTop: 40,
    // Reserves the fixed footer's band. `paddingBottom` and the footer's `top`
    // are two numbers that must agree, and they previously did not: the footer
    // sits at 770pt on an 841.89pt page, while a padding of 56 let flowing
    // content reach 785.9 — so the last rows of a table were drawn underneath
    // the footer, overlapping it. Derived from the constant below so the two
    // cannot drift apart again.
    paddingBottom: PAGE_HEIGHT - FOOTER_TOP + 4,
    paddingHorizontal: 40,
    fontFamily: 'Inter',
    fontSize: 9.5,
    color: color.ink,
  },
  footer: { position: 'absolute', top: FOOTER_TOP, left: 40, width: 515 },
  footerRule: { borderTopWidth: 1, borderTopColor: color.line, paddingTop: 5 },
  footerLine: { fontSize: 7.5, lineHeight: 1.4, color: color.ink60, marginBottom: 1.5 },

  eyebrow: { fontSize: 8, lineHeight: 1.4, letterSpacing: 1.2, textTransform: 'uppercase', color: color.accentDeep, marginBottom: 6 },
  h1: { fontSize: 21, lineHeight: 1.25, marginBottom: 3 },
  h2: { fontSize: 13, lineHeight: 1.3, borderBottomWidth: 1, borderBottomColor: color.line, paddingBottom: 4, marginBottom: 8 },
  h3: { fontSize: 10, lineHeight: 1.35, marginTop: 10, marginBottom: 4 },
  url: { fontSize: 10, lineHeight: 1.3, color: color.ink60, marginBottom: 10 },
  meta: { fontSize: 8.5, lineHeight: 1.4, color: color.ink60, marginBottom: 2 },
  note: { fontSize: 8.5, lineHeight: 1.4, color: color.ink60, marginBottom: 8 },
  body: { fontSize: 9.5, lineHeight: 1.45, marginBottom: 6 },

  band: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, alignSelf: 'flex-start', marginBottom: 6 },
  bandText: { fontSize: 8, lineHeight: 1.35, textTransform: 'uppercase', letterSpacing: 0.8 },

  hero: {
    flexDirection: 'row',
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 6,
    padding: 14,
    marginTop: 12,
    marginBottom: 10,
  },
  dial: { width: 78, alignItems: 'center', justifyContent: 'center' },
  dialNum: { fontSize: 30, lineHeight: 1.15, textAlign: 'center' },
  dialCap: { fontSize: 7.5, lineHeight: 1.35, textAlign: 'center', color: color.ink60, textTransform: 'uppercase', letterSpacing: 0.8 },
  summary: { flex: 1, paddingLeft: 14, fontSize: 9.5, lineHeight: 1.45 },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  tile: {
    // Fixed rather than a percentage: react-pdf's flex-wrap maths produces an
    // unusable transform for a wrapped row of percentage-width children as
    // soon as a section carries more than a handful of tiles. A print layout
    // has one page width, so a fixed tile is the honest measurement.
    width: 118,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 4,
    padding: 8,
    marginRight: 6,
    marginBottom: 6,
  },
  tileLabel: { fontSize: 7.5, lineHeight: 1.35, color: color.ink60, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  tileValue: { fontSize: 13, lineHeight: 1.25 },
  tileValueMuted: { fontSize: 9.5, lineHeight: 1.35, color: color.ink60 },
  tileUnit: { fontSize: 7, lineHeight: 1.4, color: color.ink60, marginTop: 2 },

  table: { marginBottom: 10 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: color.line },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: color.line },
  th: { fontSize: 7.5, lineHeight: 1.4, color: color.ink60, textTransform: 'uppercase', letterSpacing: 0.5, paddingVertical: 4, paddingRight: 6 },
  // A cell is a View (so a cell can stack a title over a muted second line the
  // way the HTML row does with a <div>); the padding therefore lives here and
  // the Text styles below carry no padding of their own.
  cell: { paddingVertical: 4, paddingRight: 6 },
  td: { fontSize: 8.5, lineHeight: 1.4 },
  tdSub: { fontSize: 7.5, lineHeight: 1.4, color: color.ink60 },

  bar: { height: 4, backgroundColor: color.line, borderRadius: 2, marginTop: 3 },
  barFill: { height: 4, backgroundColor: color.accent, borderRadius: 2 },
  evidence: { fontSize: 7.5, lineHeight: 1.4, color: color.ink60, marginTop: 2 },

  pill: {
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 7,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    marginRight: 4,
    marginBottom: 3,
  },
  pillBad: { borderColor: color.bad },
  pillVerified: { backgroundColor: color.ink, borderColor: color.ink },
  pillVerifiedText: { color: color.paper },

  dimRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  dimLabel: { width: 110, fontSize: 8.5, lineHeight: 1.3 },
  dimTrack: { flex: 1, height: 5, backgroundColor: color.line, borderRadius: 2.5, marginHorizontal: 6 },
  dimFill: { height: 5, backgroundColor: color.accent, borderRadius: 2.5 },
  dimPct: { width: 32, fontSize: 8.5, lineHeight: 1.3, textAlign: 'right' },

  quote: {
    backgroundColor: color.paper,
    borderLeftWidth: 2,
    borderLeftColor: color.accent,
    padding: 8,
    marginBottom: 6,
  },
  quoteText: { fontSize: 9, lineHeight: 1.4, fontStyle: 'italic' },
  quoteSrc: { fontSize: 7.5, lineHeight: 1.4, color: color.ink60, marginTop: 3 },
  pillText: { fontSize: 8, lineHeight: 1.35 },

  code: {
    fontFamily: 'JetBrainsMono',
    fontSize: 7.5,
    lineHeight: 1.4,
    backgroundColor: color.code,
    color: '#e8dfc8',
    padding: 6,
    borderRadius: 3,
    marginBottom: 4,
  },

  indexRow: { flexDirection: 'row', marginBottom: 3 },
  indexNum: { width: 16, fontSize: 9, lineHeight: 1.35, color: color.ink60 },
  indexTitle: { fontSize: 9.5, lineHeight: 1.4, flex: 1 },
  indexNote: { fontSize: 7.5, lineHeight: 1.7, color: color.ink60, flex: 1 },
});

// ─── Entry point ────────────────────────────────────────────────

/**
 * Render a built `ReportDocument` to PDF bytes.
 *
 * Server-side only: `renderToStream` runs the layout, pagination, font and
 * PDF-kit steps in this process. No browser, no headless Chrome, no temp
 * HTML round-trip — the layout is produced from the same React tree that
 * describes the content, so there is no intermediate representation that can
 * disagree with it.
 */
export async function renderReportPdf(doc: ReportDocument): Promise<Buffer> {
  // Before any layout runs: an unregistered family silently falls back to a
  // base-14 font, which is exactly the failure this exists to prevent.
  ensureFonts();
  const stream = await renderToStream(documentElement(doc));
  return collect(stream);
}

/** Drain a Node readable stream into one buffer. */
function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ─── Document ───────────────────────────────────────────────────

function documentElement(doc: ReportDocument): React.ReactElement {
  const pinned = pinnedDate(doc);
  return h(
    Document,
    {
      title: `${doc.cover.title} — AI Visibility Diagnostic`,
      author: doc.cover.orgName,
      subject: `AI Visibility Diagnostic for ${doc.cover.targetUrl}`,
      creator: doc.cover.orgName,
      producer: doc.cover.orgName,
      language: 'en',
      // Pinned to the snapshot's own creation instant, so two renders of the
      // same revision produce the same document rather than one that claims
      // it was made today (see the module header).
      creationDate: pinned,
      modificationDate: pinned,
    },
    h(
      Page,
      { size: 'A4', style: s.page, wrap: true },
      coverElement(doc),
      ...bodyElements(doc),
      footerElement(doc),
    ),
  );
}

/** The snapshot's own instant (its content creation date), or nothing when unusable. */
function pinnedDate(doc: ReportDocument): Date | undefined {
  const parsed = new Date(doc.cover.createdAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function footerElement(doc: ReportDocument): React.ReactElement {
  return h(
    View,
    { style: s.footer, fixed: true },
    h(
      View,
      { style: s.footerRule },
      ...doc.footer.lines.map((line, i) => h(Text, { key: `f${i}`, style: s.footerLine }, line)),
      h(Text, {
        style: s.footerLine,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `Page ${pageNumber} of ${totalPages}`,
      }),
    ),
  );
}

// ─── Cover ──────────────────────────────────────────────────────

function coverElement(doc: ReportDocument): React.ReactElement {
  const cover = doc.cover;
  const band = bandColor[cover.band] ?? bandColor.invisible;

  return h(
    View,
    null,
    h(Text, { style: s.eyebrow }, `${cover.orgName} — AI Visibility Diagnostic`),
    h(Text, { style: s.h1 }, cover.title),
    h(Text, { style: s.url }, cover.targetUrl),
    h(
      View,
      { style: [s.band, { backgroundColor: band.bg }] },
      h(Text, { style: [s.bandText, { color: band.fg }] }, cover.band),
    ),
    // Null for a client-facing render of an unreleased report: the document
    // says nothing about draft stage outside the agency (§6.4).
    cover.releaseLine ? h(Text, { style: s.meta }, cover.releaseLine) : null,
    h(Text, { style: s.note }, doc.score.provenanceNote),
    h(
      View,
      { style: s.hero },
      h(
        View,
        { style: s.dial },
        h(Text, { style: s.dialNum }, String(doc.score.total)),
        h(Text, { style: s.dialCap }, 'of 100'),
      ),
      h(Text, { style: s.summary }, doc.executiveSummary),
    ),
    h(Text, { style: s.note }, cover.confidentialityLine),
  );
}

// ─── Body ───────────────────────────────────────────────────────

/**
 * One element per section, in the document's order.
 *
 * A section that is not present contributes the sentence that explains the
 * omission — the same sentence the HTML page shows — so the PDF names what is
 * missing instead of closing the gap and looking complete.
 */
function bodyElements(doc: ReportDocument): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  if (doc.sectionIndex) out.push(sectionIndexElement(doc));
  doc.sections.forEach((ref, index) => {
    if (!ref.present && !ref.note) return;
    out.push(
      h(
        View,
        { key: ref.id, break: index > 0 },
        h(Text, { style: s.h2 }, ref.title),
        ref.present ? sectionBody(doc, ref) : h(Text, { style: s.note }, ref.note ?? ''),
      ),
    );
  });
  return out;
}

/**
 * §6.1's section index, for the detailed read.
 *
 * It lists **every** section the detailed view carries, including the ones
 * that are not in this report — an index that quietly dropped a missing
 * section would be the same silent gap the sections themselves refuse to make.
 */
function sectionIndexElement(doc: ReportDocument): React.ReactElement {
  const refs = doc.sectionIndex ?? [];
  return h(
    View,
    { key: 'index', wrap: false },
    h(Text, { style: s.h2 }, 'Contents'),
    ...refs.map((ref, i) =>
      h(
        View,
        { key: `ix${i}`, style: s.indexRow },
        h(Text, { style: s.indexNum }, String(i + 1)),
        ref.present
          ? h(Text, { style: s.indexTitle }, ref.title)
          : h(Text, { style: s.indexNote }, `${ref.title} — not included`),
      ),
    ),
  );
}

function sectionBody(doc: ReportDocument, ref: ReportSectionRef): React.ReactElement | null {
  switch (ref.id) {
    case 'scoreBreakdown':
      return scoreSection(doc);
    case 'findings':
      return findingsSection(doc);
    case 'roadmap':
      return roadmapSection(doc);
    case 'presence':
      return presenceSection(doc);
    case 'aeoVisibility':
      return aeoVisibilitySection(doc);
    case 'competitors':
      return competitorsSection(doc);
    case 'growthPlan':
      return growthPlanSection(doc);
    case 'backlinks':
      return backlinksSection(doc);
    default:
      return null;
  }
}

// ─── Score breakdown ────────────────────────────────────────────

function scoreSection(doc: ReportDocument): React.ReactElement {
  const rows = doc.score.subScores.map((sub) =>
    [
      cell(sub.dimension),
      cell(sub.valueLabel, { tone: sub.partial ? 'accent' : 'default' }),
      cell(sub.weightLabel),
      cell(sub.contributionLabel),
    ] as React.ReactNode[],
  );

  return h(
    View,
    null,
    tableElement(
      [
        { header: 'Dimension', width: '30%' },
        { header: 'Value (0-100)', width: '16%' },
        { header: 'Weight', width: '20%' },
        { header: 'Contribution', width: '34%' },
      ],
      rows,
    ),
    ...doc.score.subScores.map((sub, i) =>
      h(
        View,
        { key: `sub${i}`, style: { marginBottom: 5 } },
        h(Text, { style: s.note }, `${sub.dimension} — ${sub.valueLabel} of 100`),
        h(View, { style: s.bar }, h(View, { style: [s.barFill, { width: sub.barPercent * 5.15 }] })),
        h(
          Text,
          { style: s.evidence },
          sub.evidence.length > 0
            ? `Evidence: ${sub.evidence.join(' · ')}`
            : 'No evidence lines recorded for this dimension.',
        ),
        sub.partialNote ? h(Text, { style: [s.evidence, { color: color.accentDeep }] }, sub.partialNote) : null,
      ),
    ),
    h(Text, { style: s.note }, doc.score.bandNote),
  );
}

// ─── Findings ───────────────────────────────────────────────────

function findingsSection(doc: ReportDocument): React.ReactElement {
  const d = doc.decisions;
  if (!d.findingsTable.present) return h(Text, { style: s.note }, d.findingsTable.note ?? '');

  const rows = doc.findings.map((f) =>
    [
      cell(f.label),
      cell(f.status, { tone: f.statusTone }),
      cell(f.severity, { tone: f.severityTone }),
      cell(f.confidence),
    ] as React.ReactNode[],
  );

  return h(
    View,
    null,
    tableElement(
      [
        { header: 'Check', width: '38%' },
        { header: 'Status', width: '16%' },
        { header: 'Severity', width: '16%' },
        { header: 'Confidence', width: '30%' },
      ],
      rows,
    ),
    ...doc.findings.map((f, i) =>
      h(
        View,
        { key: `f${i}`, style: { marginBottom: 6 } },
        h(Text, { style: { fontSize: 8.5, lineHeight: 1.4 } }, `${f.label} — fix: ${f.recommendedFix}`),
        ...(f.reproduction ?? []).map((r, j) =>
          h(Text, { key: `r${j}`, style: s.code }, `${r.command}  # ${r.expectedResult} (bot: ${r.bot})`),
        ),
      ),
    ),
  );
}

// ─── Roadmap ────────────────────────────────────────────────────

function roadmapSection(doc: ReportDocument): React.ReactElement {
  const d = doc.decisions;
  if (!d.roadmapTable.present) return h(Text, { style: s.note }, d.roadmapTable.note ?? '');

  const rows = doc.roadmap.map((item) =>
    [
      cell(item.action),
      cell(item.dimension),
      stack(cell(item.title), cell(item.description, { sub: true })),
      cell(item.priorityLabel, { tone: item.prioritySet ? 'default' : 'muted' }),
      cell(item.status, { tone: item.statusTone }),
    ] as React.ReactNode[],
  );

  return tableElement(
    [
      { header: 'Action', width: '12%' },
      { header: 'Dimension', width: '18%' },
      { header: 'Item', width: '42%' },
      { header: 'Priority', width: '14%' },
      { header: 'Status', width: '14%' },
    ],
    rows,
  );
}

// ─── Presence ───────────────────────────────────────────────────

function presenceSection(doc: ReportDocument): React.ReactElement {
  const presence = doc.presence;
  const d = doc.decisions;
  if (!presence) return h(Text, { style: s.note }, d.presence.note ?? '');

  return h(
    View,
    null,
    tilesElement(presence.metrics),
    presence.lastRunNote ? h(Text, { style: s.note }, presence.lastRunNote) : null,
    !d.presenceAccounts.present
      ? h(Text, { style: s.note }, d.presenceAccounts.note ?? '')
      : tableElement(
          [
            { header: 'Platform', width: '26%' },
            { header: 'Status', width: '20%' },
            { header: 'Handle', width: '18%' },
            { header: 'Note', width: '36%' },
          ],
          presence.accounts.map((a) =>
            [
              stack(cell(a.label), cell(a.group, { sub: true })),
              cell(a.nameMismatch ? `${a.state} · name mismatch` : a.state, { tone: a.stateTone }),
              cell(a.handleLabel),
              cell(a.note, { sub: true }),
            ] as React.ReactNode[],
          ),
        ),
    !d.presenceGaps.present
      ? h(Text, { style: s.note }, d.presenceGaps.note ?? '')
      : h(
          View,
          null,
          h(Text, { style: s.body }, 'Expected but not found:'),
          h(
            View,
            { style: { flexDirection: 'row', flexWrap: 'wrap' } },
            ...presence.gaps.map((gap, i) =>
              h(View, { key: `gap${i}`, style: [s.pill, s.pillBad] }, h(Text, { style: s.pillText }, gap)),
            ),
          ),
        ),
  );
}

// ─── AEO Visibility ─────────────────────────────────────────────

function aeoVisibilitySection(doc: ReportDocument): React.ReactElement {
  const aeo = doc.aeoVisibility;
  const d = doc.decisions;
  if (!aeo) return h(Text, { style: s.note }, d.aeoVisibility.note ?? '');

  return h(
    View,
    null,
    tilesElement([
      { label: 'Questions measured', value: String(aeo.questionsMeasured), unit: null, measured: true },
      { label: 'Answers observed', value: String(aeo.totalAnswers), unit: null, measured: true },
      { label: 'Unbranded mention rate', value: `${aeo.unbrandedMentionRatePercent}%`, unit: 'the honest visibility test', measured: true },
      { label: 'Branded mention rate', value: `${aeo.brandedMentionRatePercent}%`, unit: 'trivially high — the name was already given', measured: true },
    ]),
    aeo.byDimension.length > 0
      ? h(
          View,
          { style: { marginTop: 4, marginBottom: 8 } },
          h(Text, { style: s.h3 }, 'By question type'),
          ...aeo.byDimension.map((dim: AeoDimensionView, i: number) => dimensionRow(dim, i)),
        )
      : null,
    h(Text, { style: s.h3 }, 'Where it loses'),
    !d.aeoVisibilityLosing.present
      ? h(Text, { style: s.note }, d.aeoVisibilityLosing.note ?? '')
      : aeo.losingExample
        ? h(
            View,
            { wrap: false },
            h(Text, { style: s.body }, `The exact question a buyer would type — "${aeo.losingExample.prompt}" — named a competitor instead of the client.`),
            h(
              View,
              { style: s.quote },
              h(Text, { style: s.quoteText }, aeo.losingExample.evidenceQuote ?? '(no quote recorded)'),
              h(Text, { style: s.quoteSrc }, `Lost to: ${aeo.losingExample.losesTo.join(', ')}`),
            ),
          )
        : null,
    aeo.competitors.length > 0
      ? h(
          View,
          { style: { marginTop: 4 } },
          h(Text, { style: s.body }, 'Competitors a judged answer placed ahead of the client:'),
          h(
            View,
            { style: { flexDirection: 'row', flexWrap: 'wrap' } },
            ...aeo.competitors.map((c, i) =>
              h(
                View,
                { key: `aeoc${i}`, style: [s.pill, s.pillVerified] },
                h(Text, { style: [s.pillText, s.pillVerifiedText] }, c.name),
              ),
            ),
          ),
        )
      : null,
    h(Text, { style: s.note }, aeo.provenanceNote),
  );
}

function dimensionRow(dim: AeoDimensionView, i: number): React.ReactElement {
  return h(
    View,
    { key: `dim${i}`, style: s.dimRow },
    h(Text, { style: s.dimLabel }, dim.label),
    h(View, { style: s.dimTrack }, h(View, { style: [s.dimFill, { width: `${dim.mentionRatePercent}%` }] })),
    h(Text, { style: s.dimPct }, `${dim.mentionRatePercent}%`),
  );
}

// ─── Competitors ────────────────────────────────────────────────

function competitorsSection(doc: ReportDocument): React.ReactElement {
  const competitors = doc.competitors;
  const d = doc.decisions;
  if (!competitors) return h(Text, { style: s.note }, d.competitors.note ?? '');

  return h(
    View,
    null,
    h(Text, { style: s.body }, `Your homepage SEO score: ${competitors.clientSeoLabel}`),
    competitors.clientIssues.length > 0
      ? h(Text, { style: s.note }, `Issues: ${competitors.clientIssues.join(', ')}`)
      : null,
    !d.competitorsOnly.present
      ? null
      : h(
          View,
          null,
          h(Text, { style: s.body }, "Platforms where a tracked competitor has a presence and you don't:"),
          h(
            View,
            { style: { flexDirection: 'row', flexWrap: 'wrap' } },
            ...competitors.competitorsOnly.map((key, i) =>
              h(View, { key: `co${i}`, style: [s.pill, s.pillBad] }, h(Text, { style: s.pillText }, key)),
            ),
          ),
        ),
    !d.competitorsTable.present
      ? h(Text, { style: s.note }, d.competitorsTable.note ?? '')
      : tableElement(
          [
            { header: 'Competitor', width: '26%' },
            { header: 'SEO score', width: '14%' },
            { header: 'Top issues', width: '38%' },
            { header: 'Found on', width: '22%' },
          ],
          competitors.rows.map((row) =>
            [
              stack(cell(row.name), cell(row.domain, { sub: true })),
              cell(row.seoScoreLabel),
              cell(row.seoIssues || '—', { sub: true }),
              cell(row.presencePlatforms.join(', ') || '—', { sub: true }),
            ] as React.ReactNode[],
          ),
        ),
    h(Text, { style: s.note }, competitors.provenanceNote),
  );
}

// ─── Growth plan ────────────────────────────────────────────────

function growthPlanSection(doc: ReportDocument): React.ReactElement {
  const plan = doc.growthPlan;
  const d = doc.decisions;
  if (!plan) return h(Text, { style: s.note }, d.growthPlan.note ?? '');

  return h(
    View,
    null,
    !d.growthPlanActionPlan.present
      ? h(Text, { style: s.note }, d.growthPlanActionPlan.note ?? '')
      : tableElement(
          [
            { header: 'Priority', width: '10%' },
            { header: 'Recommended action', width: '50%' },
            { header: 'Quick wins', width: '20%' },
            { header: 'Major projects', width: '20%' },
          ],
          (plan.actionPlan ?? []).map((row) =>
            [
              cell(String(row.priorityRank)),
              stack(cell(row.title), cell(row.summary, { sub: true })),
              cell(String(row.quickWinCount)),
              cell(String(row.majorProjectCount)),
            ] as React.ReactNode[],
          ),
        ),
    plan.notCovered.length > 0
      ? h(Text, { style: s.note }, `No open gap in: ${plan.notCovered.join(', ')}.`)
      : null,
    plan.actionPlanUpdatedAt ? h(Text, { style: s.note }, `Action plan built ${plan.actionPlanUpdatedAt}.`) : null,
    d.growthPlanFindingsCopy.present
      ? h(
          View,
          null,
          h(Text, { style: s.h3 }, 'Issue + Evidence (detailed)'),
          ...plan.findingsCopy.map((f, i) =>
            h(
              View,
              { key: `gc${i}`, style: { marginBottom: 7 }, wrap: false },
              h(Text, { style: { fontSize: 9 } }, f.thinRun ? `${f.title} (thin evidence)` : f.title),
              h(Text, { style: s.body }, f.whatExecutive),
              h(Text, { style: s.body }, `Why: ${f.whyExecutive}`),
              h(Text, { style: s.body }, `Fix (implementation guidance): ${f.fixExecutive}`),
              f.disclosedGap ? h(Text, { style: s.note }, `Disclosed gap: ${f.disclosedGap}`) : null,
            ),
          ),
        )
      : null,
    plan.assetsNote ? h(Text, { style: s.note }, plan.assetsNote) : null,
  );
}

// ─── Backlinks ──────────────────────────────────────────────────

function backlinksSection(doc: ReportDocument): React.ReactElement {
  const backlinks = doc.backlinks;
  const d = doc.decisions;
  if (!backlinks) return h(Text, { style: s.note }, d.backlinks.note ?? '');

  return h(
    View,
    null,
    backlinks.statusNote
      ? h(Text, { style: [s.note, { color: toneColor[backlinks.statusTone] }] }, backlinks.statusNote)
      : null,
    // A failed pull has no figures at all: printing tiles of "not reported"
    // would be six ways of saying the same nothing, and the status line above
    // already says why.
    d.backlinksMetrics.present ? tilesElement(backlinks.metrics) : null,
    d.backlinksTop.present
      ? tableElement(
          [
            { header: 'Source', width: '40%' },
            { header: 'Anchor', width: '20%' },
            { header: 'Follow', width: '12%' },
            { header: 'Domain rank', width: '14%' },
            { header: 'First seen', width: '14%' },
          ],
          backlinks.top.map((row) =>
            [
              cell(row.urlFrom),
              cell(row.anchorLabel),
              cell(row.followLabel, { tone: row.followTone }),
              cell(row.domainRankLabel),
              cell(row.firstSeenLabel),
            ] as React.ReactNode[],
          ),
        )
      : null,
    h(Text, { style: s.note }, backlinks.provenanceNote),
  );
}

// ─── Primitives ─────────────────────────────────────────────────

interface Column {
  header: string;
  width: string;
}

/**
 * A table cell's text.
 *
 * A cell body is one Text (or a {@link stack} of them); the column width and
 * the padding belong to the cell View {@link tableElement} builds, which is
 * what lets a cell hold a title over a muted second line exactly as an HTML
 * row does with a `<div class="fix">` — rather than running the two together
 * on one line, which is what inline text runs would do.
 */
function cell(text: string, opts: { tone?: Tone; sub?: boolean } = {}): React.ReactElement {
  const style = opts.sub ? s.tdSub : opts.tone ? [s.td, { color: toneColor[opts.tone] }] : s.td;
  return h(Text, { style }, text);
}

/** Two or more cell lines, stacked. */
function stack(...lines: React.ReactElement[]): React.ReactElement {
  return h(View, null, ...lines);
}

/**
 * A table, built from flex rows.
 *
 * `wrap: false` on each body row keeps a row on one page: a check split across
 * a page boundary reads as two checks.
 */
function tableElement(columns: Column[], rows: React.ReactNode[][]): React.ReactElement {
  return h(
    View,
    { style: s.table },
    h(
      View,
      { style: s.headRow, wrap: false },
      ...columns.map((c, i) => h(Text, { key: `h${i}`, style: [s.th, { width: c.width }] }, c.header)),
    ),
    ...rows.map((cells, i) =>
      h(
        View,
        { key: `r${i}`, style: s.row, wrap: false },
        ...cells.map((body, j) =>
          h(View, { key: `c${j}`, style: [s.cell, { width: columns[j]?.width ?? 'auto' }] }, body),
        ),
      ),
    ),
  );
}

/** Metric tiles — value plus unit, with an unmeasured metric shown as the absence it is. */
function tilesElement(metrics: MetricView[]): React.ReactElement {
  return h(
    View,
    { style: s.tiles },
    ...metrics.map((m, i) =>
      h(
        View,
        { key: `m${i}`, style: s.tile },
        h(Text, { style: s.tileLabel }, m.label),
        h(Text, { style: m.measured ? s.tileValue : s.tileValueMuted }, m.value),
        m.unit ? h(Text, { style: s.tileUnit }, m.unit) : null,
      ),
    ),
  );
}

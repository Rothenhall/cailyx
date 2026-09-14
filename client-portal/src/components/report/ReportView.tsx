'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { BandBadge, SeverityBadge } from '@/components/ui/Badge';
import type { ReportData, SubScore } from '@/types/api';

/**
 * The full report — score, subscores, findings, roadmap, growth plan
 * (stage 12's "Prioritized Growth Roadmap"), and backlinks. Fed the same
 * ReportData shape from either an operator's project-scoped fetch or a
 * client's own /portal/reports/:slug fetch — see the two page.tsx call sites.
 * Scoped `.report-view` class carries the one traffic-light exception to the
 * brand's all-warm palette (see globals.css).
 */
export function ReportView({ report }: { report: ReportData }) {
  return (
    <div className="report-view space-y-5">
      <ScoreHero report={report} />
      <SubScoresGrid subScores={report.subScores} />
      {report.findings.length > 0 && <FindingsSection findings={report.findings} />}
      {report.roadmap.length > 0 && <RoadmapSection roadmap={report.roadmap} />}
      {report.growthPlan && <GrowthPlanSection growthPlan={report.growthPlan} />}
      <BacklinksSection backlinks={report.backlinks} />
    </div>
  );
}

function ScoreHero({ report }: { report: ReportData }) {
  return (
    <div className="flex flex-col gap-4 rounded-r3 border border-border bg-bg-raised p-5 shadow-e1 sm:flex-row sm:items-center">
      <div className="flex h-24 w-24 flex-shrink-0 flex-col items-center justify-center rounded-full border-4 border-bg-inset">
        <span className="text-figure font-semibold">{report.scoreTotal}</span>
        <span className="text-caption text-faint">of 100</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-title font-medium">{report.title}</h1>
          <BandBadge band={report.scoreBand} />
        </div>
        <p className="text-caption text-faint">{report.targetUrl}</p>
        <p className="mt-2 whitespace-pre-line text-body text-dim">{report.executiveSummary}</p>
      </div>
    </div>
  );
}

function SubScoresGrid({ subScores }: { subScores: SubScore[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {subScores.map((s) => (
        <div key={s.dimension} className="rounded-r2 border border-border bg-bg-raised p-3">
          <div className="text-caption uppercase tracking-eyebrow text-faint">{s.dimension}</div>
          <div className="mt-1 text-title font-semibold">
            {s.partial ? <span className="text-faint">—</span> : s.value}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-inset">
            <div className="h-full bg-accent" style={{ width: `${s.partial ? 0 : s.value}%` }} />
          </div>
          {s.partial && <p className="mt-1 text-caption text-faint">{s.partialReason ?? 'not measured yet'}</p>}
        </div>
      ))}
    </div>
  );
}

function FindingsSection({ findings }: { findings: ReportData['findings'] }) {
  return (
    <Section title="Findings">
      <table className="w-full text-ui">
        <thead>
          <tr className="border-b border-border text-left text-caption text-faint">
            <th className="pb-2 font-normal">Check</th>
            <th className="pb-2 font-normal">Status</th>
            <th className="pb-2 font-normal">Severity</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => (
            <tr key={i} className="border-b border-border last:border-b-0">
              <td className="py-2 pr-3">
                <div className="font-medium">{f.type}</div>
                <div className="text-caption text-faint">{f.recommendedFix}</div>
              </td>
              <td className={cn('py-2 pr-3', f.status === 'pass' ? 'text-a-ok' : f.status === 'fail' ? 'text-a-bad' : 'text-dim')}>
                {f.status}
              </td>
              <td className="py-2">
                <SeverityBadge severity={f.severity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function RoadmapSection({ roadmap }: { roadmap: ReportData['roadmap'] }) {
  return (
    <Section title="Roadmap">
      <div className="space-y-2">
        {roadmap.map((r, i) => (
          <div key={i} className="flex items-start justify-between gap-3 rounded-r2 border border-border px-3 py-2">
            <div className="min-w-0">
              <div className="text-ui font-medium">{r.title}</div>
              <div className="text-caption text-faint">{r.description}</div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2 text-caption text-faint">
              <span className="capitalize">{r.action}</span>
              <SeverityBadge severity={r.severity} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function GrowthPlanSection({ growthPlan }: { growthPlan: NonNullable<ReportData['growthPlan']> }) {
  return (
    <Section title="Prioritized Growth Roadmap">
      {growthPlan.actionPlan ? (
        <div className="space-y-2">
          {growthPlan.actionPlan.recommendations.map((r) => (
            <div key={r.category} className="rounded-r2 border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui font-medium">
                  #{r.priorityRank} — {r.title}
                </span>
                <span className="text-caption text-faint">
                  {r.quickWinCount} quick win{r.quickWinCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-caption text-dim">{r.summary}</p>
            </div>
          ))}
          {growthPlan.actionPlan.notCovered.length > 0 && (
            <p className="text-caption text-faint">
              No open gap in: {growthPlan.actionPlan.notCovered.join(', ')}.
            </p>
          )}
        </div>
      ) : (
        <p className="text-body text-faint">No action plan built yet.</p>
      )}

      {growthPlan.findingsCopy.length > 0 && (
        <div className="mt-4 space-y-3">
          <h3 className="text-ui font-medium">Issue + evidence (detailed)</h3>
          {growthPlan.findingsCopy.map((f, i) => (
            <div key={i} className="rounded-r2 border border-border px-3 py-2">
              <div className="text-ui font-medium">
                {f.title}
                {f.thinRun && <span className="ml-2 text-caption text-a-warn">(thin evidence)</span>}
              </div>
              <p className="text-caption text-dim">{f.whatExecutive}</p>
              <p className="text-caption text-faint">
                <em>Why:</em> {f.whyExecutive}
              </p>
              <p className="text-caption text-faint">
                <em>Fix:</em> {f.fixExecutive}
              </p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-caption text-faint">{growthPlan.assetsNote}</p>
    </Section>
  );
}

function BacklinksSection({ backlinks }: { backlinks: ReportData['backlinks'] }) {
  return (
    <Section title="Backlinks">
      {!backlinks && <p className="text-body text-faint">No backlinks data yet.</p>}
      {backlinks && backlinks.status === 'failed' && (
        <p className="text-body text-red">Backlinks pull failed: {backlinks.error}</p>
      )}
      {backlinks && backlinks.status !== 'failed' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Referring domains" value={backlinks.referringDomains} />
            <Stat label="Total backlinks" value={backlinks.backlinks} />
            <Stat label="Rank" value={backlinks.rank} />
            <Stat label="Spam score" value={backlinks.backlinksSpamScore} />
            <Stat label="Broken backlinks" value={backlinks.brokenBacklinks} />
            <Stat label="Referring IPs" value={backlinks.referringIps} />
          </div>
          {backlinks.topBacklinks.length > 0 && (
            <table className="mt-4 w-full text-ui">
              <thead>
                <tr className="border-b border-border text-left text-caption text-faint">
                  <th className="pb-2 font-normal">Source</th>
                  <th className="pb-2 font-normal">Anchor</th>
                  <th className="pb-2 font-normal">Follow</th>
                  <th className="pb-2 font-normal">Rank</th>
                </tr>
              </thead>
              <tbody>
                {backlinks.topBacklinks.map((b, i) => (
                  <tr key={i} className="border-b border-border text-caption last:border-b-0">
                    <td className="max-w-[16rem] truncate py-2 pr-3" title={b.urlFrom}>{b.urlFrom}</td>
                    <td className="max-w-[10rem] truncate py-2 pr-3">{b.anchor ?? '—'}</td>
                    <td className={cn('py-2 pr-3', b.dofollow ? 'text-a-ok' : 'text-a-warn')}>
                      {b.dofollow ? 'dofollow' : 'nofollow'}
                    </td>
                    <td className="py-2">{b.domainFromRank ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {backlinks.status === 'partial' && backlinks.error && (
            <p className="mt-2 text-caption text-faint">{backlinks.error}</p>
          )}
        </>
      )}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-r2 border border-border bg-bg-raised p-3">
      <div className="text-caption text-faint">{label}</div>
      <div className="text-title font-semibold">{value ?? '—'}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-r3 border border-border bg-bg-raised p-4 shadow-e1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-3 flex w-full items-center justify-between text-left text-title font-medium"
      >
        {title}
        <span className="text-caption text-faint">{open ? '−' : '+'}</span>
      </button>
      {open && children}
    </div>
  );
}

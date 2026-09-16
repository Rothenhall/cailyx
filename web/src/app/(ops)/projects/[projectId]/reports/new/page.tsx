'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CoveragePanel } from '@/components/patterns/CoveragePanel';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { RunConfigurator, type ConfiguratorPrerequisite, type ObservedConfiguration } from '@/components/patterns/RunConfigurator';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import { getActionPlan } from '@/services/planning';
import { getProject } from '@/services/projects';
import { listFindings } from '@/services/findings';
import { getLatestBacklinksSummary } from '@/services/authority';
import { getNamedCompetitors, getPresenceInventory } from '@/services/research-library';
import { listTechnicalAudits, type AuditRunSummary } from '@/services/research';
import {
  coverageFromManifest,
  generateReport,
  listEvidenceManifests,
  type EvidenceManifestView,
} from '@/services/reports';

/**
 * RP02 — Report preparation.
 *
 * design_plan.md §4.4: *"Title, project target, source freshness/coverage,
 * missing sections, generation impact"*, and §5.10 steps 1–3 are the runbook
 * this screen implements:
 *
 *  1. select the project and title, inspect evidence coverage and latest-source
 *     dates;
 *  2. resolve missing prerequisites — a technical audit is required, everything
 *     else must be *disclosed* before generating;
 *  3. generate — which also writes a new ScoreRun.
 *
 * The rule that shapes the whole page is §6.4's "an absent source is named, not
 * silently omitted". Every section the report may or may not contain is listed
 * here with its real state, so nobody generates a report expecting backlinks or
 * a competitor comparison and gets a document with those sections missing.
 *
 * Two facts about generation are stated because they are counter-intuitive:
 *
 *  - **The URL that gets stored is the latest technical audit's**, not whatever
 *    is typed here (§5.10 step 1). So the audit is shown, not an editable
 *    target field pretending to control it.
 *  - **Generation is work with side effects.** It re-scores the project (a new
 *    ScoreRun, which moves a naive score-history timeline), snapshots five
 *    optional sources, and calls the competitor gap service — which may scan
 *    the client's current technology. It is rate-limited to 3 per minute.
 */

/** The outcome of one optional source read. */
type SourceState =
  | { status: 'loading' }
  /** The source has data for this project. */
  | { status: 'present'; at: string | null; detail: string }
  /** The source has never run. A 404 is the documented answer for this. */
  | { status: 'absent'; detail: string }
  /** The read itself failed — reported, never folded into "absent". */
  | { status: 'unreadable'; message: string };

const LOADING: SourceState = { status: 'loading' };

export default function ReportPreparationPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [project, setProject] = useState<{ name: string; domain: string; timezone?: string } | null>(null);
  const [audits, setAudits] = useState<AuditRunSummary[] | null>(null);
  const [manifest, setManifest] = useState<EvidenceManifestView | null>(null);
  const [sources, setSources] = useState<Record<string, SourceState>>({
    findings: LOADING,
    backlinks: LOADING,
    presence: LOADING,
    competitors: LOADING,
    strategy: LOADING,
  });
  const [title, setTitle] = useState('');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);

  /**
   * Reads one optional source. A 404 means "never run for this project" — the
   * documented answer for these routes — and is the only class folded into
   * `absent`; anything else is surfaced as a failed read.
   */
  const loadSource = useCallback(
    async (key: string, read: (signal?: AbortSignal) => Promise<{ at: string | null; detail: string } | null>, signal: AbortSignal) => {
      try {
        const value = await read(signal);
        setSources((current) => ({
          ...current,
          [key]: value
            ? { status: 'present', at: value.at, detail: value.detail }
            : { status: 'absent', detail: 'This source has never run for this project.' },
        }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const apiError = toApiError(caught);
        setSources((current) => ({
          ...current,
          [key]:
            apiError.kind === 'not-found'
              ? { status: 'absent', detail: 'This source has never run for this project.' }
              : {
                  status: 'unreadable',
                  message:
                    'This source could not be read, so whether it exists is unknown. That is not the same as it being absent.',
                },
        }));
      }
    },
    [],
  );

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        setError(null);
        const [detail, auditRows, manifests] = await Promise.all([
          getProject(projectId, { signal }),
          listTechnicalAudits(projectId, { signal }),
          listEvidenceManifests(projectId, { limit: 1 }, { signal }),
        ]);
        setProject({ name: detail.name, domain: detail.domain });
        setAudits(auditRows.audits);
        setManifest(manifests[0] ?? null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }

      void loadSource(
        'findings',
        async (inner) => {
          const result = await listFindings(projectId, { signal: inner });
          if (result.findings.length === 0) return null;
          return {
            at: result.findings[0]?.createdAt ?? null,
            detail: `${result.findings.length} stored finding${result.findings.length === 1 ? '' : 's'}${
              result.thinRun ? ' — flagged as a thin run' : ''
            }.`,
          };
        },
        signal,
      );

      void loadSource(
        'backlinks',
        async (inner) => {
          const snapshot = await getLatestBacklinksSummary(projectId, { signal: inner });
          if (!snapshot) return null;
          return {
            at: snapshot.createdAt,
            detail:
              snapshot.status === 'partial'
                ? `Snapshot is partial: ${snapshot.error ?? 'the provider returned an incomplete result'}.`
                : `Provider snapshot recorded as "${snapshot.status}".`,
          };
        },
        signal,
      );

      void loadSource(
        'presence',
        async (inner) => {
          const inventory = await getPresenceInventory(projectId, { signal: inner });
          if (!inventory.lastRun) return null;
          return {
            at: inventory.lastRun.finishedAt ?? inventory.lastRun.startedAt,
            detail: `${inventory.accounts.length} account(s) recorded; ${inventory.counts.confirmed} confirmed.`,
          };
        },
        signal,
      );

      void loadSource(
        'competitors',
        async (inner) => {
          const list = await getNamedCompetitors(projectId, { signal: inner });
          if (list.tracked.length === 0) return null;
          return {
            at: null,
            detail: `${list.tracked.length} tracked competitor(s); ${list.readiness.observations} observation(s) available for comparison.`,
          };
        },
        signal,
      );

      void loadSource(
        'strategy',
        async (inner) => {
          const plan = await getActionPlan(projectId, { signal: inner });
          if (!plan) return null;
          return { at: plan.updatedAt, detail: `${plan.recommendations.length} ranked recommendation(s).` };
        },
        signal,
      );
    },
    [projectId, loadSource],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** The audit generation will actually read, and whose URL it will persist. */
  const latestAudit = useMemo(() => {
    if (!audits || audits.length === 0) return null;
    return audits[0];
  }, [audits]);

  const coverage = useMemo(() => coverageFromManifest(manifest), [manifest]);

  const missingSections = useMemo(() => {
    const names: string[] = [];
    if (sources.strategy.status === 'absent' && sources.findings.status === 'absent') {
      names.push('Growth roadmap (no strategy build and no findings run)');
    }
    if (sources.backlinks.status === 'absent') names.push('Backlinks (no provider refresh has run)');
    if (sources.presence.status === 'absent') names.push('Digital presence (discovery has never run)');
    if (sources.competitors.status === 'absent') names.push('Competitors (no tracked competitors)');
    return names;
  }, [sources]);

  const prerequisites = useMemo<ConfiguratorPrerequisite[]>(() => {
    const list: ConfiguratorPrerequisite[] = [
      {
        label: 'Report title',
        met: title.trim().length > 0,
        detail: 'The title becomes the report slug and the cover heading.',
      },
      {
        label: 'A completed technical audit for this project',
        met: Boolean(latestAudit),
        detail: latestAudit
          ? `Generation reads the most recent audit and persists its URL, so this report will cover ${latestAudit.targetUrl ?? 'the audited target'}.`
          : 'Report generation reads the latest technical audit. Without one there is nothing to build a report from — run a technical audit first.',
      },
    ];
    return list;
  }, [title, latestAudit]);

  const configuration = useMemo<ObservedConfiguration[]>(() => {
    const entries: ObservedConfiguration[] = [
      {
        label: 'Technical audit',
        availability: latestAudit ? 'available' : 'unavailable',
        detail: latestAudit
          ? `Most recent audit is ${latestAudit.status}.`
          : 'No audit exists, so no report can be generated.',
        lastSuccessfulRunAt: latestAudit?.completedAt ?? undefined,
        actionLabel: latestAudit ? undefined : 'Run a technical audit',
        actionHref: latestAudit ? undefined : `/projects/${projectId}/research/website`,
      },
    ];

    const describe = (label: string, key: string, actionHref?: string): ObservedConfiguration => {
      const state = sources[key];
      if (!state || state.status === 'loading') {
        return { label, availability: 'unverified', detail: 'Reading…' };
      }
      if (state.status === 'present') {
        return {
          label,
          availability: 'available',
          detail: state.detail,
          lastSuccessfulRunAt: state.at ?? undefined,
        };
      }
      if (state.status === 'unreadable') {
        return { label, availability: 'unverified', detail: state.message };
      }
      return {
        label,
        availability: 'unavailable',
        detail: `${state.detail} The report will state that this section is not part of the snapshot.`,
        actionLabel: 'Run it first',
        actionHref,
      };
    };

    entries.push(describe('Findings copy (what/why/fix)', 'findings', `/projects/${projectId}/findings`));
    entries.push(describe('Backlinks snapshot', 'backlinks', `/projects/${projectId}/research/authority/backlinks`));
    entries.push(describe('Digital presence', 'presence', `/projects/${projectId}/research/presence`));
    entries.push(describe('Tracked competitors', 'competitors', `/projects/${projectId}/research/competitors`));
    entries.push(describe('Growth / action plan', 'strategy', `/projects/${projectId}/research/roadmap`));
    return entries;
  }, [latestAudit, sources, projectId]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Prepare a report" />
        <ErrorState error={error} onRetry={() => void load(new AbortController().signal)} />
      </div>
    );
  }

  if (!project || !audits) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          domain: project.domain,
          mode: 'live',
          runLabel: latestAudit?.id ? `Audit ${latestAudit.id.slice(0, 8)}` : undefined,
        }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: project.name, href: `/projects/${projectId}` },
          { label: 'Reports', href: `/projects/${projectId}/reports` },
          { label: 'Prepare' },
        ]}
        title="Prepare a report"
        context="A report is a snapshot of the evidence that exists at the moment it is generated. Nothing is fetched that has not already been run."
      />

      {!latestAudit ? (
        // The one blocking prerequisite, stated before anything else so the
        // screen does not offer a form that cannot succeed.
        <EmptyState
          variant="not-measured"
          subject="a report"
          prerequisite="A technical audit has to run first — generation reads the most recent one and there is none."
          action={{
            label: 'Open website health',
            href: `/projects/${projectId}/research/website`,
          }}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Title</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="report-title">Report title</Label>
          <Input
            id="report-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`${project.name} — AI visibility diagnostic`}
            maxLength={180}
            aria-describedby="report-title-help"
          />
          <p id="report-title-help" className="text-meta text-muted-foreground">
            Required. The title is stored on the report and becomes its URL slug;
            slugs are not editable afterwards, so pick the wording you want the
            client to see.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Project target</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-meta text-muted-foreground">Target that will be recorded</span>
            <span className="font-mono text-table">{latestAudit?.targetUrl ?? project.domain}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-meta text-muted-foreground">Taken from</span>
            <span className="text-table">
              {latestAudit ? (
                <>
                  Technical audit <span className="font-mono">{latestAudit.id.slice(0, 8)}</span>,{' '}
                  {latestAudit.status}
                  {latestAudit.completedAt ? (
                    <>
                      {' '}
                      <Timestamp value={latestAudit.completedAt} />
                    </>
                  ) : null}
                </>
              ) : (
                'No technical audit exists for this project.'
              )}
            </span>
          </div>
          <p className="text-meta text-muted-foreground">
            Generation always uses the latest technical audit and persists{' '}
            <em>that audit&apos;s</em> URL. A different target cannot be requested
            from this screen, because the report would then describe one site and
            claim another.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Source freshness and coverage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {coverage ? (
            <CoveragePanel
              summary={coverage}
              title="Pinned evidence coverage"
              contextNote={
                manifest?.freshness?.statement ??
                'Coverage counts come from the most recent pinned evidence manifest.'
              }
            />
          ) : (
            <EmptyState
              variant="not-measured"
              subject="evidence coverage"
              prerequisite="No evidence manifest has been pinned for this project yet, so how much of the agreed evidence returned is unknown — not zero. Generating this report will attempt to pin one."
            />
          )}

          {manifest?.freshness ? (
            <p className="text-table text-muted-foreground">
              Latest source observed{' '}
              {manifest.freshness.latestSourceObservedAt ? (
                <Timestamp value={manifest.freshness.latestSourceObservedAt} />
              ) : (
                'never'
              )}
              {manifest.freshness.stalenessDays !== null ? (
                <>
                  {' '}
                  · {manifest.freshness.stalenessDays} day(s) before the window end — coverage
                  is not complete to the window edge.
                </>
              ) : null}
            </p>
          ) : null}

          <ul className="divide-y divide-border">
            {(['findings', 'backlinks', 'presence', 'competitors', 'strategy'] as const).map((key) => {
              const state = sources[key];
              return (
                <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <span className="text-table capitalize">{key === 'strategy' ? 'Growth / action plan' : key}</span>
                  <span className="text-meta text-muted-foreground">
                    {!state || state.status === 'loading' ? 'Reading…' : null}
                    {state?.status === 'present' ? (
                      <>
                        Present{state.at ? (
                          <>
                            {' · last written '}
                            <Timestamp value={state.at} />
                          </>
                        ) : null}
                      </>
                    ) : null}
                    {state?.status === 'absent' ? 'Never run — will be absent from the report' : null}
                    {state?.status === 'unreadable' ? state.message : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Sections this report will not contain</CardTitle>
        </CardHeader>
        <CardContent>
          {missingSections.length === 0 ? (
            <p className="text-table text-muted-foreground">
              Every optional section has a source. Whether each one is complete is a
              separate question, answered by the coverage panel above.
            </p>
          ) : (
            <div className="space-y-3">
              {/* The only alert variant is `default`/`destructive`, and a
                  missing optional section is a warning, not a failure — so the
                  tone is carried on the icon rather than by the variant. */}
              <Alert>
                <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
                <AlertTitle>
                  {missingSections.length} section{missingSections.length === 1 ? '' : 's'} will be
                  absent
                </AlertTitle>
                <AlertDescription>
                  These sections are stated as not part of the snapshot in the report
                  itself. They are named here so this is a choice, not a surprise.
                </AlertDescription>
              </Alert>
              <ul className="list-disc space-y-1 pl-5 text-table">
                {missingSections.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Generation impact</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-table">
          <p>
            Generating is not a preview. It reads the latest technical audit and adds a
            <strong> new score run</strong>, so a naive score-history timeline will show
            this as a new measurement.
          </p>
          <p>
            It also snapshots whichever of the five optional sources exist, and calls the
            competitor gap service — which may scan the client&apos;s current technology.
            Expect it to take a while, and expect rate limiting at three generations per
            minute.
          </p>
          <p className="text-muted-foreground">
            The new report is private and immediately readable by this client&apos;s portal.
            There is no hidden editorial draft state in this build: review the inputs
            above <em>before</em> generating, or generate and then review the report
            before telling anyone it exists.
          </p>
        </CardContent>
      </Card>

      <RunConfigurator
        startLabel="Generate report"
        prerequisites={prerequisites}
        parameters={[
          { key: 'title', label: 'Title', value: title.trim() || 'Not set yet' },
          { key: 'target', label: 'Target URL (from the audit)', value: latestAudit?.targetUrl ?? project.domain },
          {
            key: 'audit',
            label: 'Source audit',
            value: latestAudit ? `${latestAudit.id} (${latestAudit.status})` : 'None — generation is blocked',
          },
        ]}
        scope={
          <>
            One new report for <span className="font-medium">{project.name}</span>, built from the
            latest technical audit and whichever of the five optional sources exist today.
          </>
        }
        configuration={configuration}
        // No estimate: generation's cost is internal compute (an LLM is not
        // called), and inventing requests or credits for it would be a number
        // nobody can reconcile against a bill.
        onStart={async () => {
          if (!latestAudit) return;
          setStartError(null);
          await generateReport(projectId, {
            title: title.trim(),
            targetUrl: latestAudit.targetUrl ?? project.domain,
          });
        }}
        onStarted={() => {
          // The reader is the report's canonical destination; the library is
          // where a failed navigation can still be recovered from.
          router.push(`/projects/${projectId}/reports`);
        }}
        // Generation scores the project, snapshots five sources and may scan
        // the client's technology, so the 60 s default is too tight — a lost
        // response here would be reported for a run that was simply slow.
        startTimeoutMs={120_000}
        reconcileHref={`/projects/${projectId}/reports`}
        error={startError}
        // Generation is synchronous: the request returns the report, so there
        // is no durable in-flight state for this screen to be waiting on.
        runInFlight={false}
      />
    </div>
  );
}

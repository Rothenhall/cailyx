'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowRight, MousePointerClick, RefreshCw, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import {
  CTA_EVENT_TYPES,
  LEAD_STATUSES,
  getLead,
  getPipelineMath,
  listScorecards,
  listUpgrades,
  logLeadCta,
  updateLeadStatus,
  type CtaEventType,
  type Lead,
  type LeadStatus,
  type PipelineMath,
  type ScorecardRun,
  type Upgrade,
} from '@/services/sales';

/**
 * SL03 — Lead detail.
 *
 * design_plan.md §4.2: *"Contact/source, CTA history, scorecard, qualification,
 * upgrade links, status."*
 *
 * ## Two distinctions the layout keeps
 *
 * 1. **A status is a claim; a CTA event is an observation.** `status` is a
 *    mutable field on the lead, while `ctaEvents` is an append-only log — the
 *    API pushes to it and never overwrites it (FR-11.3). Recording that someone
 *    clicked is therefore a different action from moving the lead to `booked`,
 *    and this screen keeps them in separate cards with separate controls. A
 *    status change never rewrites what was clicked.
 * 2. **A scorecard is evidence; a qualification model is arithmetic.** The
 *    first is a measurement with named problems behind it (§6.1). The second is
 *    §5.11's scenario arithmetic and is labelled as such wherever it appears —
 *    it is not a forecast built from acquisition data, because no such data is
 *    behind it.
 *
 * ## Handoff
 *
 * The handoff to delivery — associating the project with a client and starting
 * onboarding — is a project-level action, not a lead field. §5.11 notes the
 * current limitation plainly: a project created under a client cannot attach an
 * existing domain, so the screen links to where the work happens and does not
 * pretend a button here completes it.
 */

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  reached: 'Reached',
  booked: 'Booked',
  won: 'Won',
  lost: 'Lost',
};

const STATUS_TONE: Record<LeadStatus, StatusTone> = {
  new: 'info',
  reached: 'info',
  booked: 'warning',
  won: 'success',
  lost: 'neutral',
};

const NEXT_STATUS: Record<LeadStatus, LeadStatus | null> = {
  new: 'reached',
  reached: 'booked',
  booked: 'won',
  won: null,
  lost: null,
};

const CTA_LABEL: Record<string, string> = {
  'book-call': 'Book-call CTA clicked',
  'review-ask': 'Review ask shown',
  'upgrade-click': 'Upgrade checkout opened',
};

const UPGRADE_TONE: Record<string, StatusTone> = {
  created: 'info',
  clicked: 'warning',
  completed: 'success',
  abandoned: 'neutral',
};

export default function LeadDetailPage() {
  const params = useParams<{ projectId: string; leadId: string }>();
  const { projectId, leadId } = params;

  const [lead, setLead] = useState<Lead | null>(null);
  const [scorecards, setScorecards] = useState<ScorecardRun[] | null>(null);
  const [upgrades, setUpgrades] = useState<Upgrade[] | null>(null);
  const [qualification, setQualification] = useState<PipelineMath | null>(null);
  const [qualificationMissing, setQualificationMissing] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [leadResult, scorecardResult, upgradeResult] = await Promise.all([
          getLead(projectId, leadId, { signal }),
          listScorecards(projectId, { signal }),
          listUpgrades(projectId, { signal }),
        ]);
        setLead(leadResult);
        setScorecards(scorecardResult);
        setUpgrades(upgradeResult);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
        return;
      }
      // Qualification is optional: a 404 here means "never computed", which is
      // a state to report, not a failure of this page.
      try {
        setQualification(await getPipelineMath(projectId, { signal }));
        setQualificationMissing(false);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const normalized = toApiError(caught);
        if (normalized.kind === 'not-found') {
          setQualification(null);
          setQualificationMissing(true);
        } else {
          setQualification(null);
          setQualificationMissing(false);
        }
      }
    },
    [projectId, leadId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Lead" />
        <ErrorState
          error={error}
          onRetry={() => void load()}
          // A 404 here is most often a lead on another project, so the copy
          // names that rather than leaking whether the record exists.
          notFoundReason="missing-or-private"
        />
      </div>
    );
  }

  if (!lead || !scorecards || !upgrades) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  const status = lead.status as LeadStatus;
  const nextStatus = NEXT_STATUS[status] ?? null;
  const linkedScorecard =
    scorecards.find((run) => run.id === lead.scorecardRunId) ??
    (lead.scorecardRunId ? null : scorecards[0] ?? null);
  const leadUpgrades = upgrades.filter((upgrade) => upgrade.leadId === lead.id);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Sales pipeline', href: '/ops/sales' },
          { label: lead.name ?? lead.email },
        ]}
        title={lead.name ?? lead.email}
        context={
          <>
            {lead.email} · source <strong>{lead.source}</strong> · captured{' '}
            <Timestamp value={lead.createdAt} />
          </>
        }
        status={<StatusPill label={STATUS_LABEL[status] ?? lead.status} tone={STATUS_TONE[status] ?? 'neutral'} />}
        secondaryActions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/projects/${projectId}`}>Open the project</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <StatusCard
          projectId={projectId}
          lead={lead}
          nextStatus={nextStatus}
          onChanged={() => void load()}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Contact and source</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="Email" value={lead.email} mono />
              <Field
                label="Name"
                value={lead.name}
                fallback="No name was recorded — the email is the identifier"
              />
              <Field label="Source" value={lead.source} />
              <div>
                <dt className="text-meta text-muted-foreground">Captured</dt>
                <dd className="mt-0.5 text-table">
                  <Timestamp value={lead.createdAt} />
                </dd>
              </div>
            </dl>
            <Separator className="my-4" />
            <p className="text-meta text-muted-foreground">
              Lead attribution is project-bound: this record belongs to the
              project below, and a different project&rsquo;s lead is a different
              record even for the same address.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-meta text-muted-foreground">Project</span>
              <span className="font-mono text-meta">{projectId}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-table font-medium">CTA history</CardTitle>
            <p className="text-meta text-muted-foreground">
              Append-only. Each entry records that something was clicked or
              shown, at a time. It is not rewritten when the lead&rsquo;s status
              changes.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {lead.ctaEvents.length === 0 ? (
              <EmptyState
                variant="not-measured"
                subject="CTA events for this lead"
                prerequisite="A delivered email, a scorecard share, or an upgrade link being opened."
                layout="inline"
              />
            ) : (
              <ol className="space-y-3">
                {/* Newest first, and the order is stated rather than implied. */}
                {[...lead.ctaEvents]
                  .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
                  .map((event, index) => (
                    <li key={`${event.type}-${event.at}-${index}`} className="flex gap-3">
                      <MousePointerClick
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0">
                        <div className="text-table font-medium">
                          {CTA_LABEL[event.type] ?? event.type}
                        </div>
                        <div className="text-meta text-muted-foreground">
                          <Timestamp value={event.at} />
                          {event.meta && Object.keys(event.meta).length > 0 ? (
                            <>
                              {' · '}
                              {Object.entries(event.meta)
                                .map(([key, value]) => `${key}=${String(value)}`)
                                .join(', ')}
                            </>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
              </ol>
            )}

            <Separator />
            <LogCtaForm projectId={projectId} leadId={lead.id} onLogged={() => void load()} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-table font-medium">Scorecard</CardTitle>
              <p className="text-meta text-muted-foreground">
                The Rung-0 diagnostic this lead came from, when there is one.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {!linkedScorecard ? (
                <>
                  <EmptyState
                    variant="not-measured"
                    subject="a scorecard for this lead"
                    prerequisite="A scorecard run shared with this lead, or a lead captured from one."
                    layout="inline"
                    {...(scorecards.length > 0
                      ? {
                          action: {
                            label: 'Open the most recent scorecard',
                            href: `/projects/${projectId}/scorecards/${scorecards[0].id}`,
                          },
                        }
                      : {})}
                  />
                  {scorecards.length > 0 ? (
                    <p className="text-meta text-muted-foreground">
                      This project has {scorecards.length} scorecard run
                      {scorecards.length === 1 ? '' : 's'}, but none is linked to
                      this lead. A scorecard is linked when the lead was captured
                      from it.
                    </p>
                  ) : (
                    <p className="text-meta text-muted-foreground">
                      This project has no scorecard run at all. Running one is a
                      separate action with its own cost — it performs a fresh
                      technical audit.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-kpi tabular-nums font-semibold">
                        {formatNumber(linkedScorecard.score)}
                      </p>
                      <p className="text-meta text-muted-foreground">
                        Band <strong>{linkedScorecard.band}</strong> · depth{' '}
                        <strong>{linkedScorecard.depth}</strong>
                      </p>
                    </div>
                    {linkedScorecard.nonObvious ? (
                      <StatusPill label="Includes a non-obvious problem" tone="info" />
                    ) : (
                      <StatusPill label="No non-obvious problem flagged" tone="unmeasured" />
                    )}
                  </div>
                  <p className="text-meta text-muted-foreground">
                    Run <Timestamp value={linkedScorecard.createdAt} /> ·{' '}
                    {linkedScorecard.problems.length} named problem
                    {linkedScorecard.problems.length === 1 ? '' : 's'}
                    {linkedScorecard.id === lead.scorecardRunId ? ' · linked to this lead' : ''}
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${projectId}/scorecards/${linkedScorecard.id}`}>
                      Open the scorecard
                      <ArrowRight aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-table font-medium">Qualification</CardTitle>
              <p className="text-meta text-muted-foreground">
                Scenario arithmetic from stated assumptions — never a forecast
                from acquisition data.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {qualification ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusPill
                      label={
                        qualification.verdict === 'feasible'
                          ? 'Feasible against the stated market'
                          : 'Fiction against the stated market'
                      }
                      tone={qualification.verdict === 'feasible' ? 'success' : 'danger'}
                    />
                    {qualification.ratio !== null ? (
                      <span className="text-meta text-muted-foreground">
                        Needs {qualification.ratio.toFixed(2)}× the stated market
                        (threshold {qualification.fictionFactor}×)
                      </span>
                    ) : null}
                  </div>
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                    <Field
                      label="Revenue target"
                      value={formatNumber(qualification.revenueTarget)}
                    />
                    <Field label="ACV" value={formatNumber(qualification.acv)} />
                    <Field
                      label="Visitors needed"
                      value={formatNumber(qualification.stages.visitors)}
                    />
                  </dl>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${projectId}/qualification`}>
                      Open the qualification screen
                      <ArrowRight aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </>
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="pipeline qualification for this project"
                  prerequisite={
                    qualificationMissing
                      ? 'A revenue target and the conversion rates, entered on the qualification screen.'
                      : 'The qualification read failed, which is different from never having been computed. Reload to retry.'
                  }
                  layout="inline"
                  action={{
                    label: 'Open qualification',
                    href: `/projects/${projectId}/qualification`,
                  }}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-table font-medium">Upgrade links</CardTitle>
              <p className="text-meta text-muted-foreground">
                Checkout links issued for this lead. Issued, clicked and
                completed are three different facts.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {leadUpgrades.length === 0 ? (
                <EmptyState
                  variant="not-measured"
                  subject="an upgrade link for this lead"
                  prerequisite="Issuing one on the upgrades screen. Without a configured checkout URL the route refuses (503) rather than recording a link that leads nowhere."
                  layout="inline"
                  action={{
                    label: 'Open upgrades',
                    href: `/projects/${projectId}/upgrades`,
                  }}
                />
              ) : (
                <ul className="space-y-2">
                  {leadUpgrades.map((upgrade) => (
                    <li
                      key={upgrade.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{upgrade.tier}</Badge>
                        <StatusPill
                          label={upgrade.status}
                          tone={UPGRADE_TONE[upgrade.status] ?? 'neutral'}
                        />
                      </div>
                      <span className="text-meta text-muted-foreground">
                        Issued <Timestamp value={upgrade.createdAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link href={`/projects/${projectId}/upgrades`}>
                  <Target aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
                  Open the checkout ledger
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Status is edited here, deliberately apart from the CTA log: moving a lead is
 * a claim about what happened, and recording a click is an observation of it.
 */
function StatusCard({
  projectId,
  lead,
  nextStatus,
  onChanged,
}: {
  projectId: string;
  lead: Lead;
  nextStatus: LeadStatus | null;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<string>(lead.status);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(lead.status);
  }, [lead.status]);

  async function save(status: LeadStatus) {
    setBusy(true);
    setError(null);
    try {
      await updateLeadStatus(projectId, lead.id, status);
      onChanged();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-table font-medium">Status</CardTitle>
        <p className="text-meta text-muted-foreground">
          The pipeline stage this lead is at. Changing it records a claim; it
          does not modify the CTA history beside it.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <ErrorState error={error} layout="inline" preserveNotice="The status was not changed." /> : null}

        <div className="space-y-2">
          <Label htmlFor="lead-status">Pipeline stage</Label>
          <Select value={draft} onValueChange={setDraft}>
            <SelectTrigger id="lead-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAD_STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {STATUS_LABEL[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">
            Stages are not enforced in sequence: a lead can be marked{' '}
            <strong>lost</strong> from any stage, and reopening a lost lead means
            setting a status here rather than a separate action.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || draft === lead.status}
            onClick={() => void save(draft as LeadStatus)}
          >
            {busy ? 'Saving…' : 'Save status'}
          </Button>
          {nextStatus && draft === lead.status ? (
            <Button variant="outline" disabled={busy} onClick={() => void save(nextStatus)}>
              Advance to {STATUS_LABEL[nextStatus]}
              <ArrowRight aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        {draft !== lead.status ? (
          <p className="text-meta text-muted-foreground">
            Unsaved change: {STATUS_LABEL[lead.status as LeadStatus] ?? lead.status} →{' '}
            {STATUS_LABEL[draft as LeadStatus] ?? draft}.
          </p>
        ) : null}

        <Separator />
        <p className="text-meta text-muted-foreground">
          Handing this lead over to delivery associates the project with a
          client and starts onboarding. That is a project-level action, and §5.11
          records a current limitation worth knowing: a project created under a
          client cannot attach an existing domain, so the domain is chosen when
          the project is created.
        </p>
      </CardContent>
    </Card>
  );
}

function LogCtaForm({
  projectId,
  leadId,
  onLogged,
}: {
  projectId: string;
  leadId: string;
  onLogged: () => void;
}) {
  const [type, setType] = useState<CtaEventType>('book-call');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await logLeadCta(projectId, leadId, {
        type,
        meta: note.trim() === '' ? undefined : { note: note.trim() },
      });
      setNote('');
      onLogged();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <h4 className="text-table font-medium">Record a CTA event</h4>
      <p className="text-meta text-muted-foreground">
        For a click that happened outside the app — a call booked by email, say.
        Entries append; none is ever edited or removed.
      </p>
      {error ? <ErrorState error={error} layout="inline" /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="cta-type">Event</Label>
          <Select value={type} onValueChange={(value) => setType(value as CtaEventType)}>
            <SelectTrigger id="cta-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CTA_EVENT_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {CTA_LABEL[option] ?? option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="cta-note">Note</Label>
          <Input
            id="cta-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Where it happened, optional"
          />
        </div>
      </div>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? 'Recording…' : 'Record CTA event'}
      </Button>
    </form>
  );
}

function Field({
  label,
  value,
  mono,
  fallback,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  fallback?: string;
}) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-table ${mono ? 'font-mono' : ''}`}>
        {value ?? (
          <span className="text-muted-foreground">
            {fallback ?? 'Not recorded'}
          </span>
        )}
      </dd>
    </div>
  );
}

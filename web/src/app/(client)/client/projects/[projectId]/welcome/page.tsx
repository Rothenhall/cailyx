'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  CircleDashed,
  ClipboardCopy,
  Mail,
  Plug,
  Send,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatDate } from '@/lib/format';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  confirmPortalBusinessProfile,
  getPortalBusinessProfile,
  getPortalChecklist,
  savePortalBusinessProfileDraft,
  updatePortalOnboardingRequest,
  type PortalBusinessProfileResponse,
  type PortalChecklist,
  type PortalChecklistItem,
} from '@/services/portal-profile';
import {
  createPortalInvite,
  listPortalGoogleConnections,
  listPortalInvites,
  PORTAL_GOOGLE_SERVICE_LABEL,
  PORTAL_MEMBER_ROLE_DESCRIPTION,
  PORTAL_MEMBER_ROLE_LABEL,
  type PortalGoogleConnection,
  type PortalInvite,
  type PortalInviteCreated,
  type PortalMemberRole,
} from '@/services/portal-access';

/**
 * CP04 — Welcome checklist.
 *
 * design_plan.md §4.5: *"Confirm company/services/markets, invite
 * collaborators, connect GSC/GA4, agree scope."*
 *
 * This screen is the client's onboarding contract, so it obeys three rules that
 * matter more here than anywhere else:
 *
 *  1. **Every line names its own evidence.** The checklist arrives from
 *     `getChecklist`, which builds each item from the record behind it — the
 *     profile line reads the confirmed version, the seat line counts real
 *     members, the scope line reads the project's cycles. A line with no backing
 *     record is `not-requested`, which this page never renders as "done".
 *  2. **Confirming is an act with a version, not a checkbox.** Saving writes a
 *     *draft*; confirming writes a **new version** carrying who confirmed it and
 *     when, so what the client was shown when they agreed remains on file. The
 *     page keeps those two actions visibly separate.
 *  3. **An invitation is a credential, shown once.** `token`/`acceptUrl` come
 *     back exactly once, are never retrievable again, and §5.1 forbids putting a
 *     bearer credential into a URL this app navigates to or logs — so the page
 *     displays them for hand-over and does not link to them.
 *
 * The Google step is *performed* on the connections screen (it is an OAuth
 * redirect); this page reports its state and links there, rather than pretending
 * a button here could complete consent.
 */
export default function ClientWelcomePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [checklist, setChecklist] = useState<PortalChecklist | null>(null);
  const [profile, setProfile] = useState<PortalBusinessProfileResponse | null>(null);
  const [invites, setInvites] = useState<PortalInvite[] | null>(null);
  const [google, setGoogle] = useState<PortalGoogleConnection[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, checklistResult, profileResult, invitesResult, googleResult] =
          await Promise.allSettled([
            listPortalProjectSummaries({ signal }),
            getPortalChecklist(projectId, { signal }),
            getPortalBusinessProfile(projectId, {}, { signal }),
            listPortalInvites({ signal }),
            listPortalGoogleConnections(projectId, { signal }),
          ]);

        if (projects.status === 'rejected') throw projects.reason;
        setProject(projects.value.find((entry) => entry.id === projectId) ?? null);
        if (checklistResult.status === 'fulfilled') setChecklist(checklistResult.value);
        if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
        if (invitesResult.status === 'fulfilled') setInvites(invitesResult.value);
        if (googleResult.status === 'fulfilled') setGoogle(googleResult.value);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Welcome" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!checklist || !project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  const clientItems = checklist.items.filter((item) => item.owner === 'client');
  const operatorItems = checklist.items.filter((item) => item.owner === 'operator');

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Welcome' },
        ]}
        title="Getting set up"
        context="Four things make the measurement meaningful. Each line below says what it is waiting on."
      />

      {checklist.blocking.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>
            {checklist.blocking.length} item{checklist.blocking.length === 1 ? '' : 's'} waiting on
            you
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Work is held up behind these, so nothing moves until they are answered.</p>
            <ul className="space-y-1">
              {checklist.blocking.map((entry) => (
                <li key={entry.requestId}>
                  <span className="font-medium">{entry.title}</span>
                  {entry.dueAt ? (
                    <span className="text-meta">
                      {' '}
                      · due <Timestamp value={entry.dueAt} dateOnly />
                      {entry.overdue ? ' (overdue)' : ''}
                    </span>
                  ) : null}
                  {entry.blockedWorkLinks.length > 0 ? (
                    <span className="block text-meta">
                      Holding up:{' '}
                      {entry.blockedWorkLinks
                        .map((link) =>
                          link.missing ? `${link.title ?? 'an item'} (no longer present)` : (link.title ?? 'an item'),
                        )
                        .join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── The checklist itself ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Checklist</CardTitle>
          <span className="text-meta text-muted-foreground">
            {checklist.counts.done} done · {checklist.counts.outstanding} outstanding ·{' '}
            {checklist.counts.notRequested} not requested
          </span>
        </CardHeader>
        <CardContent className="space-y-5">
          {!checklist.hasClient ? (
            <Alert variant="destructive" role="alert">
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>This project has no client account attached</AlertTitle>
              <AlertDescription>
                Nobody on your side owns the items below, so they cannot be
                marked done from here. Your delivery lead can attach the account.
              </AlertDescription>
            </Alert>
          ) : null}

          <ChecklistGroup
            title="What we need from you"
            items={clientItems}
            projectId={projectId}
            onMarked={load}
          />
          <ChecklistGroup
            title="What Cailyx is doing"
            items={operatorItems}
            projectId={projectId}
            onMarked={load}
          />

          {checklist.items.length === 0 ? (
            <EmptyState
              variant="not-measured"
              subject="the onboarding checklist"
              prerequisite="The checklist is built from the records behind it, and this project has none yet."
            />
          ) : null}

          {checklist.missingBlockedWork.length > 0 ? (
            <p className="text-meta text-muted-foreground">
              {checklist.missingBlockedWork.length} work item
              {checklist.missingBlockedWork.length === 1 ? '' : 's'} referenced by an outstanding
              request no longer exist{checklist.missingBlockedWork.length === 1 ? 's' : ''} — your
              delivery team has been told rather than the reference being dropped.
            </p>
          ) : null}

          <p className="text-meta text-muted-foreground">
            Generated <Timestamp value={checklist.generatedAt} /> from the records behind each line,
            not from a hand-maintained list.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BusinessFactsCard
          projectId={projectId}
          profile={profile}
          onChanged={load}
        />

        {/* ── Collaborators ────────────────────────────────────────────── */}
        <InviteCard invites={invites} onChanged={load} />

        {/* ── Connections ──────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-subsection">Connect your search and analytics data</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-table text-muted-foreground">
              Connecting your own Google account lets us read the property or
              site mapped to this project. Authorization and mapping are separate
              steps: granting access to an account does not by itself pick which
              property we read.
            </p>

            {google === null ? (
              <EmptyState
                variant="not-measured"
                subject="Google connections"
                prerequisite="The connection state could not be read just now. Open the connections screen to see the current state."
                action={{ label: 'Open connections', href: `/client/projects/${projectId}/connections` }}
              />
            ) : (
              <ul className="divide-y divide-border">
                {google.map((connection) => (
                  <li
                    key={connection.service}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="text-table">
                      {PORTAL_GOOGLE_SERVICE_LABEL[connection.service]}
                      {connection.googleEmail ? (
                        <span className="ml-2 text-meta text-muted-foreground">
                          {connection.googleEmail}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusPill
                        label={connectionLabel(connection)}
                        tone={
                          connection.access === 'none'
                            ? 'unmeasured'
                            : connection.expired
                              ? 'warning'
                              : 'success'
                        }
                      />
                      {connection.mappedResourceLabel ? (
                        <span className="text-meta text-muted-foreground">
                          mapped to {connection.mappedResourceLabel}
                        </span>
                      ) : connection.access !== 'none' ? (
                        <span className="text-meta text-warning-foreground">
                          no property chosen yet
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <Button asChild variant="outline" size="sm">
              <Link href={`/client/projects/${projectId}/connections`}>
                <Plug aria-hidden="true" className="mr-2 h-4 w-4" />
                Open connections
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Checklist lines ─────────────────────────────────────────────────────

/**
 * One group of checklist lines.
 *
 * `not-requested` and `unavailable` are rendered as themselves: §3.5 is
 * explicit that "not requested" is not "done", and that an unavailable line is
 * not a failure. A client-owned line in an `outstanding` state gets the two
 * actions a client actually has — "I've started it" and "I've done it" — and
 * nothing else: waiving an ask is the operator's decision, not the client's.
 */
function ChecklistGroup({
  title,
  items,
  projectId,
  onMarked,
}: {
  title: string;
  items: PortalChecklistItem[];
  projectId: string;
  onMarked: () => Promise<void> | void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <section aria-label={title} className="space-y-2">
        <h3 className="text-table font-semibold">{title}</h3>
        <p className="text-meta text-muted-foreground">Nothing in this group.</p>
      </section>
    );
  }

  async function mark(item: PortalChecklistItem, status: 'in-progress' | 'done') {
    if (!item.requestId) return;
    setBusyKey(item.key);
    setRowError(null);
    try {
      await updatePortalOnboardingRequest(projectId, item.requestId, { status });
      await onMarked();
    } catch (caught) {
      setRowError(
        clientActionMessage(caught, 'That could not be recorded. Try again.'),
      );
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-table font-semibold">{title}</h3>
      {rowError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{rowError}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StateIcon state={item.state} />
                <span className="text-table font-medium">{item.label}</span>
                <StatusPill label={stateLabel(item.state)} tone={stateTone(item.state)} />
              </div>
              <p className="mt-1 text-meta text-muted-foreground">{item.detail}</p>
              <p className="text-meta text-muted-foreground">
                Where this came from: {provenanceLabel(item.source)}
                {item.dueAt ? (
                  <>
                    {' '}
                    · due <Timestamp value={item.dueAt} dateOnly />
                  </>
                ) : null}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {item.owner === 'client' && item.requestId && item.state === 'outstanding' ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyKey === item.key}
                    onClick={() => void mark(item, 'done')}
                  >
                    I&apos;ve done this
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyKey === item.key}
                    onClick={() => void mark(item, 'in-progress')}
                  >
                    Started it
                  </Button>
                </>
              ) : null}
              {linkForItem(item, projectId) ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={linkForItem(item, projectId) as string}>Open</Link>
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StateIcon({ state }: { state: PortalChecklistItem['state'] }) {
  if (state === 'done') {
    return <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-success-foreground" />;
  }
  if (state === 'unavailable') {
    return (
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning-foreground" />
    );
  }
  return <CircleDashed aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

/**
 * §4.3: "Provenance → Where this came from. Website, your confirmation,
 * connected account, or measured result." The stored `source` is the name of
 * an internal record (`business-profile`), so it is mapped to the place the
 * client knows. An unmapped record is described by what it is rather than
 * printed as a slug.
 */
const PROVENANCE_LABEL: Record<string, string> = {
  'business-profile': 'the business information you confirmed',
  'business-profile-confirmation': 'the business information you confirmed',
  'connected-accounts': 'a connected account',
  integrations: 'a connected account',
  google: 'a connected account',
  'google-analytics': 'your connected Google Analytics account',
  'google-search-console': 'your connected Google Search Console account',
  content: 'the content you have been sent',
  'content-asset': 'the content you have been sent',
  approvals: 'a request we sent you',
  messages: 'your messages thread',
  subscription: 'your account records',
  billing: 'your account records',
  measurement: 'a measurement we ran',
  welcome: 'your answers during set-up',
  profile: 'the profile you confirmed',
};

function provenanceLabel(source: string | null | undefined): string {
  if (!source) return 'your account records';
  const key = source.trim().toLowerCase();
  return PROVENANCE_LABEL[key] ?? 'your account records';
}

function stateLabel(state: PortalChecklistItem['state']): string {
  switch (state) {
    case 'done':
      return 'Done';
    case 'outstanding':
      return 'Outstanding';
    case 'not-requested':
      return 'Not requested yet';
    case 'unavailable':
      // §4.3: "Capability unavailable → Not available for this account yet."
      return 'Not available for this account yet';
  }
}

function stateTone(state: PortalChecklistItem['state']) {
  switch (state) {
    case 'done':
      return 'success' as const;
    case 'outstanding':
      return 'warning' as const;
    case 'not-requested':
      return 'unmeasured' as const;
    case 'unavailable':
      return 'unmeasured' as const;
  }
}

/**
 * Where a checklist line is actually completed.
 *
 * Matched on the item's own `key`/`source` rather than hard-coded per line, so
 * a new backend line renders without a link rather than with a wrong one. A
 * `not-requested` line links to nothing: there is no work to do on it yet.
 */
function linkForItem(item: PortalChecklistItem, projectId: string): string | null {
  const key = `${item.key} ${item.source}`.toLowerCase();
  if (item.state === 'not-requested') return null;
  if (key.includes('profile') || key.includes('business')) return `/client/projects/${projectId}/welcome`;
  if (key.includes('seat') || key.includes('member') || key.includes('collaborator') || key.includes('invite')) {
    return `/client/projects/${projectId}/welcome#collaborators`;
  }
  if (key.includes('google') || key.includes('connect') || key.includes('analytics') || key.includes('console')) {
    return `/client/projects/${projectId}/connections`;
  }
  if (key.includes('scope') || key.includes('cycle') || key.includes('plan')) {
    return `/client/projects/${projectId}/plan`;
  }
  return null;
}

function connectionLabel(connection: PortalGoogleConnection): string {
  if (connection.access === 'none') return 'Not connected';
  if (connection.expired) return 'Access expired';
  if (connection.access === 'delegated') return 'Delegated access';
  return 'Connected';
}

// ── Company facts ───────────────────────────────────────────────────────

/**
 * Confirm company / services / markets.
 *
 * Saving and confirming are deliberately two buttons: saving writes a draft,
 * confirming writes a new version that records who stood behind it. The copy
 * says which one the reader is doing, because "Save" on a screen like this is
 * otherwise easily read as "agree".
 */
function BusinessFactsCard({
  projectId,
  profile,
  onChanged,
}: {
  projectId: string;
  profile: PortalBusinessProfileResponse | null;
  onChanged: () => Promise<void> | void;
}) {
  const current = profile?.profile ?? null;
  const [brandName, setBrandName] = useState('');
  const [services, setServices] = useState('');
  const [markets, setMarkets] = useState('');
  const [goals, setGoals] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'confirm' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!current || dirty) return;
    setBrandName(current.data.brandName ?? '');
    setServices(current.data.services.join(', '));
    setMarkets(current.data.markets.join(', '));
    setGoals(current.data.goals.join('\n'));
  }, [current, dirty]);

  async function onSave() {
    setBusy('save');
    setProblem(null);
    setMessage(null);
    try {
      await savePortalBusinessProfileDraft(projectId, {
        brandName: brandName.trim() || undefined,
        services: splitList(services),
        markets: splitList(markets),
        goals: splitLines(goals),
      });
      setDirty(false);
      setMessage('Saved as a draft. It becomes agreed facts once it is confirmed.');
      await onChanged();
    } catch (caught) {
      setProblem(clientActionMessage(caught, 'That could not be saved.'));
    } finally {
      setBusy(null);
    }
  }

  async function onConfirm() {
    setBusy('confirm');
    setProblem(null);
    setMessage(null);
    try {
      await confirmPortalBusinessProfile(projectId, { version: current?.version });
      setMessage('Confirmed. This version is now on file as the agreed facts.');
      await onChanged();
    } catch (caught) {
      setProblem(
        clientActionMessage(caught, 'That could not be confirmed. Reload and check the current version.'),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-subsection">Company, services and markets</CardTitle>
        {current ? (
          <StatusPill
            label={current.isDraft ? 'Draft — not confirmed' : 'Confirmed'}
            tone={current.isDraft ? 'warning' : 'success'}
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {profile === null ? (
          <EmptyState
            variant="not-measured"
            subject="your company details"
            prerequisite="They could not be read just now. Reload to try again."
          />
        ) : current === null ? (
          <>
            <p className="text-table text-muted-foreground">
              {profile.unavailableReason ??
                'No company details have been captured for this project yet.'}
            </p>
            <FactsForm
              brandName={brandName}
              services={services}
              markets={markets}
              goals={goals}
              onBrandName={setBrandName}
              onServices={setServices}
              onMarkets={setMarkets}
              onGoals={setGoals}
              onDirty={() => setDirty(true)}
            />
          </>
        ) : (
          <>
            <p className="text-table text-muted-foreground">
              {current.isDraft
                ? 'These are drafted but not yet confirmed by anyone, so they are a proposal.'
                : `Confirmed${current.confirmedAt ? ` on ${formatDate(current.confirmedAt)}` : ''}. Editing them starts a new draft; the confirmed version stays on file.`}
            </p>
            <FactsForm
              brandName={brandName}
              services={services}
              markets={markets}
              goals={goals}
              onBrandName={setBrandName}
              onServices={setServices}
              onMarkets={setMarkets}
              onGoals={setGoals}
              onDirty={() => setDirty(true)}
            />
          </>
        )}

        {problem ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        {message ? (
          <Alert role="status">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || (brandName.trim() === '' && services.trim() === '' && markets.trim() === '' && goals.trim() === '')}
            onClick={() => void onSave()}
          >
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !current || !current.isDraft}
            onClick={() => void onConfirm()}
          >
            {busy === 'confirm' ? 'Confirming…' : 'Confirm these are our details'}
          </Button>
        </div>
        {!current?.isDraft ? (
          <p className="text-meta text-muted-foreground">
            {current
              ? 'There is no unconfirmed draft to confirm. Edits you save above create one.'
              : 'Saving a draft is the first step; confirming comes after.'}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FactsForm({
  brandName,
  services,
  markets,
  goals,
  onBrandName,
  onServices,
  onMarkets,
  onGoals,
  onDirty,
}: {
  brandName: string;
  services: string;
  markets: string;
  goals: string;
  onBrandName: (value: string) => void;
  onServices: (value: string) => void;
  onMarkets: (value: string) => void;
  onGoals: (value: string) => void;
  onDirty: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="brand-name">Company name</Label>
        <Input
          id="brand-name"
          value={brandName}
          onChange={(event) => {
            onBrandName(event.target.value);
            onDirty();
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="services">Services you offer</Label>
        <Input
          id="services"
          value={services}
          placeholder="Separate each service with a comma"
          onChange={(event) => {
            onServices(event.target.value);
            onDirty();
          }}
        />
        <p className="text-meta text-muted-foreground">
          Plain text, comma separated — for example: “technical SEO, content, digital PR”.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="markets">Markets you sell into</Label>
        <Input
          id="markets"
          value={markets}
          placeholder="Separate each market with a comma"
          onChange={(event) => {
            onMarkets(event.target.value);
            onDirty();
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="goals">Commercial goals</Label>
        <Textarea
          id="goals"
          value={goals}
          rows={3}
          placeholder="One goal per line, in your own words"
          onChange={(event) => {
            onGoals(event.target.value);
            onDirty();
          }}
        />
      </div>
    </div>
  );
}

// ── Collaborators ───────────────────────────────────────────────────────

/**
 * Invite collaborators.
 *
 * Two things are stated plainly rather than implied: an invitation whose email
 * failed still exists (so the inviter is told to relay it), and the accept link
 * carries the credential once — it is never shown again after this page is
 * left.
 */
function InviteCard({
  invites,
  onChanged,
}: {
  invites: PortalInvite[] | null;
  onChanged: () => Promise<void> | void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PortalMemberRole>('client-collaborator');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PortalInviteCreated | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function onInvite() {
    setBusy(true);
    setProblem(null);
    setCreated(null);
    try {
      const result = await createPortalInvite({ email: email.trim(), role });
      setCreated(result);
      setEmail('');
      await onChanged();
    } catch (caught) {
      setProblem(
        clientActionMessage(caught, 'The invitation could not be created. Only an account administrator can invite people.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const pending = (invites ?? []).filter((invite) => invite.status === 'pending');

  return (
    <Card id="collaborators">
      <CardHeader>
        <CardTitle className="text-subsection">People on your account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-table text-muted-foreground">
          Invite the colleagues who should see this project. An invitation is
          single-use and expires; whoever accepts it sets their own password.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="colleague@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Access</Label>
            <Select value={role} onValueChange={(value) => setRole(value as PortalMemberRole)}>
              <SelectTrigger id="invite-role" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PORTAL_MEMBER_ROLE_LABEL) as PortalMemberRole[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {PORTAL_MEMBER_ROLE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={busy || email.trim() === ''} onClick={() => void onInvite()}>
            <Send aria-hidden="true" className="mr-2 h-4 w-4" />
            {busy ? 'Inviting…' : 'Send invitation'}
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">{PORTAL_MEMBER_ROLE_DESCRIPTION[role]}</p>

        {problem ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}

        {created ? (
          <Alert role="status">
            <Mail aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>
              {created.emailSent
                ? 'Invitation created and emailed'
                : 'Invitation created, but the email did not go out'}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {created.emailSent
                  ? 'The invitation exists as well as the email — the link below works either way.'
                  : `The invitation exists and is valid, but email delivery failed${created.emailError ? `: ${created.emailError}` : ''}. Pass them the link below yourself; creating another invitation for the same address will be refused.`}
              </p>
              <p className="font-mono text-meta break-all">{created.acceptUrl}</p>
              <CopyLinkButton value={created.acceptUrl} />
              <p className="text-meta">
                Shown once. This is the only place the invitation link is
                readable, so it is never retrievable from here again — and this
                page deliberately does not navigate to it.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {invites === null ? (
          <p className="text-meta text-muted-foreground">
            Invitations could not be read just now. Reload to see the current list.
          </p>
        ) : pending.length === 0 ? (
          <p className="text-meta text-muted-foreground">No invitation is outstanding.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {pending.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-table">
                  {invite.email}
                  <span className="ml-2 text-meta text-muted-foreground">
                    {PORTAL_MEMBER_ROLE_LABEL[invite.role]}
                  </span>
                </span>
                <span className="text-meta text-muted-foreground">
                  Expires <Timestamp value={invite.expiresAt} dateOnly />
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-meta text-muted-foreground">
          Seat roles, project scope and revocation are on{' '}
          <Link href="/client/account/people" className="text-primary underline underline-offset-4">
            People
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function CopyLinkButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        // Best-effort: a browser without clipboard access still shows the link.
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      <ClipboardCopy aria-hidden="true" className="mr-2 h-4 w-4" />
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

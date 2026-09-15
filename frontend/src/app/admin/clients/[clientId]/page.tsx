'use client';

/**
 * Client detail — onboarding progress, access checklist, findings/fixes
 * (always rendered as two separate blocks, per the onboarding-flow review),
 * reports, messages, and audit scheduling for one client's project(s).
 *
 * @module app/admin/clients/[clientId]/page
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { API_URL, getToken } from '@/lib/api';
import {
  authorizeGoogle,
  confirmCompetitorCandidate,
  generateFindings,
  getClient,
  getGoogleConnections,
  getMonitoringSchedule,
  getSeoAuditSchedule,
  getTechnicalAuditSchedule,
  listCompetitorCandidates,
  listFindings,
  listMessages,
  listReports,
  postMessage,
  rejectCompetitorCandidate,
  setMonitoringSchedule,
  setSeoAuditSchedule,
  setTechnicalAuditSchedule,
} from '@/lib/admin-api';
import type {
  AuditCadence,
  ClientDetail,
  ClientMessage,
  ClientProject,
  CompetitorCandidate,
  Finding,
  GoogleConnection,
  MonitoringCadence,
  ReportSummary,
} from '@/types/admin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const ONBOARDING_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'secondary',
  completed: 'default',
  failed: 'destructive',
};

export default function ClientDetailPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    getClient(clientId)
      .then(setClient)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load client'));
  }, [clientId]);

  useEffect(load, [load]);

  // Poll while any project is still onboarding.
  useEffect(() => {
    const running = client?.projects.some((p) => p.onboardingStatus === 'running');
    if (running && !pollRef.current) {
      pollRef.current = setInterval(load, 4000);
    }
    if (!running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [client, load]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!client) return <DetailSkeleton />;

  const primaryProject = client.projects[0] as ClientProject | undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
            <Badge variant={client.status === 'active' ? 'default' : 'secondary'} className="capitalize">
              {client.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {client.contactName ?? '—'}
            {client.contactEmail ? ` · ${client.contactEmail}` : ''}
          </p>
        </div>
        {primaryProject && (
          <Button
            variant="outline"
            onClick={() => {
              try {
                window.localStorage.setItem('cailyx.lastProject', primaryProject.id);
              } catch {
                /* ignore */
              }
              window.open('/', '_blank');
            }}
          >
            Open in workspace ↗
          </Button>
        )}
      </div>

      {primaryProject?.onboardingStatus === 'running' && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center gap-3 py-4">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <div>
              <p className="text-sm font-medium">Day-1 pipeline running</p>
              <p className="text-xs text-muted-foreground">
                {primaryProject.onboardingStep ?? 'Working…'} — this page refreshes automatically.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {primaryProject?.onboardingStatus === 'failed' && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-4">
            <p className="text-sm font-medium text-destructive">Day-1 pipeline failed</p>
            <p className="text-xs text-muted-foreground">{primaryProject.onboardingError ?? 'Unknown error'}</p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="findings">Findings &amp; Fixes</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="competitors">Competitors</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab projects={client.projects} />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AccessTab projectId={primaryProject?.id} />
        </TabsContent>
        <TabsContent value="findings" className="mt-4">
          {primaryProject ? (
            <FindingsTab projectId={primaryProject.id} />
          ) : (
            <EmptyState text="No project yet." />
          )}
        </TabsContent>
        <TabsContent value="competitors" className="mt-4">
          {primaryProject ? (
            <CompetitorsTab projectId={primaryProject.id} />
          ) : (
            <EmptyState text="No project yet." />
          )}
        </TabsContent>
        <TabsContent value="reports" className="mt-4">
          {primaryProject ? (
            <ReportsTab projectId={primaryProject.id} />
          ) : (
            <EmptyState text="No project yet." />
          )}
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <MessagesTab clientId={client.id} />
        </TabsContent>
        <TabsContent value="schedule" className="mt-4">
          {primaryProject ? (
            <ScheduleTab projectId={primaryProject.id} />
          ) : (
            <EmptyState text="No project yet." />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── overview ─────────────────────────────────────────────────── */

function OverviewTab({ projects }: { projects: ClientProject[] }) {
  if (projects.length === 0) return <EmptyState text="No projects yet." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <CardTitle className="text-base">{p.domain}</CardTitle>
            <CardDescription>{p.name}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Status" value={<Badge variant="outline" className="capitalize">{p.status}</Badge>} />
            <Row
              label="Onboarding"
              value={
                <Badge variant={ONBOARDING_VARIANT[p.onboardingStatus]} className="capitalize">
                  {p.onboardingStatus}
                </Badge>
              }
            />
            <Row
              label="Score"
              value={p.latestScore != null ? `${p.latestScore}${p.latestBand ? ` (${p.latestBand})` : ''}` : '—'}
            />
            <Row label="Open gaps" value={String(p.openGapCount)} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/* ── access checklist ────────────────────────────────────────── */

function AccessTab({ projectId }: { projectId?: string }) {
  const [connections, setConnections] = useState<GoogleConnection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    getGoogleConnections()
      .then((c) => setConnections(Array.isArray(c) ? c : []))
      .catch(() => setConnections([]));
  }, []);
  useEffect(load, [load]);

  const connect = async (service: 'search-console' | 'analytics') => {
    setBusy(service);
    try {
      const { url } = await authorizeGoogle(service, projectId);
      window.open(url, '_blank', 'noopener,width=520,height=680');
      toast.info('Complete the consent flow in the popup, then refresh.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the Google OAuth flow');
    } finally {
      setBusy(null);
    }
  };

  const conn = (service: 'search-console' | 'analytics') => connections?.find((c) => c.service === service);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <AccessCard
        title="Google Search Console"
        description="Read-only access to the client's indexing, queries, and clicks data."
        connection={conn('search-console')}
        loading={!connections}
        busy={busy === 'search-console'}
        onConnect={() => connect('search-console')}
        onRefresh={load}
      />
      <AccessCard
        title="Google Analytics (GA4)"
        description="Sessions, engagement, and channel/page breakdown."
        connection={conn('analytics')}
        loading={!connections}
        busy={busy === 'analytics'}
        onConnect={() => connect('analytics')}
        onRefresh={load}
      />
      <Card className="sm:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Other access (tracked manually for now)</CardTitle>
          <CardDescription>No integration built yet — check these off once confirmed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {['Microsoft Clarity access', 'Website / CMS or hosting access', 'Domain / DNS verification'].map(
            (item) => (
              <label key={item} className="flex items-center gap-2 text-sm">
                <Checkbox />
                {item}
              </label>
            ),
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AccessCard({
  title,
  description,
  connection,
  loading,
  busy,
  onConnect,
  onRefresh,
}: {
  title: string;
  description: string;
  connection: GoogleConnection | undefined;
  loading: boolean;
  busy: boolean;
  onConnect: () => void;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {loading ? (
            <Skeleton className="h-5 w-16" />
          ) : connection?.connected ? (
            <Badge>{connection.expired ? 'Expired' : 'Connected'}</Badge>
          ) : (
            <Badge variant="outline">Pending</Badge>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        {connection?.connected && connection.googleEmail && (
          <span className="text-xs text-muted-foreground">{connection.googleEmail}</span>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
          <Button size="sm" onClick={onConnect} disabled={busy}>
            {busy ? 'Opening…' : connection?.connected ? 'Reconnect' : 'Connect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── findings & fixes (always two separate blocks) ──────────── */

function FindingsTab({ projectId }: { projectId: string }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listFindings(projectId)
      .then((f) => setFindings(Array.isArray(f) ? f : []))
      .catch(() => setFindings([]));
  }, [projectId]);
  useEffect(load, [load]);

  const generate = async () => {
    setBusy(true);
    try {
      await generateFindings(projectId, 5);
      toast.success('Generated new findings');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate findings');
    } finally {
      setBusy(false);
    }
  };

  if (!findings) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {findings.length} finding{findings.length === 1 ? '' : 's'}
        </p>
        <Button size="sm" onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate findings'}
        </Button>
      </div>

      {findings.length === 0 && <EmptyState text="No findings generated yet." />}

      <div className="flex flex-col gap-6">
        {findings.map((f) => (
          <div key={f.id} className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">{f.title}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {/* Finding block — what / why. Kept visually separate from the fix. */}
              <Card className="border-l-4 border-l-sky-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-sky-600 dark:text-sky-400">Finding</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p>{f.whatExecutive}</p>
                  <Separator />
                  <p className="text-muted-foreground">{f.whyExecutive}</p>
                </CardContent>
              </Card>
              {/* Fix block — always separate, never merged with the finding above. */}
              <Card className="border-l-4 border-l-emerald-500">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-emerald-600 dark:text-emerald-400">Fix</CardTitle>
                </CardHeader>
                <CardContent className="text-sm">
                  <p>{f.fixExecutive}</p>
                </CardContent>
              </Card>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── competitors ──────────────────────────────────────────────── */

/**
 * Candidates an AI surface mentioned during an AEO audit that weren't
 * already a recorded competitor. Never auto-trusted — an operator confirms
 * (promotes to a tracked competitor, feeds the AEO prompt / gap report / SoV
 * from then on) or rejects (deletes) each one.
 */
function CompetitorsTab({ projectId }: { projectId: string }) {
  const [candidates, setCandidates] = useState<CompetitorCandidate[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    listCompetitorCandidates(projectId)
      .then((c) => setCandidates(Array.isArray(c) ? c : []))
      .catch(() => setCandidates([]));
  }, [projectId]);
  useEffect(load, [load]);

  const confirm = async (c: CompetitorCandidate) => {
    setBusyId(c.id);
    try {
      await confirmCompetitorCandidate(projectId, c.id);
      toast.success(`${c.name} added as a tracked competitor`);
      setCandidates((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not confirm candidate');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (c: CompetitorCandidate) => {
    setBusyId(c.id);
    try {
      await rejectCompetitorCandidate(projectId, c.id);
      setCandidates((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reject candidate');
    } finally {
      setBusyId(null);
    }
  };

  if (!candidates) return <Skeleton className="h-32 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Brand names an AI surface mentioned (ChatGPT, Perplexity, etc.) that aren&apos;t already tracked
        competitors. Confirm to start tracking them everywhere else in the app; reject to discard.
      </p>
      {candidates.length === 0 ? (
        <EmptyState text="No pending candidates — none surfaced yet, or every one has been reviewed. New candidates appear after an AEO audit runs." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Found</TableHead>
                <TableHead className="text-right">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.source}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(c.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => reject(c)} disabled={busyId === c.id}>
                        Reject
                      </Button>
                      <Button size="sm" onClick={() => confirm(c)} disabled={busyId === c.id}>
                        Confirm
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ── reports ──────────────────────────────────────────────────── */

/**
 * The render endpoint requires a bearer token, so a plain `<a target="_blank">`
 * (no auth header) 401s. Fetch it authenticated and open the HTML as a blob
 * URL instead — same effect, works for a private (operator-only) report.
 */
async function openReport(projectId: string, slug: string): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/reports/${slug}/render`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const html = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    if (win) win.location.href = blobUrl;
    else window.open(blobUrl, '_blank');
  } catch (err) {
    win?.close();
    toast.error('Could not open report', { description: err instanceof Error ? err.message : undefined });
  }
}

function ReportsTab({ projectId }: { projectId: string }) {
  const [reports, setReports] = useState<ReportSummary[] | null>(null);

  useEffect(() => {
    listReports(projectId)
      .then((r) => setReports(Array.isArray(r) ? r : []))
      .catch(() => setReports([]));
  }, [projectId]);

  if (!reports) return <Skeleton className="h-32 w-full" />;
  if (reports.length === 0) return <EmptyState text="No reports generated yet — they appear once the Day-1 pipeline completes." />;

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Visibility</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">View</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reports.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell>
                {r.scoreTotal != null ? (
                  <span>
                    {r.scoreTotal}
                    {r.scoreBand && <span className="ml-1 text-xs text-muted-foreground">({r.scoreBand})</span>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={r.visibility === 'public' ? 'default' : 'outline'} className="capitalize">
                  {r.visibility}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <button
                  type="button"
                  onClick={() => openReport(projectId, r.slug)}
                  className="text-sm text-primary underline underline-offset-4"
                >
                  Open ↗
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ── messages ─────────────────────────────────────────────────── */

function MessagesTab({ clientId }: { clientId: string }) {
  const [messages, setMessages] = useState<ClientMessage[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listMessages(clientId)
      .then((m) => setMessages(Array.isArray(m) ? m : []))
      .catch(() => setMessages([]));
  }, [clientId]);
  useEffect(load, [load]);

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await postMessage(clientId, body.trim());
      setBody('');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send message');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border p-4">
        {!messages && <Skeleton className="h-20 w-full" />}
        {messages?.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet — this thread is visible to the client too.</p>
        )}
        {messages?.map((m) => (
          <div key={m.id} className={m.authorType === 'operator' ? 'ml-auto max-w-[75%]' : 'mr-auto max-w-[75%]'}>
            <div
              className={
                m.authorType === 'operator'
                  ? 'rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
                  : 'rounded-lg bg-muted px-3 py-2 text-sm'
              }
            >
              {m.body}
            </div>
            <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
              {new Date(m.createdAt).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Textarea
          placeholder="Message the client — visible in their client portal…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
        />
        <Button onClick={send} disabled={busy || !body.trim()} className="self-end">
          Send
        </Button>
      </div>
    </div>
  );
}

/* ── scheduling ───────────────────────────────────────────────── */

const AUDIT_CADENCES: AuditCadence[] = ['daily', 'weekly', 'monthly', 'manual-only'];
const MONITORING_CADENCES: MonitoringCadence[] = ['weekly', 'monthly', 'manual-only'];

function ScheduleTab({ projectId }: { projectId: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <CadenceCard
        title="Technical audit"
        description="Core Web Vitals, crawlability, JS dependency. Suggested: every 15 days."
        options={AUDIT_CADENCES}
        get={() => getTechnicalAuditSchedule(projectId)}
        set={(c) => setTechnicalAuditSchedule(projectId, c as AuditCadence)}
      />
      <CadenceCard
        title="SEO audit"
        description="Search Console-driven audit. Suggested: monthly."
        options={AUDIT_CADENCES}
        get={() => getSeoAuditSchedule(projectId)}
        set={(c) => setSeoAuditSchedule(projectId, c as AuditCadence)}
      />
      <CadenceCard
        title="Monitoring / alerts"
        description="Score-delta alert checks."
        options={MONITORING_CADENCES}
        get={() => getMonitoringSchedule(projectId)}
        set={(c) => setMonitoringSchedule(projectId, c as MonitoringCadence)}
      />
    </div>
  );
}

function CadenceCard({
  title,
  description,
  options,
  get,
  set,
}: {
  title: string;
  description: string;
  options: string[];
  get: () => Promise<{ cadence: string }>;
  set: (cadence: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get()
      .then((s) => setValue(s.cadence))
      .catch(() => setValue(options[options.length - 1]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!value) return;
    setBusy(true);
    try {
      await set(value);
      toast.success(`${title} cadence set to ${value}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save schedule');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        {value === null ? (
          <Skeleton className="h-9 w-32" />
        ) : (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o} value={o} className="capitalize">
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" variant="outline" onClick={save} disabled={busy || value === null}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

/* ── shared ───────────────────────────────────────────────────── */

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</p>;
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

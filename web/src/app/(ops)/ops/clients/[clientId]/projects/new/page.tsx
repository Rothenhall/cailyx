'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import {
  RunConfigurator,
  type ConfiguratorPrerequisite,
  type ObservedConfiguration,
} from '@/components/patterns/RunConfigurator';
import { listGoogleConnectionViews } from '@/services/integrations';
import { createClientProject, getClient } from '@/services/clients';
import type { ClientDetail } from '@/services/types';
import type { RunParameter } from '@/types';

/**
 * OP06 — Add project.
 *
 * design_plan.md §4.2: *"Name/domain, duplicate check via submit, optional
 * research toggles, prerequisites and run summary"*, support "E source flags;
 * durable preflight/setup G04/G07".
 *
 * Four rules decide the shape of this page:
 *
 * 1. **Nothing is created on load.** No preflight POST, no "reserve a domain"
 *    call. The only mutation this screen can issue is the one behind the
 *    explicit start button, and §10.4 requires exactly that for a paid action.
 *
 * 2. **The duplicate check is the submit.** §4.2 says "duplicate check via
 *    submit" and the backend enforces one project per domain with a unique
 *    constraint returning **409**. A client-side pre-check would be a second,
 *    weaker opinion: it races with another operator, and when it disagrees
 *    with the database the disagreement surfaces as a confusing error after
 *    the fact. So the domain is *not* probed as it is typed — the 409 is read
 *    and rendered as what it is.
 *
 * 3. **The expensive stages are opt-in and off.** Each of the four research
 *    stages spends real provider credits on its own, so each is an explicit
 *    switch with its own cost sentence, and the default is none of them.
 *
 * 4. **A lost response never re-creates.** §10.3 is explicit that project
 *    creation is never blindly retried. `RunConfigurator` handles that: a lost
 *    response says the outcome is unknown and offers to check rather than
 *    submitting again — which here points at the client's project list, the
 *    only place that can say whether a project now exists.
 */
export default function AddClientProjectPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;
  const router = useRouter();

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [runAeoAudit, setRunAeoAudit] = useState(false);
  const [runKeywordResearch, setRunKeywordResearch] = useState(false);
  const [runGrowthExecution, setRunGrowthExecution] = useState(false);
  const [runBacklinksRefresh, setRunBacklinksRefresh] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  /** The domain the server rejected as taken. Null when there is no conflict. */
  const [duplicate, setDuplicate] = useState<string | null>(null);

  /** Set the instant the server returns a project id — the create cannot run twice. */
  const createdIdRef = useRef<string | null>(null);

  /** Advisory: the operator's own Google grant, read once, never blocking. */
  const [googleState, setGoogleState] = useState<ObservedConfiguration | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        setLoading(true);
        setClient(await getClient(clientId, { signal }));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listGoogleConnectionViews({ signal: controller.signal });
        const gsc = rows.find((row) => row.service === 'search-console');
        if (!gsc) return;
        // Three genuinely different states, per §3.5: not configured,
        // configured-but-expired (unverified), and a live grant.
        if (!gsc.connected) {
          setGoogleState({
            label: 'Google Search Console (this operator)',
            availability: 'unavailable',
            detail:
              'Search-performance data will not be collected in this run. The technical audit still runs against the live site.',
            actionLabel: 'Connect Google',
            actionHref: '/ops/admin/connections',
          });
          return;
        }
        if (gsc.expired || gsc.lastError) {
          setGoogleState({
            label: 'Google Search Console (this operator)',
            availability: 'unverified',
            detail: gsc.lastError
              ? `The stored grant reported an error: ${gsc.lastError}`
              : 'The stored grant has expired; search-performance data may not be readable until it is renewed.',
            actionLabel: 'Review connection',
            actionHref: '/ops/admin/connections',
          });
          return;
        }
        setGoogleState({
          label: 'Google Search Console (this operator)',
          availability: 'available',
          detail: gsc.googleEmail
            ? `Connected as ${gsc.googleEmail}. A specific site still has to be mapped to the project after it exists.`
            : 'Connected. A specific site still has to be mapped to the project after it exists.',
        });
      } catch {
        // Advisory only — the run does not depend on this read.
      }
    })();
    return () => controller.abort();
  }, []);

  const trimmedName = name.trim();
  const trimmedDomain = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

  const prerequisites: ConfiguratorPrerequisite[] = [
    {
      label: 'Client record exists',
      met: Boolean(client),
      detail: client ? client.name : 'The client could not be loaded.',
    },
    {
      label: 'Project name entered',
      met: trimmedName.length > 0,
      detail: trimmedName.length ? undefined : 'Give the project a name.',
    },
    {
      label: 'Domain entered',
      met: trimmedDomain.length >= 3,
      detail: trimmedDomain.length
        ? undefined
        : 'Enter the bare domain, e.g. "example.com".',
    },
    {
      label: 'Domain not already attached to a project',
      // Uniqueness is the server's answer, and the server answers on submit.
      // Stating it as "verified" here would be inventing a pre-check.
      met: true,
      blocking: false,
      detail:
        'Checked by the server when you start. A domain that already has a project comes back as a conflict, and nothing is created.',
    },
  ];

  const parameters: RunParameter[] = [
    { key: 'name', label: 'Project name', value: trimmedName || '—' },
    { key: 'domain', label: 'Domain', value: trimmedDomain || '—' },
    { key: 'client', label: 'Client', value: client?.name ?? '—' },
  ];

  async function onStart() {
    if (createdIdRef.current) return;
    setDuplicate(null);
    setFieldErrors(null);

    try {
      const project = await createClientProject(clientId, {
        name: trimmedName,
        domain: trimmedDomain,
        runAeoAudit,
        runKeywordResearch,
        runGrowthExecution,
        runBacklinksRefresh,
      });

      // §10.3 — persist the identifier before navigating. The pipeline is
      // already running server-side and does not depend on this page.
      createdIdRef.current = project.id;
      router.push(`/ops/clients/${clientId}/onboarding/${project.id}`);
    } catch (caught) {
      const error = toApiError(caught);
      setFieldErrors(error.fieldErrors ?? null);
      if (error.kind === 'conflict') {
        // The one case the plan names explicitly. Not a retryable failure and
        // not a validation error: the domain is taken. The rejected request
        // itself is rendered in place by `RunConfigurator`.
        setDuplicate(trimmedDomain);
      }
      throw caught;
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader breadcrumbs={[{ label: 'Clients', href: '/ops/clients' }]} title="Add project" />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!client) return null;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Clients', href: '/ops/clients' },
          { label: client.name, href: `/ops/clients/${client.id}` },
          { label: 'Add project' },
        ]}
        title="Add project"
        context={`Adds a project to ${client.name} and starts the day-1 setup pipeline.`}
      />

      {duplicate ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>A project for this domain already exists</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              The server rejected <strong className="font-medium">{duplicate}</strong> because a
              project is already registered for it. Nothing was created, and the setup pipeline was
              not started.
            </p>
            <p className="text-meta">
              Domain is unique across all projects — one project per domain — so this is a
              conflict rather than a validation error to correct and resubmit.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/ops/projects">Find the existing project</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">
              Project name
              <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
              aria-invalid={fieldErrors?.name ? true : undefined}
              aria-describedby={fieldErrors?.name ? 'name-error' : undefined}
            />
            {fieldErrors?.name ? (
              <p id="name-error" className="text-meta text-danger-foreground">
                {fieldErrors.name.join(' ')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="domain">
              Domain
              <span className="ml-1 text-meta font-normal text-muted-foreground">(required)</span>
            </Label>
            <Input
              id="domain"
              name="domain"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              required
              inputMode="url"
              placeholder="example.com"
              aria-invalid={fieldErrors?.domain || duplicate ? true : undefined}
              aria-describedby={fieldErrors?.domain ? 'domain-error' : 'domain-help'}
            />
            {fieldErrors?.domain ? (
              <p id="domain-error" className="text-meta text-danger-foreground">
                {fieldErrors.domain.join(' ')}
              </p>
            ) : (
              <p id="domain-help" className="text-meta text-muted-foreground">
                The bare domain, without <code className="text-meta">https://</code> and without a
                path. Uniqueness is decided by the server when you start — the form does not
                pre-check it, because the database is the only authority on it.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Optional research stages</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-table text-muted-foreground">
            The core pipeline — enrichment, entity audit, technical audit, presence, tech stack,
            competitors, gap analysis, strategy and the first report — always runs. The four below
            are additional, and <strong className="font-medium text-foreground">each spends real
            provider credits</strong>. All four are off unless you turn them on.
          </p>

          <Toggle
            id="runAeoAudit"
            label="AI visibility baseline (AEO audit)"
            cost="Costs Cloro/LLM credits per run."
            checked={runAeoAudit}
            onChange={setRunAeoAudit}
          />
          <Toggle
            id="runKeywordResearch"
            label="Keyword research"
            cost="Costs DataForSEO credits."
            checked={runKeywordResearch}
            onChange={setRunKeywordResearch}
          />
          <Toggle
            id="runGrowthExecution"
            label="Growth execution plan"
            cost="No additional provider spend; needs the strategy stage's output."
            checked={runGrowthExecution}
            onChange={setRunGrowthExecution}
          />
          <Toggle
            id="runBacklinksRefresh"
            label="Backlinks refresh"
            cost="Costs DataForSEO credits."
            checked={runBacklinksRefresh}
            onChange={setRunBacklinksRefresh}
          />
        </CardContent>
      </Card>

      <RunConfigurator
        startLabel="Create project and start setup"
        prerequisites={prerequisites}
        parameters={parameters}
        scope={
          <div className="space-y-2 text-table">
            <p>
              Creates the project under <strong className="font-medium">{client.name}</strong>, then
              runs the day-1 pipeline in the background and returns immediately. Onboarding progress
              is per-stage, and a stage that fails is reported as failed rather than rounding the
              run up to complete.
            </p>
            <p className="text-muted-foreground">
              The pipeline takes roughly one to three minutes. It does not need this page to stay
              open, and the project id is saved before the page navigates.
            </p>
          </div>
        }
        configuration={googleState ? [googleState] : undefined}
        onStart={onStart}
        // A lost response means the project may or may not exist. The only
        // honest reconciliation is to look, which is what this offers — never
        // a second create.
        reconcileHref={`/ops/clients/${clientId}`}
      />

      <p className="text-meta text-muted-foreground">
        Start is a single explicit action. Submitting it twice cannot create two projects: the
        button disables on the first press and the server&apos;s domain uniqueness rejects a
        duplicate even if two people submit at the same moment.
      </p>
    </div>
  );
}

function Toggle({
  id,
  label,
  cost,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  cost: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-table">
          {label}
        </Label>
        <p className="text-meta text-muted-foreground">{cost}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={`${id}-cost`}
        className="mt-0.5 shrink-0"
      />
      {/* The cost sentence is also the description, so the switch announces it. */}
      <span id={`${id}-cost`} className="sr-only">
        {cost}
      </span>
    </div>
  );
}

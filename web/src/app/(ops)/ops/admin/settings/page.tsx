'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Save, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Switch } from '@/components/ui/switch';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  getBranding,
  getOrganizationSettings,
  listSettingsVersions,
  writeOrganizationSettings,
  type BrandingSnapshot,
  type OrganizationSettings,
} from '@/services/admin';

/**
 * OP21 — Organization settings.
 *
 * design_plan.md §4.2: *"Brand/logo, support contact, timezone, defaults,
 * allowed public sharing, retention."* The administration family adds
 * *"explanation above high-impact actions, explicit save/test; no client-facing
 * secrets/config hints"*.
 *
 * ## Append-only, and why that is not pedantry
 *
 * `OrganizationSettings` rows are never updated — every save **inserts a new
 * version**. That is what lets a released report keep reading the branding and
 * policy it was published under, so this screen shows the version in force and
 * the full version list, and says plainly that saving does not edit the current
 * row.
 *
 * The same shape carries a state worth naming: `version: null` with
 * `persisted: false` means **no row has ever been written** and the values on
 * screen are the schema's own defaults. A report released under that state
 * pinned `null`, which is a different fact from "published under version 1",
 * and a bare "version 1" heading would erase the difference.
 *
 * ## What is not here
 *
 * *Retention* is named in §4.2 and has no column on this model and no route in
 * this build, so it is reported as unavailable rather than rendered as an empty
 * field. Brand *tagline* is likewise absent by design — the reporting module
 * sources it from its own environment variable.
 */

const SERVICE_TIERS = ['scorecard', 'diagnostic', 'sprint', 'retainer'] as const;

const TIER_DESCRIPTIONS: Record<string, string> = {
  scorecard: 'A free Rung-0 scorecard only. No delivery commitment.',
  diagnostic: 'A one-off baseline diagnostic engagement.',
  sprint: 'A fixed-length delivery sprint.',
  retainer: 'An ongoing retainer with a repeating cycle.',
};

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

interface Draft {
  displayName: string;
  logoUrl: string;
  primaryColor: string;
  supportName: string;
  supportEmail: string;
  timezone: string;
  defaultTier: string;
  reviewSlaHours: string;
  allowPublicShare: boolean;
}

function draftFrom(settings: OrganizationSettings): Draft {
  return {
    displayName: settings.displayName,
    logoUrl: settings.logoUrl ?? '',
    primaryColor: settings.primaryColor ?? '',
    supportName: settings.supportName ?? '',
    supportEmail: settings.supportEmail ?? '',
    timezone: settings.timezone,
    defaultTier: settings.defaultTier,
    reviewSlaHours: String(settings.reviewSlaHours),
    allowPublicShare: settings.allowPublicShare,
  };
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [versions, setVersions] = useState<OrganizationSettings[] | null>(null);
  const [branding, setBranding] = useState<BrandingSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [saveError, setSaveError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const [current, history, brand] = await Promise.all([
        getOrganizationSettings(undefined, { signal }),
        listSettingsVersions({ signal }),
        getBranding({ signal }),
      ]);
      setSettings(current);
      setDraft(draftFrom(current));
      setVersions(history.versions);
      setBranding(brand);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(toApiError(caught));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    return JSON.stringify(draftFrom(settings)) !== JSON.stringify(draft);
  }, [settings, draft]);

  const slaHoursNumber = draft ? Number(draft.reviewSlaHours) : NaN;
  const slaValid =
    Number.isInteger(slaHoursNumber) && slaHoursNumber >= 1 && slaHoursNumber <= 720;

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setIsSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const written = await writeOrganizationSettings({
        displayName: draft.displayName,
        logoUrl: draft.logoUrl === '' ? null : draft.logoUrl,
        primaryColor: draft.primaryColor === '' ? null : draft.primaryColor,
        supportName: draft.supportName === '' ? null : draft.supportName,
        supportEmail: draft.supportEmail === '' ? null : draft.supportEmail,
        timezone: draft.timezone,
        defaultTier: draft.defaultTier,
        reviewSlaHours: slaValid ? slaHoursNumber : undefined,
        allowPublicShare: draft.allowPublicShare,
      });
      setSettings(written);
      setDraft(draftFrom(written));
      setSavedAt(written.updatedAt);
      // Re-read the history and the release projection: the write inserted a
      // new version, so both have changed.
      const [history, brand] = await Promise.all([
        listSettingsVersions(),
        getBranding(),
      ]);
      setVersions(history.versions);
      setBranding(brand);
    } catch (caught) {
      setSaveError(toApiError(caught));
    } finally {
      setIsSaving(false);
    }
  }

  if (error?.kind === 'forbidden') {
    return (
      <div className="space-y-6">
        <PageHeader title="Organization settings" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="change the organization's branding and policy"
          permittedPath="Ask an administrator. An operator can still read the project-level settings they are assigned to."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Organization settings" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!settings || !draft || !versions) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const historyColumns: ReadonlyArray<ColumnDef<OrganizationSettings>> = [
    {
      key: 'version',
      header: 'Version',
      accessor: (row) => row.version,
      sortable: true,
      width: 110,
      render: (row) =>
        row.version === null ? (
          <span className="text-muted-foreground">Schema defaults</span>
        ) : (
          <span className="font-semibold tabular-nums">v{row.version}</span>
        ),
    },
    {
      key: 'inForce',
      header: 'In force',
      accessor: (row) => (row.version === settings.version ? 'yes' : 'no'),
      width: 110,
      render: (row) =>
        row.version === settings.version ? (
          <StatusPill label="In force" tone="info" />
        ) : (
          <span className="text-muted-foreground">Superseded</span>
        ),
    },
    {
      key: 'displayName',
      header: 'Display name',
      accessor: (row) => row.displayName,
      sortable: true,
    },
    {
      key: 'support',
      header: 'Support contact',
      accessor: (row) => row.supportEmail ?? '',
      render: (row) =>
        row.supportEmail ? (
          <div className="min-w-0">
            <div className="truncate">{row.supportEmail}</div>
            <div className="truncate text-meta text-muted-foreground">
              {row.supportName ?? 'No name set'}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">Not set</span>
        ),
    },
    {
      key: 'timezone',
      header: 'Timezone',
      accessor: (row) => row.timezone,
      sortable: true,
      width: 180,
    },
    {
      key: 'defaultTier',
      header: 'Default tier',
      accessor: (row) => row.defaultTier,
      sortable: true,
      width: 140,
    },
    {
      key: 'reviewSlaHours',
      header: 'Review SLA',
      accessor: (row) => row.reviewSlaHours,
      sortable: true,
      align: 'right',
      width: 130,
      render: (row) => <span className="tabular-nums">{row.reviewSlaHours} h</span>,
    },
    {
      key: 'allowPublicShare',
      header: 'Public sharing',
      accessor: (row) => (row.allowPublicShare ? 'allowed' : 'blocked'),
      width: 140,
      render: (row) => (
        <StatusPill
          label={row.allowPublicShare ? 'Allowed' : 'Blocked'}
          tone={row.allowPublicShare ? 'warning' : 'neutral'}
        />
      ),
    },
    {
      key: 'updatedAt',
      header: 'Written',
      accessor: (row) => row.updatedAt,
      sortable: true,
      width: 200,
      render: (row) =>
        row.updatedAt ? (
          <Timestamp value={row.updatedAt} />
        ) : (
          <span className="text-muted-foreground">Never persisted</span>
        ),
    },
    {
      key: 'updatedBy',
      header: 'Written by',
      accessor: (row) => row.updatedBy ?? '',
      defaultHidden: true,
      render: (row) => (
        <span className="text-muted-foreground">{row.updatedBy ?? 'Not recorded'}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization settings"
        context={
          <>
            Version in force:{' '}
            {settings.version === null ? 'schema defaults (nothing saved yet)' : `v${settings.version}`}
            {settings.updatedAt ? (
              <>
                {' · written '}
                <Timestamp value={settings.updatedAt} />
              </>
            ) : null}
          </>
        }
        status={
          dirty ? <StatusPill label="Unsaved changes" tone="warning" /> : undefined
        }
        secondaryActions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(draftFrom(settings))}
            disabled={!dirty || isSaving}
          >
            Discard changes
          </Button>
        }
      />

      {!settings.persisted ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Nothing has been saved yet</AlertTitle>
          <AlertDescription>
            These are the application&rsquo;s declared defaults, not a stored
            version. Any document released now records{' '}
            <strong>&ldquo;published under the application defaults&rdquo;</strong>,
            which is a different fact from publishing under v1.
          </AlertDescription>
        </Alert>
      ) : null}

      {savedAt ? (
        <Alert>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Saved as a new version</AlertTitle>
          <AlertDescription>
            The previous version was not modified. Documents already released
            keep reading the branding and policy they were published under.
          </AlertDescription>
        </Alert>
      ) : null}

      {saveError ? (
        <ErrorState
          error={saveError}
          layout="inline"
          fieldIdPrefix="org-settings-"
          preserveNotice="Your edits are still on this page."
        />
      ) : null}

      <form onSubmit={onSave} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Identity and brand</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org-settings-displayName">
                Display name <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="org-settings-displayName"
                required
                value={draft.displayName}
                onChange={(event) =>
                  setDraft({ ...draft, displayName: event.target.value })
                }
              />
              <p className="text-meta text-muted-foreground">
                Appears as <code className="font-mono">orgName</code> on every
                released document.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="org-settings-primaryColor">Primary colour</Label>
              <Input
                id="org-settings-primaryColor"
                placeholder="#2449C7"
                value={draft.primaryColor}
                onChange={(event) =>
                  setDraft({ ...draft, primaryColor: event.target.value })
                }
              />
              <p className="text-meta text-muted-foreground">
                A hex colour. An invalid value is refused by the server rather
                than quietly ignored. Leave blank to use the product default.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="org-settings-logoUrl">Logo URL</Label>
              <Input
                id="org-settings-logoUrl"
                type="url"
                placeholder="https://…"
                value={draft.logoUrl}
                onChange={(event) => setDraft({ ...draft, logoUrl: event.target.value })}
              />
              <p className="text-meta text-muted-foreground">
                Must include a protocol. Leave blank to render the display name
                without a logo.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Support contact</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org-settings-supportName">Support name</Label>
              <Input
                id="org-settings-supportName"
                value={draft.supportName}
                onChange={(event) =>
                  setDraft({ ...draft, supportName: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-settings-supportEmail">Support email</Label>
              <Input
                id="org-settings-supportEmail"
                type="email"
                value={draft.supportEmail}
                onChange={(event) =>
                  setDraft({ ...draft, supportEmail: event.target.value })
                }
              />
              <p className="text-meta text-muted-foreground">
                This is where clients are told to write. It is published on
                client-facing surfaces, so it must not be an internal alias.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Defaults</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org-settings-timezone">Timezone</Label>
              <Input
                id="org-settings-timezone"
                list="org-settings-timezone-list"
                value={draft.timezone}
                onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
              />
              <datalist id="org-settings-timezone-list">
                {COMMON_TIMEZONES.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <p className="text-meta text-muted-foreground">
                An IANA zone name, e.g. <code className="font-mono">Europe/London</code>.
                An unrecognised zone is refused by the server.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="org-settings-defaultTier">Default service tier</Label>
              <Select
                value={draft.defaultTier}
                onValueChange={(value) => setDraft({ ...draft, defaultTier: value })}
              >
                <SelectTrigger id="org-settings-defaultTier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_TIERS.map((tier) => (
                    <SelectItem key={tier} value={tier}>
                      {tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-meta text-muted-foreground">
                {TIER_DESCRIPTIONS[draft.defaultTier] ?? ''} This is the tier new
                engagements start at; it does not change an existing
                engagement&rsquo;s tier.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="org-settings-reviewSlaHours">
                Review SLA (hours) <span className="text-muted-foreground">(required)</span>
              </Label>
              <Input
                id="org-settings-reviewSlaHours"
                type="number"
                min={1}
                max={720}
                required
                value={draft.reviewSlaHours}
                onChange={(event) =>
                  setDraft({ ...draft, reviewSlaHours: event.target.value })
                }
                aria-invalid={!slaValid}
                aria-describedby="org-settings-reviewSlaHours-help"
              />
              {/* Stated in text, not by colour alone (§3.4). */}
              <p id="org-settings-reviewSlaHours-help" className="text-meta text-muted-foreground">
                {slaValid
                  ? 'How long an internal review may take before it counts as overdue. Whole hours, 1–720.'
                  : 'Enter a whole number of hours between 1 and 720. Until this is valid it is left unchanged on the server rather than defaulted.'}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Public sharing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="org-settings-allowPublicShare" className="text-table">
                  Allow anyone-with-the-link report shares
                </Label>
                <p className="text-meta text-muted-foreground">
                  When on, an operator may mint a public link that renders a
                  report to an unauthenticated visitor. When off, modules that
                  mint such a link are refused in-process, so the setting is a
                  gate rather than a warning.
                </p>
              </div>
              <Switch
                id="org-settings-allowPublicShare"
                checked={draft.allowPublicShare}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, allowPublicShare: checked })
                }
              />
            </div>
            <Alert variant={draft.allowPublicShare ? 'destructive' : 'default'}>
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>
                {draft.allowPublicShare
                  ? 'Public sharing is currently ON'
                  : 'Public sharing is currently OFF'}
              </AlertTitle>
              <AlertDescription>
                Turning this on is a change to what every operator may publish
                from this deployment. A public link is not access control:
                anyone who has the URL can read it, and search engines may
                index it unless the page is excluded. Client-portal delivery
                does not depend on this setting.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">
              What a released document will read
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {branding ? (
              <>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-meta text-muted-foreground">Organization name</dt>
                    <dd className="mt-0.5 text-table">{branding.branding.orgName}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Logo</dt>
                    <dd className="mt-0.5 text-table break-words">
                      {branding.branding.logoUrl ?? 'None set'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Primary colour</dt>
                    <dd className="mt-0.5 text-table">
                      {branding.branding.palette?.primary ?? 'Product default'}
                    </dd>
                  </div>
                </dl>
                <Separator />
                <p className="text-meta text-muted-foreground">
                  Read from settings version{' '}
                  {branding.settingsVersion === null ? (
                    <strong>schema defaults</strong>
                  ) : (
                    <strong>v{branding.settingsVersion}</strong>
                  )}
                  . A document released now pins this version, so a later edit
                  here cannot change it. No tagline is returned — the reporting
                  module sources that from its own server configuration.
                </p>
                {Object.keys(branding.cssVariables).length > 0 ? (
                  <p className="font-mono text-meta break-words text-muted-foreground">
                    {Object.entries(branding.cssVariables)
                      .map(([property, value]) => `${property}: ${value};`)
                      .join(' ')}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-table text-muted-foreground">
                The branding projection could not be read. The settings shown
                above are unaffected; this panel reports what a released
                document would resolve to and is unavailable right now.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-table font-medium">Retention</CardTitle>
          </CardHeader>
          <CardContent>
            {/*
              §4.2 names retention on this screen. It has no column on
              OrganizationSettings and no route in this build, so it is
              reported as unavailable rather than drawn as an empty control
              that would save nothing.
            */}
            <EmptyState
              variant="not-measured"
              subject="data retention policy"
              prerequisite="A retention field on the settings model and an offboarding flow that honours it. design_plan G17/G20 track this."
              layout="inline"
            >
              No retention setting exists in this deployment, so there is
              nothing here to configure. Deleting a client or an operator
              removes that record; it does not currently sweep the runs,
              reports or activity entries attached to it.
            </EmptyState>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-meta text-muted-foreground">
            Saving inserts a new version. Nothing already released changes.
          </p>
          <Button type="submit" disabled={isSaving || !dirty || !slaValid}>
            <Save aria-hidden="true" className="mr-2 h-4 w-4" />
            {isSaving ? 'Saving…' : 'Save as a new version'}
          </Button>
        </div>
      </form>

      <section className="space-y-3" aria-labelledby="settings-history">
        <div className="flex items-center gap-2">
          <h2 id="settings-history" className="text-subsection font-semibold">
            Version history
          </h2>
          <Badge variant="outline">{versions.length}</Badge>
        </div>
        <p className="text-table text-muted-foreground">
          Every version ever written, newest first. Because writes only ever
          insert, this list is the complete history of what the branding and
          policy have been.
        </p>
        <DataTable
          caption="Organization settings versions"
          columns={historyColumns}
          rows={versions}
          getRowId={(row) => (row.version === null ? 'defaults' : String(row.version))}
          defaultSort={{ key: 'version', direction: 'desc' }}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="saved settings versions"
              prerequisite="Saving the form above writes version 1."
            />
          }
        />
      </section>
    </div>
  );
}

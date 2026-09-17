'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, clientActionMessage, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { listPortalProjectSummaries, type PortalProjectSummary } from '@/services/portal';
import {
  confirmPortalBusinessProfile,
  getBusinessInfoOverview,
  rejectBusinessInfoSuggestion,
  savePortalBusinessProfileDraft,
  type BusinessInfoField,
  type BusinessInfoOverview,
  type BusinessInfoSection,
  type PortalProfilePatch,
} from '@/services/portal-profile';

/**
 * Business information (P02) — "What you do, who you help, and where your
 * customers are" (plan §4.3's client-facing rewording of Site context).
 *
 * design_plan.md §9.1 puts this outside Performance, as its own top-level
 * area, because business information is the shared foundation every other
 * screen reads from. §9.2's grouping — Confirmed by you / Suggested from your
 * website / Needs information — comes straight from
 * `GET .../business-profile/overview`, which also withholds any suggestion
 * that exactly repeats one this account already declined.
 *
 * Two actions per suggested field:
 *  - **Yes, use this** merges the website's value into the draft
 *    (`PUT .../business-profile`) — it is not a fact until confirmed.
 *  - **Keep what we have** records the decline so an identical recrawl will
 *    not ask again.
 *
 * Confirming is a separate, explicit step (§4.3: draft vs. confirmed matters
 * everywhere in this module) — it writes a new, immutable version, exactly as
 * the CP04 welcome-checklist card already does.
 */
export default function ClientBusinessInfoPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<PortalProjectSummary | null>(null);
  const [overview, setOverview] = useState<BusinessInfoOverview | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projects, overviewResult] = await Promise.all([
          listPortalProjectSummaries({ signal }),
          getBusinessInfoOverview(projectId, { signal }),
        ]);
        setProject(projects.find((entry) => entry.id === projectId) ?? null);
        setOverview(overviewResult);
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

  async function writePatch(patch: PortalProfilePatch, successMessage: string) {
    setActionError(null);
    setMessage(null);
    try {
      await savePortalBusinessProfileDraft(projectId, patch);
      setMessage(successMessage);
      await load();
    } catch (caught) {
      setActionError(clientActionMessage(caught, 'That could not be saved.'));
    }
  }

  async function onAccept(suggestion: BusinessInfoSection['suggestions'][number]) {
    await writePatch(
      buildPatch(suggestion.field, suggestion.suggestedValue),
      `Used your website's "${suggestion.label}". Confirm below to agree it as your final details.`,
    );
  }

  async function onKeepCurrent(field: BusinessInfoField) {
    setActionError(null);
    setMessage(null);
    try {
      await rejectBusinessInfoSuggestion(projectId, field);
      setMessage('Kept what you already told us. We will not ask about this exact suggestion again.');
      await load();
    } catch (caught) {
      setActionError(clientActionMessage(caught, 'That could not be recorded.'));
    }
  }

  async function onEditSave(field: BusinessInfoField, label: string, value: string[] | string) {
    await writePatch(buildPatch(field, value), `Saved "${label}".`);
  }

  async function onConfirm() {
    setConfirmBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      await confirmPortalBusinessProfile(projectId, { version: overview?.confirmedVersion?.version });
      setMessage('Confirmed. These are now your agreed business details.');
      await load();
    } catch (caught) {
      setActionError(clientActionMessage(caught, 'That could not be confirmed. Reload and try again.'));
    } finally {
      setConfirmBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Business information" />
        <ErrorState error={error} onRetry={() => void load()} notFoundReason="missing-or-private" showServerMessage={false} />
      </div>
    );
  }

  if (!project || !overview) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner scope={{ projectName: project.name, domain: project.domain, mode: 'live' }} />

      <PageHeader
        breadcrumbs={[
          { label: 'Your projects', href: '/client/projects' },
          { label: project.name, href: `/client/projects/${projectId}` },
          { label: 'Business information' },
        ]}
        title="Business information"
        context="What you do, who you help, and where your customers are. This is used across your plan, your questions, and your reports."
        status={
          <StatusPill
            label={
              overview.profileState === 'confirmed'
                ? 'Confirmed'
                : overview.profileState === 'draft'
                  ? 'Draft — not yet confirmed'
                  : 'Not started'
            }
            tone={overview.profileState === 'confirmed' ? 'success' : overview.profileState === 'draft' ? 'warning' : 'unmeasured'}
          />
        }
        primaryAction={{
          label: confirmBusy ? 'Confirming…' : 'Confirm these details',
          onClick: () => void onConfirm(),
          disabled: confirmBusy || overview.profileState !== 'draft',
          disabledReason: overview.profileState !== 'draft' ? 'There are no unconfirmed changes to confirm.' : undefined,
        }}
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {overview.sections.every((s) => s.confirmed.every((f) => isEmpty(f.value)) && s.suggestions.length === 0) &&
      !overview.hasSiteContext ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="your business information"
              prerequisite="Nothing has been filled in yet, and we haven't read your website yet either."
            />
          </CardContent>
        </Card>
      ) : (
        overview.sections.map((section) => (
          <SectionCard
            key={section.key}
            section={section}
            onAccept={onAccept}
            onKeepCurrent={onKeepCurrent}
            onEditSave={onEditSave}
          />
        ))
      )}

      <p className="text-meta text-muted-foreground">
        Writing style is managed on{' '}
        <Link href={`/client/projects/${projectId}/content`} className="text-primary underline underline-offset-4">
          Content
        </Link>
        . Where your business appears online is managed on{' '}
        <Link href={`/client/projects/${projectId}/connections`} className="text-primary underline underline-offset-4">
          Connections
        </Link>
        .
      </p>
    </div>
  );
}

function SectionCard({
  section,
  onAccept,
  onKeepCurrent,
  onEditSave,
}: {
  section: BusinessInfoSection;
  onAccept: (s: BusinessInfoSection['suggestions'][number]) => Promise<void>;
  onKeepCurrent: (field: BusinessInfoField) => Promise<void>;
  onEditSave: (field: BusinessInfoField, label: string, value: string[] | string) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-subsection">{section.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-2">
        <div>
          <h3 className="mb-2 text-meta font-semibold text-foreground">Confirmed by you</h3>
          <ul className="divide-y divide-border">
            {section.confirmed.map((entry) => (
              <ConfirmedRow key={entry.field} entry={entry} onSave={onEditSave} />
            ))}
          </ul>
        </div>

        {section.suggestions.length > 0 ? (
          <div>
            <h3 className="mb-2 text-meta font-semibold text-foreground">Suggested from your website</h3>
            <ul className="space-y-3">
              {section.suggestions.map((suggestion) => (
                <li key={suggestion.field} className="rounded-md border border-border p-3">
                  <p className="text-table font-medium">{suggestion.label}</p>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-meta text-muted-foreground">What you have now</p>
                      <p className="text-table">{formatValue(suggestion.currentValue)}</p>
                    </div>
                    <div>
                      <p className="text-meta text-muted-foreground">What your website says</p>
                      <p className="text-table">{formatValue(suggestion.suggestedValue)}</p>
                    </div>
                  </div>
                  <p className="mt-1 text-meta text-muted-foreground">
                    From {suggestion.sourcePage ?? 'your website'}, checked{' '}
                    <Timestamp value={suggestion.sourceDate} dateOnly />
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => void onAccept(suggestion)}>
                      <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      Yes, use this
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void onKeepCurrent(suggestion.field)}>
                      <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      Keep what we have
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {section.gaps.length > 0 ? (
          <div>
            <h3 className="mb-2 text-meta font-semibold text-foreground">Needs information</h3>
            <ul className="divide-y divide-border">
              {section.gaps.map((gap) => (
                <ConfirmedRow key={gap.field} entry={{ field: gap.field, label: gap.label, value: null }} onSave={onEditSave} />
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ConfirmedRow({
  entry,
  onSave,
}: {
  entry: { field: BusinessInfoField; label: string; value: string[] | string | null };
  onSave: (field: BusinessInfoField, label: string, value: string[] | string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(toInputString(entry.value));
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <li className="py-2">
        <p id={`${entry.field}-edit-label`} className="text-meta text-muted-foreground">
          {entry.label}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* §4.5: the field's visible label is a sibling `<p>`, so it is
              attached with `aria-labelledby` — a placeholder is not a label. */}
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-labelledby={`${entry.field}-edit-label`}
            placeholder={isArrayField(entry.field) ? 'Separate each with a comma' : undefined}
            className="max-w-md"
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(entry.field, entry.label, fromInputString(entry.field, draft));
              setBusy(false);
              setEditing(false);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div>
        <p className="text-meta text-muted-foreground">{entry.label}</p>
        <p className="text-table">{formatValue(entry.value)}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        Edit
      </Button>
    </li>
  );
}

// ── Shared helpers ───────────────────────────────────────────────────────

const ARRAY_FIELDS = new Set<BusinessInfoField>([
  'services',
  'icp.segments',
  'icp.roles',
  'icp.painPoints',
  'markets',
  'languages',
  'competitors',
  'goals',
]);

function isArrayField(field: BusinessInfoField): boolean {
  return ARRAY_FIELDS.has(field);
}

function isEmpty(value: string[] | string | null): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value.trim().length === 0;
}

function formatValue(value: string[] | string | null): string {
  if (value === null) return 'Not set';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Not set';
  return value.trim().length > 0 ? value : 'Not set';
}

function toInputString(value: string[] | string | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function fromInputString(field: BusinessInfoField, input: string): string[] | string {
  if (!isArrayField(field)) return input.trim();
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCompetitorEntry(entry: string): { name: string; domain?: string } {
  const match = entry.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (match) return { name: match[1].trim(), domain: match[2].trim() };
  return { name: entry.trim() };
}

/** Maps one field + its next value onto the merge-patch shape
 *  `PUT .../business-profile` accepts. Nested ICP fields patch through their
 *  parent object; competitors are re-parsed from "Name (domain)" text. */
function buildPatch(field: BusinessInfoField, value: string[] | string | null): PortalProfilePatch {
  const v = value ?? (isArrayField(field) ? [] : '');
  switch (field) {
    case 'icp.segments':
      return { icp: { segments: v as string[] } };
    case 'icp.roles':
      return { icp: { roles: v as string[] } };
    case 'icp.painPoints':
      return { icp: { painPoints: v as string[] } };
    case 'competitors':
      return { competitors: (v as string[]).map(parseCompetitorEntry) };
    case 'services':
    case 'markets':
    case 'languages':
    case 'goals':
      return { [field]: v as string[] };
    case 'brandName':
    case 'legalName':
    case 'description':
      return { [field]: v as string };
  }
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import type { ApiError } from '@/lib/api';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import {
  confirmBusinessProfile,
  getBusinessInfoOverview,
  getTargetLocations,
  rejectBusinessInfoSuggestion,
  saveBusinessProfileDraft,
  saveTargetLocations,
  type BusinessInfoField,
  type BusinessInfoOverview,
  type BusinessInfoSection,
  type BusinessProfilePatch,
  type MarketTarget,
  type TargetLocationsOverview,
} from '@/services/business-profile';

/**
 * Business information (P02) — the replacement for AE05 "Site context".
 *
 * design_plan.md §9.1: *"Move Site Context to Business information outside
 * Research/Performance,"* presenting four sections (About your business, Your
 * customers, Target locations and languages, Brand details). §9.2: *"UI groups
 * fields as Confirmed by you, Suggested from your website, and Needs
 * information... On recrawl, show proposed changes side by side: current
 * confirmed value, new suggestion, source page, and Accept/Keep current."*
 *
 * `GET .../business-profile/overview` already does the grouping and the
 * rejection-memory filtering (declined suggestions do not resurface
 * unchanged); this page is presentation plus two actions:
 *
 *  - **Accept** a suggestion — merges it onto the draft via the existing
 *    `PUT .../business-profile` (never writes a confirmed row directly).
 *  - **Keep current** — calls the new reject endpoint, which records the
 *    exact declined value so an identical recrawl will not show it again.
 *
 * Confirming (a separate, explicit act) is unchanged: it is still
 * `POST .../business-profile/confirm`, writing a NEW immutable version.
 */
export default function BusinessInfoPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [overview, setOverview] = useState<BusinessInfoOverview | null>(null);
  const [targetLocations, setTargetLocations] = useState<TargetLocationsOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projectResult, overviewResult, targetsResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          getBusinessInfoOverview(projectId, { signal }),
          getTargetLocations(projectId, { signal }),
        ]);
        setProject(projectResult);
        setOverview(overviewResult);
        setTargetLocations(targetsResult);
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

  async function writePatch(patch: BusinessProfilePatch, successMessage: string) {
    setActionError(null);
    setMessage(null);
    try {
      await saveBusinessProfileDraft(projectId, patch);
      setMessage(successMessage);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'That could not be saved.');
    }
  }

  async function onAccept(suggestion: BusinessInfoSection['suggestions'][number]) {
    await writePatch(
      buildPatch(suggestion.field, suggestion.suggestedValue),
      `Accepted the suggested "${suggestion.label}" into the draft. Confirm the draft to make it a fact.`,
    );
  }

  async function onKeepCurrent(field: BusinessInfoField) {
    setActionError(null);
    setMessage(null);
    try {
      const result = await rejectBusinessInfoSuggestion(projectId, field);
      setMessage(result.detail);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'That could not be recorded.');
    }
  }

  async function onEditSave(field: BusinessInfoField, label: string, value: string[] | string) {
    await writePatch(buildPatch(field, value), `Saved "${label}" to the draft.`);
  }

  async function writeTargets(next: MarketTarget[], successMessage: string) {
    setActionError(null);
    setMessage(null);
    try {
      await saveTargetLocations(projectId, next);
      setMessage(successMessage);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'That target could not be saved.');
    }
  }

  async function onAddTarget(country: string, city: string, suggested: boolean) {
    const existing = targetLocations?.targets ?? [];
    const next: MarketTarget[] = [
      ...existing,
      {
        country: country.trim().toUpperCase(),
        region: null,
        city: city.trim() ? city.trim() : null,
        language: null,
        priority: existing.length,
        active: true,
        productApplicability: [],
      },
    ];
    await writeTargets(
      next,
      suggested
        ? `Added ${country} as a confirmed target from the suggestion. Confirm the draft to make it a fact.`
        : `Added ${country} as a target. Confirm the draft to make it a fact.`,
    );
  }

  async function onToggleTargetActive(index: number) {
    const existing = targetLocations?.targets ?? [];
    const next = existing.map((t, i) => (i === index ? { ...t, active: !t.active } : t));
    await writeTargets(next, `Updated target ${existing[index]?.country}.`);
  }

  async function onRemoveTarget(index: number) {
    const existing = targetLocations?.targets ?? [];
    const removed = existing[index];
    const next = existing.filter((_, i) => i !== index);
    await writeTargets(next, `Removed target ${removed?.country ?? ''}.`);
  }

  async function onConfirm() {
    setConfirmBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await confirmBusinessProfile(projectId, { version: overview?.confirmedVersion?.version });
      setMessage(`Confirmed as version ${result.profile.version}.`);
      await load();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'That could not be confirmed.');
    } finally {
      setConfirmBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Business information" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project || !overview) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{ projectName: project.name, domain: project.domain, mode: 'live' }}
      />

      <PageHeader
        title="Business information"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>What we know about this business, where it came from, and what is still open.</span>
            {overview.sourceCheckedAt ? (
              <span>
                Site last read <Timestamp value={overview.sourceCheckedAt} />
              </span>
            ) : (
              <span className="text-muted-foreground">No site context has been built yet</span>
            )}
          </span>
        }
        status={
          <StatusPill
            label={
              overview.profileState === 'confirmed'
                ? `Confirmed — version ${overview.confirmedVersion?.version ?? '?'}`
                : overview.profileState === 'draft'
                  ? 'Draft — not confirmed'
                  : 'Nothing on file'
            }
            tone={overview.profileState === 'confirmed' ? 'success' : overview.profileState === 'draft' ? 'warning' : 'unmeasured'}
          />
        }
        primaryAction={{
          label: confirmBusy ? 'Confirming…' : 'Confirm this version',
          onClick: () => void onConfirm(),
          disabled: confirmBusy || overview.profileState !== 'draft',
        }}
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <p role="status" className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-table text-info-foreground">
          {message}
        </p>
      ) : null}

      {overview.suppressedRejectedCount > 0 ? (
        <p className="text-meta text-muted-foreground">
          {overview.suppressedRejectedCount} suggestion{overview.suppressedRejectedCount === 1 ? '' : 's'} previously
          declined ({'"'}Keep current{'"'}) {overview.suppressedRejectedCount === 1 ? 'is' : 'are'} withheld — the site
          still says the same thing, so it is not shown again.
        </p>
      ) : null}

      {overview.sections.every((s) => s.confirmed.every((f) => isEmpty(f.value)) && s.suggestions.length === 0) &&
      !overview.hasSiteContext ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="business information"
              prerequisite="No draft has been saved and no site context has been extracted for this project yet."
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

      {targetLocations ? (
        <TargetLocationsPanel
          overview={targetLocations}
          onAddTarget={onAddTarget}
          onToggleActive={onToggleTargetActive}
          onRemove={onRemoveTarget}
        />
      ) : null}

      <p className="text-meta text-muted-foreground">
        Confirming writes a new, immutable profile version rather than editing this one. Downstream artifacts (competitors,
        gap analysis, strategy, findings, reports) are unaffected until an explicit rebuild is run.
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
          <h3 className="mb-2 flex items-center gap-2 text-meta font-semibold text-foreground">
            Confirmed by you
            <ProvenanceBadge kind="operator-supplied" />
          </h3>
          <ul className="divide-y divide-border">
            {section.confirmed.map((entry) => (
              <ConfirmedRow key={entry.field} entry={entry} onSave={onEditSave} />
            ))}
          </ul>
        </div>

        {section.suggestions.length > 0 ? (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-meta font-semibold text-foreground">
              Suggested from your website
              <ProvenanceBadge kind="discovered-candidate" />
            </h3>
            <ul className="space-y-3">
              {section.suggestions.map((suggestion) => (
                <li key={suggestion.field} className="rounded-md border border-border p-3">
                  <p className="text-table font-medium">{suggestion.label}</p>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-meta text-muted-foreground">Current</p>
                      <p className="text-table">{formatValue(suggestion.currentValue)}</p>
                    </div>
                    <div>
                      <p className="text-meta text-muted-foreground">Suggested</p>
                      <p className="text-table">{formatValue(suggestion.suggestedValue)}</p>
                    </div>
                  </div>
                  <p className="mt-1 text-meta text-muted-foreground">
                    Source: {suggestion.sourcePage ?? 'the project site'} · read{' '}
                    <Timestamp value={suggestion.sourceDate} dateOnly />
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => void onAccept(suggestion)}>
                      <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      Accept into draft
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void onKeepCurrent(suggestion.field)}>
                      <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                      Keep current
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
        <p className="text-meta text-muted-foreground">{entry.label}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={isArrayField(entry.field) ? 'Comma-separated' : undefined}
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

/** Maps one business-information field + its next value onto the merge-patch
 *  shape `PUT .../business-profile` accepts. Nested ICP fields patch through
 *  their parent object; competitors are re-parsed from "Name (domain)" text. */
function buildPatch(field: BusinessInfoField, value: string[] | string | null): BusinessProfilePatch {
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

/**
 * Target locations (P04, plan §10.4: "Editing belongs in Business
 * information -> Target locations"). Structured targets — country required,
 * optional city — each shown with a real per-provider support preview read
 * from `GET .../business-profile/target-locations`, never a fabricated
 * "supported everywhere". Countries `SiteContext.markets` still suggests
 * (and that are not yet an active target) are offered separately, exactly
 * like every other §9.1 suggestion: shown, never auto-applied.
 */
function TargetLocationsPanel({
  overview,
  onAddTarget,
  onToggleActive,
  onRemove,
}: {
  overview: TargetLocationsOverview;
  onAddTarget: (country: string, city: string, suggested: boolean) => Promise<void>;
  onToggleActive: (index: number) => Promise<void>;
  onRemove: (index: number) => Promise<void>;
}) {
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');

  const supportByCountry = new Map<string, typeof overview.providerSupport>();
  for (const s of overview.providerSupport) {
    const list = supportByCountry.get(s.requestedCountry) ?? [];
    list.push(s);
    supportByCountry.set(s.requestedCountry, list);
  }

  return (
    <Card id="target-locations">
      <CardHeader>
        <CardTitle className="text-subsection">Target locations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-2">
        <p className="text-table text-muted-foreground">
          Where you want customers, not where the business is headquartered. A confirmed target here is what
          measurement runs (AEO audits, SERP trackers) target — never the ccTLD or the legal address.
        </p>

        {overview.targets.length === 0 ? (
          <EmptyState variant="not-measured" subject="target locations" prerequisite="No target has been added yet." />
        ) : (
          <ul className="space-y-2">
            {overview.targets.map((t, i) => {
              const support = supportByCountry.get(t.country) ?? [];
              const targeted = support.filter((s) => s.supported && (t.city ? s.effectiveGranularity !== 'none' : true));
              return (
                <li key={`${t.country}-${t.city ?? ''}-${i}`} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {t.country}
                      {t.city ? ` — ${t.city}` : ''}
                    </span>
                    {t.active ? (
                      <StatusPill label="Active" tone="success" />
                    ) : (
                      <StatusPill label="Inactive — kept on file, excluded from measurement" tone="unmeasured" />
                    )}
                    <ProvenanceBadge kind="operator-supplied" />
                    <span className="text-meta text-muted-foreground">
                      {targeted.length} of {support.length} providers can target this
                      {t.city ? ' city' : ' country'}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => void onToggleActive(i)}>
                        {t.active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void onRemove(i)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-2 text-meta text-muted-foreground">
                    {support.map((s) => (
                      <li key={s.provider} title={s.detail}>
                        {s.providerLabel}: {s.supported ? `${s.effectiveGranularity} (${s.mode})` : 'not supported'}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}

        {overview.suggestedCountries.length > 0 ? (
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-meta font-semibold text-foreground">
              Suggested from your website
              <ProvenanceBadge kind="discovered-candidate" />
            </h3>
            <ul className="flex flex-wrap gap-2">
              {overview.suggestedCountries.map((c) => (
                <li key={c}>
                  <Button variant="outline" size="sm" onClick={() => void onAddTarget(c, '', true)}>
                    Add {c}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <div>
            <label className="mb-1 block text-meta text-muted-foreground" htmlFor="target-country">
              Country (ISO-3166 alpha-2)
            </label>
            <Input
              id="target-country"
              value={country}
              maxLength={2}
              placeholder="US"
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              className="w-24"
            />
          </div>
          <div>
            <label className="mb-1 block text-meta text-muted-foreground" htmlFor="target-city">
              City (optional)
            </label>
            <Input
              id="target-city"
              value={city}
              placeholder="New York"
              onChange={(e) => setCity(e.target.value)}
              className="w-48"
            />
          </div>
          <Button
            size="sm"
            disabled={!/^[A-Z]{2}$/.test(country)}
            onClick={() => {
              void onAddTarget(country, city, false);
              setCountry('');
              setCity('');
            }}
          >
            Add target
          </Button>
        </div>

        <p className="text-meta text-muted-foreground">
          A city target not on a provider&rsquo;s validated location list is disclosed as unsupported for that
          provider rather than silently measured at country scope and labelled as the city.
        </p>
      </CardContent>
    </Card>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  GAP_ACTIONS,
  GAP_ACTION_LABEL,
  GAP_CATEGORIES,
  GAP_CATEGORY_LABEL,
  GAP_DIMENSIONS,
  GAP_DIMENSION_LABEL,
  GAP_STATUSES,
  GAP_STATUS_LABEL,
  QUADRANT_LABELS,
  getGap,
  patchGap,
  type Gap,
  type GapAction,
  type GapCategory,
  type GapDimension,
  type GapStatus,
  type ImpactEffortQuadrant,
  type PatchGapInput,
} from '@/services/planning';

/**
 * PJ06 — Gap detail.
 *
 * design_plan.md §4.3: *"Observed issue, evidence, recommendation,
 * priority/impact/effort, status, source links"*, support "Core E;
 * owner/dependency/verification G06".
 *
 * The screen's job is to keep four different kinds of statement apart:
 *
 *  1. **The observation** — what a module recorded, with its source type and
 *     source id, plus its own timestamp. Rendered through `EvidenceDrawer`, so
 *     the raw evidence is escaped text and the *fact* is separated from the
 *     *reading* of it.
 *  2. **The classification** — how that observation was filed (category,
 *     action, dimension) and whether each axis is automatic or has been
 *     overridden by an operator. Overriding an axis is what stops a later
 *     re-classification from reverting it, so the form says that at the point
 *     of the edit rather than in a footnote.
 *  3. **The priority inputs** — the three manual 1–5 PR/outreach bands and the
 *     impact/effort pair. These are *operator* judgements, and the screen says
 *     so; the derived `priorityScore` and `quadrant` are shown as derived, with
 *     their own provenance badge, never as measurements.
 *  4. **The recommendation** — the nine-category bucket the strategy layer
 *     would place this in. It is a pointer into the roadmap, not a plan.
 *
 * Owner, dependency and verification are G06 and live on a work item, not on a
 * finding. That is stated as its own panel with the path to the screen that does
 * hold them, rather than being implied by an empty field.
 */
export default function GapDetailPage() {
  const params = useParams<{ projectId: string; gapId: string }>();
  const projectId = params.projectId;
  const gapId = params.gapId;

  const [gap, setGap] = useState<Gap | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [loading, setLoading] = useState(true);

  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const [demand, setDemand] = useState('');
  const [credibility, setCredibility] = useState('');
  const [citation, setCitation] = useState('');
  const [impact, setImpact] = useState('');
  const [effort, setEffort] = useState('');
  const [status, setStatus] = useState<GapStatus>('open');

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        setLoading(true);
        const result = await getGap(projectId, gapId, { signal });
        setGap(result);
        setDemand(result.demandPotential === null ? '' : String(result.demandPotential));
        setCredibility(result.credibilityImpact === null ? '' : String(result.credibilityImpact));
        setCitation(result.citationLikelihood === null ? '' : String(result.citationLikelihood));
        setImpact(result.impactScore === null ? '' : String(result.impactScore));
        setEffort(result.effortScore === null ? '' : String(result.effortScore));
        setStatus((result.status as GapStatus) ?? 'open');
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(toApiError(caught));
      } finally {
        setLoading(false);
      }
    },
    [projectId, gapId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !gap) return;

    setFormError(null);
    setFieldErrors(null);
    setSavedAt(null);

    const patch: PatchGapInput = {};
    const bandError = validateBand('Demand potential', demand);
    const credibilityError = validateBand('Credibility impact', credibility);
    const citationError = validateBand('Citation likelihood', citation);
    const impactError = validateBand('Impact', impact);
    const effortError = validateBand('Effort', effort);

    const errors: Record<string, string[]> = {};
    if (bandError) errors.demandPotential = [bandError];
    if (credibilityError) errors.credibilityImpact = [credibilityError];
    if (citationError) errors.citationLikelihood = [citationError];
    if (impactError) errors.impactScore = [impactError];
    if (effortError) errors.effortScore = [effortError];

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormError('Some bands are outside the allowed range. Fix them and save again.');
      return;
    }

    // Only send what changed: an unchanged axis keeps its current auto/override
    // state, and sending every field would silently override the automatic ones.
    if (demand !== bandToInput(gap.demandPotential)) patch.demandPotential = Number(demand);
    if (credibility !== bandToInput(gap.credibilityImpact)) patch.credibilityImpact = Number(credibility);
    if (citation !== bandToInput(gap.citationLikelihood)) patch.citationLikelihood = Number(citation);
    if (impact !== bandToInput(gap.impactScore)) patch.impactScore = Number(impact);
    if (effort !== bandToInput(gap.effortScore)) patch.effortScore = Number(effort);
    if (status !== gap.status) patch.status = status;

    if (Object.keys(patch).length === 0) {
      setFormError('Nothing has changed, so there is nothing to save.');
      return;
    }

    setSaving(true);
    try {
      const updated = await patchGap(projectId, gapId, patch);
      setGap(updated);
      setSavedAt(new Date().toISOString());
      setDemand(bandToInput(updated.demandPotential));
      setCredibility(bandToInput(updated.credibilityImpact));
      setCitation(bandToInput(updated.citationLikelihood));
      setImpact(bandToInput(updated.impactScore));
      setEffort(bandToInput(updated.effortScore));
    } catch (caught) {
      const apiError = toApiError(caught);
      setFieldErrors(apiError.fieldErrors ?? null);
      setFormError(
        apiError.kind === 'not-found'
          ? 'This finding no longer exists on the project. It may have been removed by a re-classification.'
          : 'Your change was not saved. The finding still has its previous inputs.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl space-y-6">
        <PageHeader
          breadcrumbs={[{ label: 'Priorities', href: `/projects/${projectId}/priorities` }]}
          title="Finding"
        />
        <ErrorState
          error={error}
          notFoundReason="missing-or-private"
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!gap) return null;

  const overriddenAxes = [
    !gap.dimensionAutoAssigned ? 'dimension' : null,
    !gap.actionAutoAssigned ? 'action' : null,
    !gap.categoryAutoAssigned ? 'category' : null,
    !gap.copyAutoAssigned ? 'title and description' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: 'Project', href: `/projects/${projectId}` },
          { label: 'Priorities', href: `/projects/${projectId}/priorities` },
          { label: 'Finding' },
        ]}
        title={gap.title}
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {GAP_CATEGORY_LABEL[gap.category as GapCategory] ?? gap.category} ·{' '}
              {GAP_ACTION_LABEL[gap.action as GapAction] ?? gap.action} ·{' '}
              {GAP_DIMENSION_LABEL[gap.dimension as GapDimension] ?? gap.dimension}
            </span>
            {gap.severity ? <span className="text-muted-foreground">Severity: {gap.severity}</span> : null}
          </span>
        }
        status={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={statusTone(gap.status)}
              label={GAP_STATUS_LABEL[gap.status as GapStatus] ?? gap.status}
            />
            <ProvenanceBadge kind="derived" />
            {gap.quadrant ? (
              <ProvenanceBadge
                kind="derived"
                label={QUADRANT_LABELS[gap.quadrant as ImpactEffortQuadrant] ?? gap.quadrant}
              />
            ) : null}
          </span>
        }
      />

      {savedAt ? (
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>
            The server confirmed the change at <Timestamp value={savedAt} />. The values below are
            the server&apos;s own, re-read rather than assumed.
          </AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{formError}</p>
            {fieldErrors ? (
              <ul className="list-inside list-disc space-y-1">
                {Object.entries(fieldErrors).map(([field, messages]) => (
                  <li key={field}>
                    <a href={`#${field}`} className="underline underline-offset-4">
                      {messages.join(' ')}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Observed issue</CardTitle>
          <ProvenanceBadge kind="derived" label="Classified from a stored finding" />
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-wrap text-body">{gap.description}</p>

          <dl className="grid gap-1 text-table sm:grid-cols-2">
            <Row label="Recorded">
              <Timestamp value={gap.createdAt} />
            </Row>
            <Row label="Last changed">
              <Timestamp value={gap.updatedAt} />
            </Row>
            <Row label="Source module">
              <span className="font-mono text-meta">{gap.sourceType}</span>
            </Row>
            <Row label="Source record">
              <span className="break-all font-mono text-meta">{gap.sourceId}</span>
            </Row>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setEvidenceOpen(true)}>
              Open the evidence
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/projects/${projectId}/runs`}>Project run history</Link>
            </Button>
          </div>

          <p className="text-meta text-muted-foreground">
            The source is named by module and record id rather than a deep link, because each source
            module addresses its own records differently. The run history is where the run that
            produced this record can be found.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Classification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-1 text-table sm:grid-cols-2">
            <Row label="Category">
              {GAP_CATEGORY_LABEL[gap.category as GapCategory] ?? gap.category}{' '}
              <AxisOrigin auto={gap.categoryAutoAssigned} />
            </Row>
            <Row label="Action">
              {GAP_ACTION_LABEL[gap.action as GapAction] ?? gap.action}{' '}
              <AxisOrigin auto={gap.actionAutoAssigned} />
            </Row>
            <Row label="Dimension">
              {GAP_DIMENSION_LABEL[gap.dimension as GapDimension] ?? gap.dimension}{' '}
              <AxisOrigin auto={gap.dimensionAutoAssigned} />
            </Row>
            <Row label="Wording">
              <AxisOrigin auto={gap.copyAutoAssigned} autoLabel="from the source" manualLabel="edited by an operator" />
            </Row>
            <Row label="Scores">
              <AxisOrigin auto={gap.scoreAutoAssigned} autoLabel="classified" manualLabel="overridden by an operator" />
            </Row>
          </dl>

          <p className="text-table text-muted-foreground">
            {overriddenAxes.length === 0
              ? 'Every axis is currently automatic. A re-classification will update them all from the stored evidence.'
              : `A re-classification will preserve the operator-set ${overriddenAxes.join(', ')}, and update the rest.`}{' '}
            The allowed values are the module&apos;s own vocabularies —{' '}
            {GAP_ACTIONS.length} actions, {GAP_DIMENSIONS.length} dimensions, {GAP_CATEGORIES.length}{' '}
            categories — so a value outside them cannot be stored.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Recommendation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {gap.recommendationCategory ? (
            <p className="text-table">
              Bundled under{' '}
              <strong className="font-medium">
                {gap.recommendationCategory.replace(/-/g, ' ')}
              </strong>{' '}
              when the strategy plan is built. The plan points at this finding by id rather than
              copying its text, so a later re-classification updates the roadmap automatically.
            </p>
          ) : (
            <EmptyState
              variant="not-measured"
              subject="a recommendation category for this finding"
              prerequisite="a finding that calls for action — strengths are deliberately left without one"
              layout="inline"
            >
              <p>
                Nothing to act on has been assigned here. A strength is left without a category by
                design: there is nothing to recommend doing about a thing that is already working.
              </p>
            </EmptyState>
          )}

          <p className="text-meta text-muted-foreground">
            <Link href={`/projects/${projectId}/roadmap`} className="underline underline-offset-4">
              Open the roadmap
            </Link>{' '}
            to see where this sits in the ordered plan.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={onSubmit} noValidate>
        <Card>
          <CardHeader>
            <CardTitle className="text-subsection">Priority, impact and effort</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-table text-muted-foreground">
              The three PR/outreach bands are manual judgements on a 1–5 scale. Saving one makes it
              operator-set, which means a later re-classification will not overwrite it — that is
              stated here because it is the one consequence of this form that is hard to undo by
              accident.
            </p>

            <fieldset className="space-y-3">
              <legend className="text-table font-medium">
                PR / outreach bands (each 1–5)
              </legend>
              <Band
                id="demandPotential"
                label="Demand potential"
                help="How much search or audience demand the finding sits against."
                value={demand}
                onChange={setDemand}
                current={gap.demandPotential}
                errors={fieldErrors?.demandPotential}
                disabled={saving}
              />
              <Band
                id="credibilityImpact"
                label="Credibility impact"
                help="How much it affects how credible the brand looks."
                value={credibility}
                onChange={setCredibility}
                current={gap.credibilityImpact}
                errors={fieldErrors?.credibilityImpact}
                disabled={saving}
              />
              <Band
                id="citationLikelihood"
                label="Citation likelihood"
                help="How likely this is to earn a citation or a mention."
                value={citation}
                onChange={setCitation}
                current={gap.citationLikelihood}
                errors={fieldErrors?.citationLikelihood}
                disabled={saving}
              />
            </fieldset>

            <div className="grid gap-2 rounded-md border border-border bg-surface-sunken p-3 text-table sm:grid-cols-2">
              <Row label="Derived priority score">
                {gap.priorityScore === null ? (
                  <span className="text-muted-foreground">{notMeasuredLabel()}</span>
                ) : (
                  formatNumber(gap.priorityScore)
                )}
              </Row>
              <Row label="Derived quadrant">
                {gap.quadrant ? (
                  QUADRANT_LABELS[gap.quadrant as ImpactEffortQuadrant] ?? gap.quadrant
                ) : (
                  <span className="text-muted-foreground">No quadrant</span>
                )}
              </Row>
            </div>

            <fieldset className="space-y-3">
              <legend className="text-table font-medium">
                Impact and effort override (each 1–5)
              </legend>
              <Band
                id="impactScore"
                label="Impact"
                help="Overrides the classified impact band. Clearing it hands the axis back to the classifier."
                value={impact}
                onChange={setImpact}
                current={gap.impactScore}
                errors={fieldErrors?.impactScore}
                disabled={saving}
              />
              <Band
                id="effortScore"
                label="Effort"
                help="Overrides the classified effort band. The quadrant recomputes from the pair."
                value={effort}
                onChange={setEffort}
                current={gap.effortScore}
                errors={fieldErrors?.effortScore}
                disabled={saving}
              />
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-table font-medium">Status</legend>
              <div className="flex flex-wrap gap-2">
                {GAP_STATUSES.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={status === value ? 'default' : 'outline'}
                    aria-pressed={status === value}
                    onClick={() => setStatus(value)}
                    disabled={saving}
                  >
                    {GAP_STATUS_LABEL[value]}
                  </Button>
                ))}
              </div>
              <p className="text-meta text-muted-foreground">
                Resolution records that the finding was dealt with. It is not verification — proof
                that a change landed is recorded against the work item, not against the finding.
              </p>
            </fieldset>

            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save priority inputs'}
            </Button>
          </CardContent>
        </Card>
      </form>

      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Owner, dependency and verification</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            variant="not-measured"
            subject="an owner, a dependency and a verification for this finding"
            prerequisite="converting the finding into a work item, which is what carries those fields (design_plan G06)"
            layout="panel"
          >
            <p>
              A finding is a classified observation. It has a source, a score and a status, and it
              deliberately has no assignee: responsibility in this model belongs to a committed work
              item, which is where §7.2&apos;s one-named-owner rule is enforced.
            </p>
            <p>
              Verification is likewise evidence recorded against the work, not a checkbox on the
              finding — a resolved finding is not a proven fix, and this screen will not present it
              as one.
            </p>
          </EmptyState>
        </CardContent>
      </Card>

      <EvidenceDrawer
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        title={gap.title}
        source={{
          name: gap.sourceType,
          capturedAt: gap.createdAt,
          // The source record id is the closest thing to a run reference the
          // gap carries; it is named rather than guessed at.
          url: undefined,
          query: gap.sourceId,
        }}
        observed={
          <span className="whitespace-pre-wrap">
            {gap.description}
            {gap.severity ? ` (severity: ${gap.severity})` : ''}
          </span>
        }
        interpretation={
          <>
            Classified as{' '}
            {GAP_CATEGORY_LABEL[gap.category as GapCategory] ?? gap.category},{' '}
            {GAP_ACTION_LABEL[gap.action as GapAction] ?? gap.action}, in the{' '}
            {GAP_DIMENSION_LABEL[gap.dimension as GapDimension] ?? gap.dimension} dimension.
            {gap.impactScore !== null && gap.effortScore !== null
              ? ` Impact ${gap.impactScore} against effort ${gap.effortScore}.`
              : ''}
          </>
        }
        interpretationKind="derived"
        raw={{
          label: 'Source record',
          text: `${gap.sourceType}:${gap.sourceId}`,
        }}
        provenance="derived"
        related={[
          { label: 'Roadmap', href: `/projects/${projectId}/roadmap`, kind: 'gap' },
          { label: 'All priorities', href: `/projects/${projectId}/priorities`, kind: 'gap' },
        ]}
      />
    </div>
  );
}

/** A 1–5 band input, with its current stored value stated next to it. */
function Band({
  id,
  label,
  help,
  value,
  onChange,
  current,
  errors,
  disabled,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  current: number | null;
  errors?: string[];
  disabled?: boolean;
}) {
  const invalid = Boolean(errors?.length);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        <span className="ml-1 text-meta font-normal text-muted-foreground">
          (1–5, or blank for not set)
        </span>
      </Label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          name={id}
          type="number"
          min={1}
          max={5}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : `${id}-help`}
          className="h-9 w-24 rounded-md border border-input bg-surface px-3 py-1 text-table shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="text-meta text-muted-foreground">
          Currently {current === null ? notMeasuredLabel() : formatNumber(current)}
        </span>
      </div>
      {invalid ? (
        <p id={`${id}-error`} className="text-meta text-danger-foreground">
          {errors?.join(' ')}
        </p>
      ) : (
        <p id={`${id}-help`} className="text-meta text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** Says where a value came from, in words rather than by colour. */
function AxisOrigin({
  auto,
  autoLabel = 'automatic',
  manualLabel = 'set by an operator',
}: {
  auto: boolean;
  autoLabel?: string;
  manualLabel?: string;
}) {
  return (
    <span className="text-meta text-muted-foreground">({auto ? autoLabel : manualLabel})</span>
  );
}

function statusTone(status: string): 'success' | 'info' | 'neutral' {
  if (status === 'resolved') return 'success';
  if (status === 'in-progress') return 'info';
  return 'neutral';
}

function bandToInput(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Empty is allowed (meaning "not set"); anything else must be an integer 1–5. */
function validateBand(label: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    return `${label} must be a whole number from 1 to 5, or left blank.`;
  }
  return null;
}

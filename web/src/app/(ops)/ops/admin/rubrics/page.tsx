'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  DEFAULT_RUBRIC_BANDS,
  DEFAULT_RUBRIC_WEIGHTS,
  RUBRIC_DIMENSIONS,
  RUBRIC_WEIGHT_TOTAL,
  createRubric,
  listRubrics,
  weightsSum,
  type RubricBand,
  type RubricDimensionKey,
  type RubricWeights,
  type ScoreRubric,
} from '@/services/admin';

/**
 * OP17 — Rubrics.
 *
 * design_plan.md §4.2: *"Version history, dimensions/weights/bands, sum
 * validation, create/activate version, scoring explanation."*
 *
 * ## The sum is validated in front of the operator
 *
 * §8 requires a rubric's weights to sum to exactly 100, and the backend
 * enforces it with a 400. A 400 discovered after pressing the button is a poor
 * way to learn arithmetic, so the running total is on screen while the numbers
 * are typed, it is stated in words when it is wrong, and **the activate
 * control is disabled while it is**. The server still validates — this is the
 * explanation §10.4 asks for ahead of the action, not a substitute for it.
 *
 * ## What a "scoring explanation" has to say
 *
 * §6.3's metric dictionary forbids inventing frontend scoring: the total is the
 * sum of the backend's rounded contributions, and an unmeasured dimension
 * contributes zero under the rubric rather than being silently reweighted. Both
 * facts are on the page, because both change how a score should be read.
 *
 * ## Version history is a real history here
 *
 * Unlike program templates, rubric versions are separate rows: an earlier
 * version stays readable after a new one is activated, and a past score run
 * still names the version it was computed under.
 */

interface DraftBand {
  max: string;
  band: string;
}

export default function AdminRubricsPage() {
  const [rubrics, setRubrics] = useState<ScoreRubric[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      setRubrics(await listRubrics({ signal }));
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

  const active = useMemo(() => rubrics?.find((rubric) => rubric.active) ?? null, [rubrics]);

  const columns = useMemo<ReadonlyArray<ColumnDef<ScoreRubric>>>(
    () => [
      {
        key: 'version',
        header: 'Version',
        accessor: (row) => row.version,
        sortable: true,
        width: 110,
        render: (row) => <span className="font-semibold tabular-nums">v{row.version}</span>,
      },
      {
        key: 'active',
        header: 'Status',
        accessor: (row) => (row.active ? 'active' : 'superseded'),
        sortable: true,
        width: 130,
        render: (row) =>
          row.active ? (
            <StatusPill label="Active" tone="success" />
          ) : (
            <StatusPill label="Superseded" tone="neutral" />
          ),
      },
      {
        key: 'sum',
        header: 'Weight total',
        accessor: (row) => weightsSum(row.weights),
        sortable: true,
        align: 'right',
        width: 140,
        render: (row) => {
          const total = weightsSum(row.weights);
          return (
            <span className={total === RUBRIC_WEIGHT_TOTAL ? '' : 'text-warning'}>
              <span className="tabular-nums font-medium">{total}</span>
              {total === RUBRIC_WEIGHT_TOTAL ? null : (
                <span className="ml-1 text-meta">(not 100)</span>
              )}
            </span>
          );
        },
      },
      {
        key: 'bands',
        header: 'Bands',
        accessor: (row) => row.bands.length,
        align: 'right',
        width: 100,
      },
      {
        key: 'note',
        header: 'Note',
        accessor: (row) => row.note ?? '',
        render: (row) =>
          row.note ? (
            <span className="text-table">{row.note}</span>
          ) : (
            <span className="text-muted-foreground">No note recorded</span>
          ),
      },
      {
        key: 'createdAt',
        header: 'Created',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 200,
        render: (row) => <Timestamp value={row.createdAt} />,
      },
    ],
    [],
  );

  if (error?.kind === 'forbidden') {
    return (
      <div className="space-y-6">
        <PageHeader title="Score settings" />
        <EmptyState
          variant="insufficient-role"
          restrictedAction="read or change scoring rubrics"
          permittedPath="Ask an administrator. A project's score runs are readable to the operators assigned to it."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Score settings" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!rubrics) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Score settings"
        context={
          active
            ? `Version ${active.version} is active. ${rubrics.length} version${rubrics.length === 1 ? '' : 's'} on record.`
            : `${rubrics.length} version${rubrics.length === 1 ? '' : 's'} on record, none active.`
        }
        status={
          active && weightsSum(active.weights) !== RUBRIC_WEIGHT_TOTAL ? (
            <StatusPill label="Active version does not sum to 100" tone="warning" />
          ) : undefined
        }
      />

      {!active ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>No rubric version is active</AlertTitle>
          <AlertDescription>
            Scores cannot be computed while no version is active. Creating the
            first version activates it automatically; later versions need
            &ldquo;activate&rdquo; to be chosen explicitly.
          </AlertDescription>
        </Alert>
      ) : null}

      <ScoringExplanation active={active} />

      <section className="space-y-3" aria-labelledby="rubric-history">
        <h2 id="rubric-history" className="text-subsection font-semibold">
          Version history
        </h2>
        <p className="text-table text-muted-foreground">
          Each version is a separate record, so a past score run still names the
          version it was computed under. Expand a row to read its dimensions and
          bands.
        </p>
        <DataTable
          caption="Rubric versions"
          columns={columns}
          rows={rubrics}
          getRowId={(row) => row.id}
          defaultSort={{ key: 'version', direction: 'desc' }}
          rowDetail={(row) => <RubricDetail rubric={row} />}
          emptyState={
            <EmptyState
              variant="not-measured"
              subject="rubric versions"
              prerequisite="Creating a version below writes version 1 and activates it."
            />
          }
        />
      </section>

      <CreateRubricCard
        nextVersion={(rubrics[0]?.version ?? 0) + 1}
        hasActive={Boolean(active)}
        onCreated={() => void load()}
      />
    </div>
  );
}

function ScoringExplanation({ active }: { active: ScoreRubric | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">How a score is computed</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-table">
        <p>
          Each dimension is measured on a 0–100 scale, multiplied by its weight,
          and divided by 100. The total is the sum of those rounded
          contributions — this screen never recomputes a score of its own, and a
          score&rsquo;s own result is what is displayed wherever it appears.
        </p>
        <p className="text-muted-foreground">
          <strong>An unmeasured dimension contributes zero</strong> and marks the
          whole run <em>partial</em>. Weights are not silently redistributed
          across the dimensions that did report, so a partial run&rsquo;s total
          is lower than the same evidence would produce with every check
          complete. Read a partial score alongside its coverage, not on its own.
        </p>
        <p className="text-muted-foreground">
          A band label such as &ldquo;recommended&rdquo; is this rubric&rsquo;s
          own name for a score range. It is not a statement that an engine
          recommends the brand.
        </p>
        {active ? (
          <>
            <Separator />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <h4 className="text-meta font-medium text-muted-foreground">
                  Active version v{active.version}
                </h4>
                <p className="mt-1 text-meta text-muted-foreground">
                  {active.note ?? 'No note was recorded with this version.'}
                </p>
              </div>
              <div>
                <h4 className="text-meta font-medium text-muted-foreground">Band table</h4>
                <ul className="mt-1 space-y-0.5">
                  {active.bands.map((band, index) => {
                    const previous = index === 0 ? 0 : active.bands[index - 1].max;
                    const lower = index === 0 ? 0 : previous + 1;
                    return (
                      <li key={`${band.band}-${band.max}`} className="text-meta">
                        <span className="tabular-nums">
                          {lower}–{band.max}
                        </span>{' '}
                        · {band.band}
                        {index === active.bands.length - 1 ? ' (and above is not possible)' : ''}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RubricDetail({ rubric }: { rubric: ScoreRubric }) {
  const total = weightsSum(rubric.weights);
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-meta font-medium text-muted-foreground">
          Dimensions and weights
        </h4>
        <ul className="mt-1 space-y-1">
          {RUBRIC_DIMENSIONS.map((dimension) => {
            const weight = rubric.weights[dimension.key] ?? 0;
            return (
              <li key={dimension.key} className="flex items-center gap-3 text-table">
                <span className="min-w-[12rem]">{dimension.label}</span>
                <span className="tabular-nums font-medium">{weight}</span>
                <span className="text-meta text-muted-foreground">
                  {weight > 0
                    ? `contributes up to ${weight} point${weight === 1 ? '' : 's'}`
                    : 'contributes nothing under this version'}
                </span>
              </li>
            );
          })}
          <li className="flex items-center gap-3 border-t border-border pt-1 text-table font-medium">
            <span className="min-w-[12rem]">Total</span>
            <span className={`tabular-nums ${total === RUBRIC_WEIGHT_TOTAL ? '' : 'text-warning'}`}>
              {total}
            </span>
            <span className="text-meta text-muted-foreground">
              {total === RUBRIC_WEIGHT_TOTAL
                ? 'Sums to 100, as §8 requires.'
                : `Does not sum to ${RUBRIC_WEIGHT_TOTAL}. The server refuses to create a version in this state; if this version exists, it was written before that rule applied and scores computed under it are not comparable with the others.`}
            </span>
          </li>
        </ul>
      </div>

      <div>
        <h4 className="text-meta font-medium text-muted-foreground">Bands</h4>
        <ul className="mt-1 space-y-1">
          {rubric.bands.map((band, index) => {
            const lower = index === 0 ? 0 : rubric.bands[index - 1].max + 1;
            return (
              <li key={`${band.band}-${band.max}`} className="text-table">
                <span className="tabular-nums">
                  {lower}–{band.max}
                </span>{' '}
                · {band.band}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function CreateRubricCard({
  nextVersion,
  hasActive,
  onCreated,
}: {
  nextVersion: number;
  hasActive: boolean;
  onCreated: () => void;
}) {
  const [weights, setWeights] = useState<Record<RubricDimensionKey, string>>(() =>
    Object.fromEntries(
      RUBRIC_DIMENSIONS.map((dimension) => [
        dimension.key,
        String(DEFAULT_RUBRIC_WEIGHTS[dimension.key]),
      ]),
    ) as Record<RubricDimensionKey, string>,
  );
  const [bands, setBands] = useState<DraftBand[]>(() =>
    DEFAULT_RUBRIC_BANDS.map((band) => ({ max: String(band.max), band: band.band })),
  );
  const [note, setNote] = useState('');
  const [activate, setActivate] = useState(!hasActive);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ScoreRubric | null>(null);

  const numericWeights = useMemo(() => {
    const result = {} as RubricWeights;
    for (const dimension of RUBRIC_DIMENSIONS) {
      const parsed = Number(weights[dimension.key]);
      result[dimension.key] = Number.isFinite(parsed) ? parsed : NaN;
    }
    return result;
  }, [weights]);

  const total = weightsSum(numericWeights);
  const totalValid = total === RUBRIC_WEIGHT_TOTAL;
  const anyNonNumeric = RUBRIC_DIMENSIONS.some(
    (dimension) => !Number.isFinite(numericWeights[dimension.key]),
  );

  // Bands must be an ascending list of 0–100 maxima. The backend re-validates
  // each `max`; the ordering rule is what makes the table readable at all, so
  // it is checked here too and explained rather than silently enforced.
  const bandValidation = useMemo(() => {
    const parsed = bands.map((band) => ({
      max: Number(band.max),
      band: band.band.trim(),
    }));
    for (const entry of parsed) {
      if (!Number.isInteger(entry.max) || entry.max < 0 || entry.max > 100) {
        return { ok: false, reason: 'Every band maximum must be a whole number from 0 to 100.' };
      }
      if (!entry.band) return { ok: false, reason: 'Every band needs a name.' };
    }
    for (let index = 1; index < parsed.length; index += 1) {
      if (parsed[index].max <= parsed[index - 1].max) {
        return {
          ok: false,
          reason: 'Band maxima must strictly increase, or a score could fall into two bands.',
        };
      }
    }
    return { ok: true, reason: null, parsed };
  }, [bands]);

  const canSubmit =
    totalValid && !anyNonNumeric && bandValidation.ok && !busy && note.trim().length >= 3;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!bandValidation.ok) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const written = await createRubric({
        weights: numericWeights,
        bands: bandValidation.parsed as RubricBand[],
        activate,
        note: note.trim(),
      });
      setCreated(written);
      setNote('');
      onCreated();
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">
          Create rubric version v{nextVersion}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-5">
          {created ? (
            <Alert>
              <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>
                Version {created.version} created
                {created.active ? ' and activated' : ' — not activated'}
              </AlertTitle>
              <AlertDescription>
                {created.active
                  ? 'New score runs use this version. Runs already computed keep the version they used.'
                  : 'Existing runs continue under the previously active version until this one is activated.'}
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <ErrorState
              error={error}
              layout="inline"
              fieldIdPrefix="rubric-"
              preserveNotice="The weights you entered are still on this page."
            />
          ) : null}

          <fieldset className="space-y-3">
            <legend className="text-table font-medium">Dimensions and weights</legend>
            <p className="text-meta text-muted-foreground">
              Weights are points out of 100. They must total exactly{' '}
              {RUBRIC_WEIGHT_TOTAL} — the server refuses a version that does not,
              so the total is checked here first.
            </p>
            <div className="space-y-3">
              {RUBRIC_DIMENSIONS.map((dimension) => (
                <div key={dimension.key} className="flex items-center gap-3">
                  <Label
                    htmlFor={`rubric-${dimension.key}`}
                    className="min-w-[12rem] shrink-0 text-table font-normal"
                  >
                    {dimension.label}
                  </Label>
                  <Input
                    id={`rubric-${dimension.key}`}
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    className="max-w-[7rem]"
                    value={weights[dimension.key]}
                    onChange={(event) =>
                      setWeights({ ...weights, [dimension.key]: event.target.value })
                    }
                    aria-invalid={!Number.isFinite(numericWeights[dimension.key])}
                  />
                  <span className="text-meta text-muted-foreground">
                    {Number.isFinite(numericWeights[dimension.key])
                      ? `up to ${numericWeights[dimension.key]} point${numericWeights[dimension.key] === 1 ? '' : 's'}`
                      : 'Enter a number'}
                  </span>
                </div>
              ))}
            </div>

            {/*
              The sum validation, visible while the numbers are typed rather
              than reported as a 400 afterwards. It is stated in words, not by
              colour alone.
            */}
            <div
              role="status"
              aria-live="polite"
              className={`rounded-md border px-3 py-2 text-table ${
                totalValid ? 'border-success/40 bg-success-subtle' : 'border-warning/40 bg-warning-subtle'
              }`}
            >
              <p className="font-medium">
                Weights total {Number.isFinite(total) ? total : '—'}
                {totalValid ? ', which is correct.' : `, and must total ${RUBRIC_WEIGHT_TOTAL}.`}
              </p>
              {!totalValid ? (
                <p className="mt-0.5 text-meta">
                  {anyNonNumeric
                    ? 'One or more weights is not a number. Every dimension needs one.'
                    : total < RUBRIC_WEIGHT_TOTAL
                      ? `Add ${RUBRIC_WEIGHT_TOTAL - total} more point${RUBRIC_WEIGHT_TOTAL - total === 1 ? '' : 's'} before this version can be created.`
                      : `Remove ${total - RUBRIC_WEIGHT_TOTAL} point${total - RUBRIC_WEIGHT_TOTAL === 1 ? '' : 's'} before this version can be created.`}
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-table font-medium">Bands</legend>
            <p className="text-meta text-muted-foreground">
              A band says which label a score range carries. Maxima must
              strictly increase; the last band covers everything above the one
              before it.
            </p>
            <div className="space-y-2">
              {bands.map((band, index) => (
                <div key={index} className="flex flex-wrap items-center gap-3">
                  <Input
                    aria-label={`Band ${index + 1} maximum`}
                    type="number"
                    min={0}
                    max={100}
                    className="max-w-[7rem]"
                    value={band.max}
                    onChange={(event) => {
                      const next = [...bands];
                      next[index] = { ...band, max: event.target.value };
                      setBands(next);
                    }}
                  />
                  <Input
                    aria-label={`Band ${index + 1} name`}
                    className="max-w-[14rem]"
                    value={band.band}
                    onChange={(event) => {
                      const next = [...bands];
                      next[index] = { ...band, band: event.target.value };
                      setBands(next);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={bands.length <= 1}
                    onClick={() => setBands(bands.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            {!bandValidation.ok ? (
              <p className="text-table text-warning">{bandValidation.reason}</p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bands.length >= 10}
              onClick={() => setBands([...bands, { max: '', band: '' }])}
            >
              <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
              Add band
            </Button>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="rubric-note">
              Note <span className="text-muted-foreground">(required, at least 3 characters)</span>
            </Label>
            <Textarea
              id="rubric-note"
              required
              minLength={3}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this version exists — what changed and what it is for."
            />
            <p className="text-meta text-muted-foreground">
              Stored with the version and read alongside it later. A version
              with no explanation is hard to justify a year on.
            </p>
          </div>

          <Separator />

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Switch
                id="rubric-activate"
                checked={activate}
                onCheckedChange={setActivate}
                disabled={!totalValid}
              />
              <div>
                <Label htmlFor="rubric-activate" className="text-table">
                  Activate this version on creation
                </Label>
                <p className="text-meta text-muted-foreground">
                  {hasActive
                    ? 'Activating moves new score runs onto this version. Existing runs keep the version they were computed under, and their totals do not change.'
                    : 'There is no active version, so this one is activated automatically.'}
                </p>
              </div>
            </div>
            <Button type="submit" disabled={!canSubmit}>
              {busy
                ? 'Creating…'
                : activate
                  ? `Create and activate v${nextVersion}`
                  : `Create v${nextVersion} without activating`}
            </Button>
          </div>

          {!totalValid ? (
            <Alert>
              <ShieldAlert aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Activation is blocked until the weights total 100</AlertTitle>
              <AlertDescription>
                This control stays disabled while the total is wrong, but the
                server is what enforces it — a request that bypassed this page
                would still be refused.
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

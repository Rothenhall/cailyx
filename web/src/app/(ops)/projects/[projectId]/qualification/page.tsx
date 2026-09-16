'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Calculator, Info, TrendingDown, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber } from '@/lib/format';
import {
  getPipelineMath,
  savePipelineMath,
  type PipelineMath,
  type PipelineMathInput,
  type PipelineStages,
} from '@/services/sales';

/**
 * SL04 — Qualification.
 *
 * design_plan.md §4.2: *"Revenue/ACV/conversion inputs, funnel arithmetic,
 * feasible/fiction, assumptions."* §5.11 is blunt about how the output may be
 * described, and this screen is built to those sentences rather than around
 * them:
 *
 * > *"SL04 computes the chain from revenue target → deals → SQLs → meetings →
 * > leads → visitors. Store the user's rate assumptions and explain the result
 * > as scenario arithmetic. Use its `feasible`/`fiction` output with context;
 * > do not portray it as a forecast based on actual acquisition data."*
 *
 * So: the six inputs are labelled **assumptions** wherever they appear, the
 * output is labelled **scenario arithmetic**, and the word *forecast* is not
 * used of it anywhere. `fiction` is described for what it is — a statement that
 * the arithmetic requires more visitors than the stated market holds, by more
 * than the disclosed threshold — and not as a prediction about the market.
 *
 * ## The arithmetic is the backend's
 *
 * Every intermediate stage is computed and persisted server-side. This screen
 * renders the returned numbers; it does not re-derive them. Two consequences
 * worth stating on the page: each stage is rounded **up** to a whole unit (a
 * fractional meeting is not a meeting), and a model with no market size gets
 * `feasible` because there is nothing to check it against — which is an absence
 * of evidence, not evidence of feasibility.
 */

const RATE_FIELDS = [
  {
    key: 'winRate' as const,
    label: 'Close rate',
    help: 'Of the sales-qualified opportunities you work, the share that become customers.',
    min: 0.001,
  },
  {
    key: 'meetingToSql' as const,
    label: 'Meeting → SQL',
    help: 'Of the meetings held, the share that qualify as a real opportunity.',
    min: 0.001,
  },
  {
    key: 'leadToMeeting' as const,
    label: 'Lead → meeting',
    help: 'Of the leads captured, the share that book and hold a meeting.',
    min: 0.001,
  },
  {
    key: 'visitorToLead' as const,
    label: 'Visitor → lead',
    help: 'Of the site visitors, the share that become a captured lead. Usually the smallest number here, and the one the result is most sensitive to.',
    min: 0.0001,
  },
];

interface Draft {
  revenueTarget: string;
  acv: string;
  winRate: string;
  meetingToSql: string;
  leadToMeeting: string;
  visitorToLead: string;
  marketSize: string;
}

function draftFrom(model: PipelineMath | null): Draft {
  if (!model) {
    return {
      revenueTarget: '',
      acv: '',
      winRate: '25',
      meetingToSql: '40',
      leadToMeeting: '20',
      visitorToLead: '2',
      marketSize: '',
    };
  }
  return {
    revenueTarget: String(model.revenueTarget),
    acv: String(model.acv),
    winRate: String(round(model.winRate * 100)),
    meetingToSql: String(round(model.meetingToSql * 100)),
    leadToMeeting: String(round(model.leadToMeeting * 100)),
    visitorToLead: String(round(model.visitorToLead * 100)),
    marketSize: model.marketSize === null ? '' : String(model.marketSize),
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export default function QualificationPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [model, setModel] = useState<PipelineMath | null>(null);
  const [neverComputed, setNeverComputed] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [saveError, setSaveError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        setError(null);
        const result = await getPipelineMath(projectId, { signal });
        setModel(result);
        setNeverComputed(false);
        setDraft(draftFrom(result));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const normalized = toApiError(caught);
        // 404 here is the documented "never computed" answer, not a failure.
        if (normalized.kind === 'not-found') {
          setModel(null);
          setNeverComputed(true);
        } else {
          setError(normalized);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const validation = useMemo(() => {
    const problems: string[] = [];
    const target = Number(draft.revenueTarget);
    const acv = Number(draft.acv);
    if (!Number.isFinite(target) || target < 1) {
      problems.push('Revenue target must be at least 1.');
    }
    if (!Number.isFinite(acv) || acv < 1) {
      problems.push('Average contract value must be at least 1.');
    }
    for (const field of RATE_FIELDS) {
      const percent = Number(draft[field.key]);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        problems.push(`${field.label} must be a percentage above 0 and at most 100.`);
      } else if (percent / 100 < field.min) {
        problems.push(
          `${field.label} is below the smallest rate the model accepts (${round(field.min * 100)}%).`,
        );
      }
    }
    if (draft.marketSize.trim() !== '') {
      const marketSize = Number(draft.marketSize);
      if (!Number.isFinite(marketSize) || marketSize < 1) {
        problems.push('Market size, when given, must be at least 1.');
      }
    }
    return problems;
  }, [draft]);

  const dirty = useMemo(() => {
    if (!model) return true;
    return JSON.stringify(draftFrom(model)) !== JSON.stringify(draft);
  }, [model, draft]);

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (validation.length > 0) return;
    setBusy(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const input: PipelineMathInput = {
        revenueTarget: Number(draft.revenueTarget),
        acv: Number(draft.acv),
        winRate: Number(draft.winRate) / 100,
        meetingToSql: Number(draft.meetingToSql) / 100,
        leadToMeeting: Number(draft.leadToMeeting) / 100,
        visitorToLead: Number(draft.visitorToLead) / 100,
        ...(draft.marketSize.trim() === '' ? {} : { marketSize: Number(draft.marketSize) }),
      };
      const saved = await savePipelineMath(projectId, input);
      setModel(saved);
      setNeverComputed(false);
      setDraft(draftFrom(saved));
      setSavedAt(saved.updatedAt);
    } catch (caught) {
      setSaveError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Qualification" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Sales pipeline', href: '/ops/sales' }]}
        title="Qualification"
        context="Scenario arithmetic from your stated assumptions."
        status={
          model ? (
            <StatusPill
              label={model.verdict === 'feasible' ? 'Feasible' : 'Fiction'}
              tone={model.verdict === 'feasible' ? 'success' : 'danger'}
            />
          ) : undefined
        }
      />

      {/*
        The framing sentence is not decoration: §5.11 forbids presenting this
        number as a forecast, so the screen says what it is before it shows one.
      */}
      <Alert>
        <Info aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>This is scenario arithmetic, not a forecast</AlertTitle>
        <AlertDescription>
          <p>
            The chain below divides a revenue target by rates you supply. It is
            arithmetic on assumptions — nothing here is measured against actual
            acquisition data, and no result is a prediction of what will happen.
          </p>
          <p className="mt-1">
            Its value is in the contradiction it exposes: if the visitor number
            it produces is larger than the market you can actually reach, the
            plan does not work at the rates you stated, and the fix is one of the
            assumptions rather than the arithmetic.
          </p>
        </AlertDescription>
      </Alert>

      {neverComputed ? (
        <EmptyState
          variant="not-measured"
          subject="a qualification model for this project"
          prerequisite="Entering a revenue target and the conversion rates below, then saving."
          layout="panel"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-table font-medium">Assumptions</CardTitle>
            <p className="text-meta text-muted-foreground">
              Stored with the model and shown beside its output, because a
              visitor number without its rates is not interpretable.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSave} className="space-y-4">
              {saveError ? (
                <ErrorState
                  error={saveError}
                  layout="inline"
                  fieldIdPrefix="qualification-"
                  preserveNotice="Your inputs are still on this page."
                />
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="qualification-revenueTarget">
                    Revenue target <span className="text-muted-foreground">(required)</span>
                  </Label>
                  <Input
                    id="qualification-revenueTarget"
                    type="number"
                    min={1}
                    step="1"
                    value={draft.revenueTarget}
                    onChange={(event) => setDraft({ ...draft, revenueTarget: event.target.value })}
                  />
                  <p className="text-meta text-muted-foreground">
                    In the same currency as the contract value. The model carries
                    no currency code, so both figures must be the same one.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qualification-acv">
                    Average contract value <span className="text-muted-foreground">(required)</span>
                  </Label>
                  <Input
                    id="qualification-acv"
                    type="number"
                    min={1}
                    step="1"
                    value={draft.acv}
                    onChange={(event) => setDraft({ ...draft, acv: event.target.value })}
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                {RATE_FIELDS.map((field) => (
                  <div key={field.key} className="space-y-2">
                    <Label htmlFor={`qualification-${field.key}`}>
                      {field.label} <span className="text-muted-foreground">(% per step)</span>
                    </Label>
                    <Input
                      id={`qualification-${field.key}`}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={draft[field.key]}
                      onChange={(event) =>
                        setDraft({ ...draft, [field.key]: event.target.value })
                      }
                    />
                    <p className="text-meta text-muted-foreground">{field.help}</p>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="qualification-marketSize">Market size (visitors)</Label>
                <Input
                  id="qualification-marketSize"
                  type="number"
                  min={1}
                  step="1"
                  value={draft.marketSize}
                  onChange={(event) => setDraft({ ...draft, marketSize: event.target.value })}
                  placeholder="Leave blank if you do not have a defensible number"
                />
                <p className="text-meta text-muted-foreground">
                  The reachable visitor population. Supplying it is what turns
                  the verdict from &ldquo;nothing to check against&rdquo; into a
                  comparison. A guessed market size produces a confident verdict
                  about a guess.
                </p>
              </div>

              {validation.length > 0 ? (
                <Alert variant="destructive" role="alert">
                  <AlertTitle>These inputs cannot be computed</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {validation.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={busy || validation.length > 0 || !dirty}>
                  <Calculator aria-hidden="true" className="mr-2 h-4 w-4" />
                  {busy ? 'Computing…' : model ? 'Save and recompute' : 'Compute the model'}
                </Button>
                <p className="text-meta text-muted-foreground">
                  Saving replaces the stored model. The previous inputs are not
                  kept — unlike a report, this model is a working estimate that
                  is expected to change during a call.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {model ? (
            <>
              {savedAt ? (
                <Alert>
                  <AlertTitle>Saved</AlertTitle>
                  <AlertDescription>
                    Recomputed and stored. The chain below reflects the
                    assumptions above as of <Timestamp value={savedAt} />.
                  </AlertDescription>
                </Alert>
              ) : null}

              <VerdictPanel model={model} />
              <ChainPanel stages={model.stages} />
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-table font-medium">The chain</CardTitle>
              </CardHeader>
              <CardContent>
                <EmptyState
                  variant="not-measured"
                  subject="the funnel arithmetic"
                  prerequisite="Saving the assumptions on the left."
                  layout="inline"
                >
                  The chain is revenue target → deals → opportunities → meetings →
                  leads → visitors, computed from the rates you enter.
                </EmptyState>
              </CardContent>
            </Card>
          )}

          {model ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-table font-medium">Stored assumptions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Rate label="Close rate" value={model.winRate} />
                  <Rate label="Meeting → opportunity" value={model.meetingToSql} />
                  <Rate label="Lead → meeting" value={model.leadToMeeting} />
                  <Rate label="Visitor → lead" value={model.visitorToLead} />
                  <div>
                    <dt className="text-meta text-muted-foreground">Revenue target</dt>
                    <dd className="mt-0.5 text-table tabular-nums">
                      {formatNumber(model.revenueTarget)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">
                      Average contract value
                    </dt>
                    <dd className="mt-0.5 text-table tabular-nums">{formatNumber(model.acv)}</dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Market size</dt>
                    <dd className="mt-0.5 text-table tabular-nums">
                      {model.marketSize === null ? (
                        <span className="text-muted-foreground">
                          Not stated — no comparison is possible
                        </span>
                      ) : (
                        formatNumber(model.marketSize)
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-muted-foreground">Last computed</dt>
                    <dd className="mt-0.5 text-table">
                      <Timestamp value={model.updatedAt} />
                    </dd>
                  </div>
                </dl>
                <Separator />
                <p className="text-meta text-muted-foreground">
                  These are the operator&rsquo;s stated assumptions, stored as
                  entered. They are not derived from any measured data, and a
                  later change here does not rewrite a report that quoted them.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function VerdictPanel({ model }: { model: PipelineMath }) {
  const feasible = model.verdict === 'feasible';
  const hasMarket = model.marketSize !== null && model.ratio !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-table font-medium">Verdict</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill
            label={feasible ? 'Feasible' : 'Fiction'}
            tone={feasible ? 'success' : 'danger'}
          />
          {hasMarket ? (
            <span className="text-table">
              The plan needs{' '}
              <strong className="tabular-nums">{model.ratio?.toFixed(2)}×</strong> the
              stated market of {formatNumber(model.marketSize ?? 0)} visitors.
            </span>
          ) : null}
        </div>

        {hasMarket ? (
          <>
            <p className="text-table">
              {feasible ? (
                <>
                  <TrendingUp aria-hidden="true" className="mr-1 inline h-4 w-4 text-success" />
                  The required visitors are within the market you stated, at or
                  below the disclosed threshold of {model.fictionFactor}×.
                </>
              ) : (
                <>
                  <TrendingDown aria-hidden="true" className="mr-1 inline h-4 w-4 text-danger" />
                  The required visitors exceed the market you stated by more than{' '}
                  {model.fictionFactor}×. The plan does not work at these rates
                  and that market — one of the two has to change.
                </>
              )}
            </p>
            <p className="text-meta text-muted-foreground">
              &ldquo;Fiction&rdquo; here describes the arithmetic against the
              market size you supplied. It is not a claim about the real market,
              and it is not a prediction: it says the two numbers you gave are
              inconsistent with each other.
            </p>
          </>
        ) : (
          <p className="text-table">
            No market size was supplied, so there is nothing to check the result
            against. The verdict falls back to <strong>feasible</strong> — which
            in this state means <em>uncontradicted</em>, not <em>achievable</em>.
          </p>
        )}

        <Separator />
        <p className="text-meta text-muted-foreground">
          Threshold disclosed on every response: a plan is called fiction when
          the required visitors exceed the market size by more than{' '}
          {model.fictionFactor}×.
        </p>
      </CardContent>
    </Card>
  );
}

const STAGE_LABEL: Array<{ key: keyof PipelineStages; label: string; divisor: string }> = [
  { key: 'deals', label: 'Deals needed', divisor: 'revenue target ÷ contract value' },
  { key: 'sqls', label: 'Opportunities needed', divisor: 'deals ÷ close rate' },
  { key: 'meetings', label: 'Meetings needed', divisor: 'opportunities ÷ meeting→SQL rate' },
  { key: 'leads', label: 'Leads needed', divisor: 'meetings ÷ lead→meeting rate' },
  { key: 'visitors', label: 'Visitors needed', divisor: 'leads ÷ visitor→lead rate' },
];

function ChainPanel({ stages }: { stages: PipelineStages }) {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-table font-medium">The chain</CardTitle>
        <p className="text-meta text-muted-foreground">
          Each stage is rounded up to a whole unit — a fractional meeting is not
          a meeting — so the required visitors is a ceiling, not an average.
        </p>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {STAGE_LABEL.map((stage, index) => (
            <li key={stage.key} className="flex items-start gap-3">
              <span className="mt-0.5 text-meta tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-table font-medium">{stage.label}</span>
                  <span className="text-subsection tabular-nums font-semibold">
                    {formatNumber(stages[stage.key])}
                  </span>
                </div>
                <p className="text-meta text-muted-foreground">{stage.divisor}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function Rate({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-table tabular-nums">
        {round(value * 100)}%
        {/* The stored fraction, so an operator can see the exact value the
            arithmetic used rather than a rounded display. */}
        <span className="ml-1 text-meta text-muted-foreground">({value})</span>
      </dd>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { RefreshCw, Ruler } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { DataTable, type ColumnDef } from '@/components/patterns/DataTable';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { EvidenceDrawer } from '@/components/patterns/EvidenceDrawer';
import { MetricTile } from '@/components/patterns/MetricTile';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useUrlState } from '@/hooks/useUrlState';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  STRUCTURE_WEIGHTS,
  analyzePage,
  decodeAnalysisDetail,
  listPageAnalyses,
  type ExtractableClaim,
  type HeadingInfo,
  type PageAnalysisRow,
} from '@/services/page-analysis';

/**
 * CT07 — Page extractability.
 *
 * P12 (platform_improvement_plan.md §7.2, R33): this screen moved here from
 * `/content/page-analysis`, which now redirects to this route. It measures a
 * live page, so its natural home is the Website group beside that page's
 * health, search and visitor facts. Nothing was dropped: the capability, the
 * run history and every run's source URL are the same ones the Content screen
 * showed — only the duplicate Content navigation destination was removed.
 *
 * design_plan.md §4.4: *"URL analysis/history, component scores,
 * headings/claims/format, evidence"* — support: *"E live URL only; draft
 * analysis G09."* §5.8 Stage E sharpens that limit: *"Page-analysis currently
 * fetches a URL; it cannot grade an unsaved draft body."* The screen therefore
 * states the boundary once, plainly, instead of letting a reader assume the
 * editor's draft was measured.
 *
 * Two scoring rules are visible in the layout rather than buried in a tooltip:
 *
 *  - **The weights are disclosed and never renormalized** (30 BLUF / 25
 *    question-H2 / 25 format / 20 claims → 0–100). Each component tile says
 *    which weight it contributes.
 *  - **A fetch-failed row has no score at all.** Its stored columns default to
 *    zero, which is why `value` is passed as `null` in that case: a page that
 *    could not be fetched is unmeasured, not a page that scored 0.
 *
 * Analysis is a deliberate action, never a page-load side effect: it fetches a
 * remote URL and writes a history row, so it happens from the dialog and only
 * from the dialog (§10.4's scan row).
 */

const SELECTION_DEFAULTS = { analysis: '' };

export default function PageAnalysisPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [rows, setRows] = useState<PageAnalysisRow[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [selection, setSelection] = useUrlState(SELECTION_DEFAULTS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [useLlm, setUseLlm] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [drawer, setDrawer] = useState<{ title: string; observed: string; raw: string } | null>(null);
  // §10.4 double-submit: a ref guard, since two clicks in one tick share state.
  const submitting = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const result = await listPageAnalyses(projectId, { signal });
        setRows(result);
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

  const selected = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    if (selection.analysis) {
      return rows.find((row) => row.id === selection.analysis) ?? rows[0];
    }
    return rows[0];
  }, [rows, selection.analysis]);

  async function onAnalyze() {
    if (submitting.current) return;
    submitting.current = true;
    setRunning(true);
    setRunError(null);
    try {
      const created = await analyzePage(projectId, {
        url: url.trim(),
        useLlm,
      });
      setDialogOpen(false);
      setUrl('');
      await load();
      if (created?.id) setSelection({ analysis: created.id });
    } catch (caught) {
      setRunError(toApiError(caught));
    } finally {
      submitting.current = false;
      setRunning(false);
    }
  }

  const columns: ReadonlyArray<ColumnDef<PageAnalysisRow>> = [
    {
      key: 'url',
      header: 'URL',
      accessor: (row) => row.url,
      sortable: true,
      width: 320,
      render: (row) => (
        <div className="min-w-0">
          <button
            type="button"
            className="truncate text-left font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setSelection({ analysis: row.id }, { push: true })}
          >
            {row.url}
          </button>
          <p className="text-meta text-muted-foreground">
            {row.title ?? 'No page title found'}
          </p>
        </div>
      ),
    },
    {
      key: 'structureScore',
      header: 'Structure',
      accessor: (row) => (row.status === 'fetch-failed' ? null : row.structureScore),
      sortable: true,
      align: 'right',
      width: 110,
      // A page that could not be fetched has no score — not a score of zero.
      // A `render` replaces the default cell, so the label is explicit here.
      render: (row) =>
        row.status === 'fetch-failed' ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{row.structureScore} / 100</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      sortable: true,
      width: 150,
      render: (row) => (
        <StatusPill
          label={row.status === 'fetch-failed' ? 'Fetch failed' : 'Analysed'}
          tone={row.status === 'fetch-failed' ? 'warning' : 'success'}
        />
      ),
    },
    {
      key: 'wordCount',
      header: 'Words',
      accessor: (row) => (row.status === 'fetch-failed' ? null : row.wordCount),
      sortable: true,
      align: 'right',
      width: 100,
      render: (row) =>
        row.status === 'fetch-failed' ? (
          <span className="text-unmeasured-foreground">{notMeasuredLabel()}</span>
        ) : (
          <span className="tabular-nums">{formatNumber(row.wordCount)}</span>
        ),
    },
    {
      key: 'fetchedAt',
      header: 'Captured',
      accessor: (row) => row.fetchedAt ?? row.createdAt,
      sortable: true,
      width: 190,
      render: (row) => <Timestamp value={row.fetchedAt ?? row.createdAt} />,
    },
  ];

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Page extractability" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const detail = selected ? decodeAnalysisDetail(selected) : null;
  const failed = selected?.status === 'fetch-failed';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Page extractability"
        context="How easily an answer engine can lift a direct answer out of a live page: answer-first opening, question-shaped headings, useful format, and sourceable claims."
        primaryAction={{
          label: 'Analyze a URL',
          onClick: () => {
            setRunError(null);
            setDialogOpen(true);
          },
        }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <Alert>
        <Ruler aria-hidden="true" className="h-4 w-4" />
        <AlertTitle>This measures a live URL</AlertTitle>
        <AlertDescription>
          The analysis fetches the address you give it and scores what comes back. It cannot grade an
          unsaved draft body in the editor — a draft has to be reachable at a URL before it can be
          measured. Every run is stored in this project&rsquo;s history so a restructure stays
          comparable to what came before it.
        </AlertDescription>
      </Alert>

      {runError && !dialogOpen ? (
        <ErrorState
          error={runError}
          layout="inline"
          onRetry={() => setDialogOpen(true)}
          providerName="the page fetch"
          preserveNotice="No analysis was stored for the failed run."
        />
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="page extractability"
          prerequisite="a URL to analyze — any page on the project's site, or a competitor's"
          action={{ label: 'Analyze a URL', onClick: () => setDialogOpen(true) }}
        />
      ) : (
        <>
          {/* ── Component scores for the selected analysis ───────────── */}
          <section className="space-y-3" aria-labelledby="component-scores">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="component-scores" className="text-subsection font-semibold text-foreground">
                Component scores
              </h2>
              <p className="text-meta text-muted-foreground">
                {selected?.url} ·{' '}
                {selected?.fetchedAt ? (
                  <>
                    captured <Timestamp value={selected.fetchedAt} />
                  </>
                ) : (
                  'capture time not recorded'
                )}
              </p>
            </div>

            {failed ? (
              <Alert>
                <AlertTitle>This run fetched nothing</AlertTitle>
                <AlertDescription>
                  The page could not be retrieved, so no component was measured. The stored scores on
                  this row are empty, not zero — there is no measurement to read.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <MetricTile
                label="Structure score"
                value={failed || !selected ? null : selected.structureScore}
                unit="/ 100"
                provenance="measured"
                note={
                  failed
                    ? 'No measurement: the fetch failed.'
                    : 'The four components below, added — the weights are never renormalized.'
                }
                evidenceHref={selected ? selected.url : undefined}
              />
              <MetricTile
                label="Answer-first opening (BLUF)"
                value={failed || !selected ? null : selected.blufScore}
                unit={`/ ${STRUCTURE_WEIGHTS.bluf}`}
                provenance="measured"
                note={`Weight ${STRUCTURE_WEIGHTS.bluf} of 100. Best when the answer arrives in the first 40–60 words.`}
              />
              <MetricTile
                label="Question-shaped headings"
                value={failed || !selected ? null : selected.questionH2Score}
                unit={`/ ${STRUCTURE_WEIGHTS.questionH2}`}
                provenance="measured"
                note={`Weight ${STRUCTURE_WEIGHTS.questionH2} of 100. Share of H2s that read as a question.`}
              />
              <MetricTile
                label="Format"
                value={failed || !selected ? null : selected.formatScore}
                unit={`/ ${STRUCTURE_WEIGHTS.format}`}
                provenance="measured"
                note={`Weight ${STRUCTURE_WEIGHTS.format} of 100. Tables, numbered steps, definition blocks.`}
              />
              <MetricTile
                label="Extractable claims"
                value={failed || !selected ? null : selected.claimsScore}
                unit={`/ ${STRUCTURE_WEIGHTS.claims}`}
                provenance="measured"
                note={`Weight ${STRUCTURE_WEIGHTS.claims} of 100. Numbers that carry a timeframe or a source.`}
              />
            </div>
          </section>

          {/* ── Detail ───────────────────────────────────────────────── */}
          {selected && detail && !failed ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">Headings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-2">
                  <p className="text-meta text-muted-foreground">
                    A heading is standalone when its section could be lifted out of the page and
                    still make sense on its own. That is the shape an answer engine can quote.
                  </p>
                  {detail.headings.length === 0 ? (
                    <p className="text-table text-muted-foreground">
                      No H2 heading was found on this page.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {detail.headings.map((heading) => (
                        <li key={heading.text} className="flex items-start justify-between gap-3 py-2">
                          <div className="min-w-0 text-table">
                            <p className="text-foreground">{heading.text}</p>
                            <p className="text-meta text-muted-foreground">
                              H{heading.level}
                              {heading.questionShaped ? ' · question-shaped' : ''}
                              {heading.standalone
                                ? ' · standalone'
                                : ` · not standalone${heading.standaloneReason ? `: ${heading.standaloneReason}` : ''}`}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDrawer({
                                title: `Heading: ${heading.text}`,
                                observed: describeHeading(heading),
                                raw: heading.text,
                              })
                            }
                          >
                            Evidence
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-subsection">Extractable claims</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-2">
                  <p className="text-meta text-muted-foreground">
                    Statements containing a number. A number without a timeframe or a source is a
                    figure a reader — and an answer engine — cannot check.
                  </p>
                  {detail.claims.length === 0 ? (
                    <p className="text-table text-muted-foreground">
                      No numeric statement was found on this page.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {detail.claims.map((claim, index) => (
                        <li key={index} className="flex items-start justify-between gap-3 py-2">
                          <div className="min-w-0 text-table">
                            <p className="text-foreground">{claim.text}</p>
                            <p className="text-meta text-muted-foreground">
                              {claimFlag(claim)}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDrawer({
                                title: 'Extractable claim',
                                observed: claimFlag(claim),
                                raw: claim.text,
                              })
                            }
                          >
                            Evidence
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <dl className="grid grid-cols-3 gap-x-4 gap-y-1 border-t border-border pt-3 text-table">
                    <div>
                      <dt className="text-meta text-muted-foreground">Tables</dt>
                      <dd className="tabular-nums">{detail.format.tables}</dd>
                    </div>
                    <div>
                      <dt className="text-meta text-muted-foreground">Numbered steps</dt>
                      <dd className="tabular-nums">{detail.format.orderedLists}</dd>
                    </div>
                    <div>
                      <dt className="text-meta text-muted-foreground">Definition blocks</dt>
                      <dd className="tabular-nums">{detail.format.definitionBlocks}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-subsection">Opening paragraph and model notes</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <h3 className="text-table font-medium text-foreground">
                      First paragraph (the fact)
                    </h3>
                    {selected.blufText ? (
                      <pre className="evidence rounded-md border border-border bg-surface-sunken p-3">
                        {selected.blufText}
                      </pre>
                    ) : (
                      <p className="text-table text-muted-foreground">
                        No opening paragraph was captured.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-table font-medium text-foreground">Model notes</h3>
                      {selected.llmNotes ? (
                        <ProvenanceBadge kind="model-interpretation" />
                      ) : null}
                    </div>
                    {selected.llmNotes ? (
                      <pre className="evidence rounded-md border border-info/30 bg-info-subtle p-3">
                        {selected.llmNotes}
                      </pre>
                    ) : (
                      <p className="text-table text-muted-foreground">
                        No model pass was requested for this run — {' '}
                        the score above is entirely deterministic and is never adjusted by a model.
                      </p>
                    )}
                  </div>

                  <dl className="grid gap-1 border-t border-border pt-3 text-table sm:grid-cols-3">
                    <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                      <dt className="text-muted-foreground">Title found</dt>
                      <dd className="text-foreground">{selected.title ?? notMeasuredLabel()}</dd>
                    </div>
                    <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                      <dt className="text-muted-foreground">Word count</dt>
                      <dd className="tabular-nums">{formatNumber(selected.wordCount)}</dd>
                    </div>
                    <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                      <dt className="text-muted-foreground">Captured</dt>
                      <dd className="text-foreground">
                        {selected.fetchedAt ? (
                          <Timestamp value={selected.fetchedAt} />
                        ) : (
                          notMeasuredLabel()
                        )}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {/* ── History ──────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Analysis history</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <DataTable
                caption="Page analyses"
                columns={columns}
                rows={rows}
                getRowId={(row) => row.id}
                defaultSort={{ key: 'fetchedAt', direction: 'desc' }}
                minTableWidth="62rem"
                rowDetail={(row) =>
                  row.status === 'fetch-failed' ? (
                    <p className="text-table text-muted-foreground">
                      This run stored no analysis: the page could not be fetched.
                    </p>
                  ) : (
                    <div className="space-y-1 text-table text-muted-foreground">
                      <p>
                        {row.blufScore}/{STRUCTURE_WEIGHTS.bluf} opening · {row.questionH2Score}/
                        {STRUCTURE_WEIGHTS.questionH2} headings · {row.formatScore}/
                        {STRUCTURE_WEIGHTS.format} format · {row.claimsScore}/
                        {STRUCTURE_WEIGHTS.claims} claims
                      </p>
                      <p>
                        Comparing two runs is only meaningful when the page was substantially the
                        same in both — this build does not score that comparability for you.
                      </p>
                    </div>
                  )
                }
                emptyState={
                  <EmptyState
                    variant="not-measured"
                    subject="page analyses"
                    prerequisite="a URL to analyze"
                    action={{ label: 'Analyze a URL', onClick: () => setDialogOpen(true) }}
                  />
                }
              />
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Analyze a page</DialogTitle>
            <DialogDescription>
              Fetches the URL and stores a scored analysis in this project&rsquo;s history. This is a
              real request against a live page, and the route is rate limited.
            </DialogDescription>
          </DialogHeader>

          {runError ? (
            <ErrorState
              error={runError}
              layout="inline"
              notFoundReason="missing"
              providerName="the page fetch"
              preserveNotice="Nothing was stored for the failed run."
            />
          ) : null}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="analyze-url">Page URL</Label>
              <Input
                id="analyze-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/guides/ai-visibility"
                aria-describedby="analyze-url-help"
              />
              <p id="analyze-url-help" className="text-meta text-muted-foreground">
                Must be an absolute http(s) address.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface-sunken p-3">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="use-llm">Add model notes</Label>
                <p className="text-meta text-muted-foreground">
                  A separate reading of the page, stored as notes and shown with a model badge.
                  Notes are never scored — the structure score stays deterministic. Needs a
                  configured Anthropic key, and answers with a 503 naming the provider when there is
                  none.
                </p>
              </div>
              <Switch
                id="use-llm"
                checked={useLlm}
                onCheckedChange={setUseLlm}
                disabled={running}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button
              onClick={() => void onAnalyze()}
              disabled={running || url.trim().length < 9}
              aria-busy={running}
            >
              {running ? 'Analyzing…' : 'Analyze page'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EvidenceDrawer
        open={drawer !== null}
        onOpenChange={(open) => {
          if (!open) setDrawer(null);
        }}
        title={drawer?.title ?? 'Evidence'}
        source={{
          name: 'Page analysis',
          capturedAt: selected?.fetchedAt ?? selected?.createdAt ?? new Date().toISOString(),
          url: selected?.url,
        }}
        observed={drawer?.observed ?? ''}
        interpretation={
          selected?.llmNotes
            ? 'A model note accompanies this run; it is shown above and is not part of the score.'
            : undefined
        }
        raw={{ label: 'Text as captured', text: drawer?.raw ?? '' }}
        confidence={{ level: 'high', basis: 'Read directly from the fetched page body.' }}
        provenance="measured"
      />
    </div>
  );
}

function describeHeading(heading: HeadingInfo): string {
  const parts = [`H${heading.level} heading`];
  parts.push(heading.questionShaped ? 'reads as a question' : 'not question-shaped');
  parts.push(
    heading.standalone
      ? 'stands alone out of context'
      : `not standalone${heading.standaloneReason ? `: ${heading.standaloneReason}` : ''}`,
  );
  return parts.join(' · ');
}

function claimFlag(claim: ExtractableClaim): string {
  const flags: string[] = [];
  flags.push(claim.hasTimeframe ? 'has a timeframe' : 'no timeframe');
  flags.push(claim.hasSource ? 'cites a source' : 'no source');
  return `Number present · ${flags.join(' · ')}`;
}

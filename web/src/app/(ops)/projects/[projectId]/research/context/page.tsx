'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import type { ApiError } from '@/lib/api';
import { getProjectDetail, type ProjectDetailWire } from '@/services/projects';
import { buildSiteContext, getSiteContext, type SiteContext } from '@/services/research';

/**
 * AE05 — Site context.
 *
 * design_plan.md §4.3: *"Extracted services/ICP/pains/outcomes/markets, fetched
 * source pages, rebuild"*, and §5.6 step 2: *"Inspect context sources (AE05),
 * rebuild if stale, and flag facts needing human correction. Approved context
 * editing requires G04."*
 *
 * Three consequences of that row:
 *
 *  1. **Every extracted fact is shown against the source it came from.** The
 *     pages the crawler actually read are listed with their count, because a
 *     list of "services" with no visible provenance is an assertion, not
 *     evidence. The extraction method is badged: a deterministic pass and an
 *     LLM-synthesised one are different claims about the same text.
 *  2. **Rebuilding is explicit and scoped.** It is a crawler run plus, when a
 *     model key is configured, one LLM pass — behind a confirmation that states
 *     both.
 *  3. **Corrections are not offered, because there is no endpoint for them.**
 *     The plan puts approved context editing in G04; until it exists this screen
 *     says so rather than showing inputs that would silently discard an edit.
 */

const DEFAULT_MAX_PAGES = 12;
const MAX_PAGES_CEILING = 30;

export default function SiteContextPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<ProjectDetailWire | null>(null);
  const [context, setContext] = useState<SiteContext | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [maxPages, setMaxPages] = useState(DEFAULT_MAX_PAGES);
  const [refine, setRefine] = useState(true);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [projectResult, contextResult] = await Promise.all([
          getProjectDetail(projectId, { signal }),
          getSiteContext(projectId, { signal }),
        ]);
        setProject(projectResult);
        setContext(contextResult);
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
        <PageHeader title="Site context" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{
          projectName: project.name,
          domain: context?.domain ?? project.domain,
          market: context?.geo ?? undefined,
          mode: 'live',
        }}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}/research/ai`}>Back to AI visibility</Link>
          </Button>
        }
      />

      <PageHeader
        title="Site context"
        context={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-mono text-meta">{context?.domain ?? project.domain}</span>
            {context ? (
              <span>
                Built <Timestamp value={context.createdAt} />
              </span>
            ) : (
              <span className="text-muted-foreground">Never built</span>
            )}
          </span>
        }
        status={
          context ? (
            <StatusPill
              label={
                context.extraction === 'llm-synthesized'
                  ? 'LLM-synthesised extraction'
                  : 'Deterministic extraction'
              }
              tone={context.extraction === 'llm-synthesized' ? 'info' : 'neutral'}
            />
          ) : (
            <StatusPill label="Not measured" tone="unmeasured" />
          )
        }
        primaryAction={{ label: 'Rebuild context', onClick: () => setRebuildOpen(true) }}
        secondaryActions={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
      />

      {actionError ? <ErrorState error={actionError} layout="inline" /> : null}
      {rebuildResult ? (
        <p role="status" className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-table text-info-foreground">
          {rebuildResult}
        </p>
      ) : null}

      {!context ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              variant="not-measured"
              subject="the site context"
              prerequisite="a context build has to run against the project's own site before a prompt matrix can be generated"
              action={{ label: 'Build the context', onClick: () => setRebuildOpen(true) }}
            >
              <p className="text-table text-muted-foreground">
                Building crawls {project.domain} and reads what the site says about itself. Nothing else on
                the AI visibility screens can run without it.
              </p>
            </EmptyState>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-subsection">
                What the site is understood to be
                <ProvenanceBadge
                  kind={context.extraction === 'llm-synthesized' ? 'model-interpretation' : 'derived'}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 pt-2">
              <dl className="grid gap-3 sm:grid-cols-2">
                <Field label="Brand" value={context.brand} />
                <Field label="Domain" value={context.domain} mono />
                <Field label="Category" value={context.category} />
                <Field label="Sells into" value={context.vertical} />
                <Field label="Primary market" value={context.geo} />
                <Field
                  label="Markets named by the site"
                  value={context.markets.length > 0 ? context.markets.join(', ') : null}
                  emptyLabel="None extracted"
                />
              </dl>

              {context.description ? (
                // Fetched page text, rendered as escaped text (§10.5).
                <div>
                  <h3 className="text-meta font-semibold text-foreground">Description</h3>
                  <p className="mt-1 whitespace-pre-wrap text-table text-foreground">{context.description}</p>
                </div>
              ) : null}

              <div className="grid gap-5 lg:grid-cols-2">
                <ExtractedList label="Services sold" items={context.services} />
                <ExtractedList label="Who buys (ICP)" items={context.icp} />
                <ExtractedList label="Value propositions" items={context.valueProps} />
                <ExtractedList label="Problems buyers arrive with" items={context.painPoints} />
                <ExtractedList label="Outcomes they want" items={context.outcomes} />
                <div>
                  <h3 className="text-meta font-semibold text-foreground">
                    Competitors the site names ({formatNumber(context.competitors.length)})
                  </h3>
                  {context.competitors.length === 0 ? (
                    <p className="mt-1 text-table text-muted-foreground">
                      The site named no competitor. The benchmark set is maintained separately — compare
                      against the tracked competitors rather than assuming there are none.
                    </p>
                  ) : (
                    <ul className="mt-1 divide-y divide-border">
                      {context.competitors.map((competitor) => (
                        <li
                          key={`${competitor.name}-${competitor.domain ?? ''}`}
                          className="flex items-center justify-between gap-4 py-1.5 text-table"
                        >
                          <span>{competitor.name}</span>
                          <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
                            {competitor.domain ?? 'No domain recorded'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">
                Source pages the crawler read ({formatNumber(context.pageUrls.length)})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {context.pageUrls.length === 0 ? (
                <p className="text-table text-muted-foreground">
                  The build recorded no page URLs, so there is nothing to show the extraction came from.
                  Rebuilding is the only way to obtain them.
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {context.pageUrls.map((url) => (
                      <li key={url} className="py-1.5">
                        {/* Fetched markup never becomes a link target here
                            unless it is a plain http(s) URL (§10.5). */}
                        {/^https?:\/\//i.test(url) ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-meta text-primary underline-offset-4 hover:underline"
                          >
                            {url}
                          </a>
                        ) : (
                          <span className="font-mono text-meta text-foreground">{url}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-meta text-muted-foreground">
                    Every line above was derived from the text on these pages. A fact with no page behind it
                    would be an assertion, so the page list is part of the evidence rather than an appendix.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">How this was produced</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <dl className="grid gap-2 text-table sm:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Extraction</dt>
                  <dd className="font-medium">
                    {context.extraction === 'llm-synthesized'
                      ? 'One constrained model pass over the fetched text'
                      : 'Deterministic extraction from the fetched text'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="font-mono">
                    {context.llmModel ?? 'No model used'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Pages fetched</dt>
                  <dd className="tabular-nums">{formatNumber(context.pagesFetched)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Model cost</dt>
                  <dd className="tabular-nums">
                    {context.costUsd === 0
                      ? 'No metered cost recorded'
                      : `${formatNumber(context.costUsd)} (provider charge, USD)`}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-meta text-muted-foreground">
                {context.extraction === 'llm-synthesized'
                  ? 'The model organised text the crawler had already fetched. It did not browse the site itself, and the page list above is what it was given.'
                  : 'Without a model key the deterministic extraction stands, and every line above is a direct reading of the fetched text.'}
              </p>
            </CardContent>
          </Card>

          {/*
            §5.6 step 2 asks for corrections to be flagged. There is no write
            endpoint for context, so the affordance is withheld and the gap is
            named — an editable-looking field that discards the edit is worse
            than no field.
          */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Correcting a fact</CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              <p className="text-table text-muted-foreground">
                This context cannot be edited in Cailyx yet. There is no endpoint that accepts a corrected
                service, ICP, pain point or market, and no approval step binding a correction to the context
                version it was made against — that is design_plan G04. Until it exists, the only lever on
                this page is <span className="font-mono">Rebuild</span>, which replaces the extraction
                wholesale. Treat every line above as what the crawler read, not as an approved fact.
              </p>
            </CardContent>
          </Card>

          <p className="text-meta text-muted-foreground">
            A prompt matrix interpolates these values, so a prompt can never name a service the site does
            not sell. Existing audits keep the context they were generated from — rebuilding changes what a
            new matrix would be built from, not any stored result.
          </p>
        </>
      )}

      <ConfirmDialog
        open={rebuildOpen}
        onOpenChange={setRebuildOpen}
        title={context ? 'Rebuild the site context' : 'Build the site context'}
        confirmLabel={context ? 'Rebuild context' : 'Build context'}
        targetLabel="Project"
        target={project.domain}
        effect={
          <p>
            Cailyx fetches {project.domain} and up to {formatNumber(maxPages)} sitemap-guided pages, then
            {refine
              ? ' runs one constrained model pass over the fetched text to organise services, ICP, pains and outcomes.'
              : ' extracts deterministically from the fetched text, with no model pass.'}
          </p>
        }
        scope={
          <p>
            {context
              ? 'The stored context is replaced by the new one. Audits already run keep the context they were generated from; a new matrix would be built from this result.'
              : 'This stores the first context for the project. It does not run any measurement.'}
          </p>
        }
        onConfirm={async () => {
          setActionError(null);
          setRebuildResult(null);
          const result = await buildSiteContext(projectId, { maxPages, refine });
          await load();
          setRebuildResult(
            `Context rebuilt from ${formatNumber(
              typeof result.pagesFetched === 'number' ? result.pagesFetched : maxPages,
            )} page(s), extraction "${String(result.extraction ?? 'unknown')}".`,
          );
        }}
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="maxPages">Page ceiling</Label>
            <Input
              id="maxPages"
              type="number"
              min={1}
              max={MAX_PAGES_CEILING}
              value={maxPages}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMaxPages(Number.isFinite(next) ? next : DEFAULT_MAX_PAGES);
              }}
            />
            <p className="text-meta text-muted-foreground">
              1–{MAX_PAGES_CEILING}. The homepage is always read; the rest are chosen from the site&rsquo;s
              sitemap.
            </p>
          </div>
          <p className="text-meta text-muted-foreground">
            No pre-flight cost estimate is available for a context build: the endpoint records what the
            model pass actually cost rather than quoting it beforehand. The recorded cost appears on this
            page after the build.
          </p>
          <div className="flex items-start gap-2">
            <Checkbox
              id="refine"
              checked={refine}
              onCheckedChange={(next) => setRefine(next === true)}
            />
            <Label htmlFor="refine" className="text-table font-normal">
              Run the model synthesis pass
              <span className="block text-meta text-muted-foreground">
                Ignored when no model key is configured on the server; the deterministic extraction then
                stands and the result says so.
              </span>
            </Label>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** One extracted/scalar fact. Absent values say so rather than rendering blank. */
function Field({
  label,
  value,
  mono = false,
  emptyLabel,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  emptyLabel?: string;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-table text-foreground' : 'text-table text-foreground'}>
        {value ?? (emptyLabel ?? notMeasuredLabel())}
      </dd>
    </div>
  );
}

/** A list of extracted strings, with the empty case stated rather than blank. */
function ExtractedList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-meta font-semibold text-foreground">
        {label} ({formatNumber(items.length)})
      </h3>
      {items.length === 0 ? (
        <p className="mt-1 text-table text-muted-foreground">
          Nothing was extracted for this. That is what the pages said, not an empty result to be re-run
          blindly.
        </p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-table text-foreground">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

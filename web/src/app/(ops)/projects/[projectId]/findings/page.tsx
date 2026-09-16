'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { RunConfigurator, type ConfiguratorPrerequisite } from '@/components/patterns/RunConfigurator';
import { ScopeBanner } from '@/components/patterns/ScopeBanner';
import { Timestamp } from '@/components/patterns/Timestamp';
import { ApiError } from '@/lib/api';
import { GAP_ACTION_LABEL, listGaps, type Gap } from '@/services/planning';
import {
  FINDINGS_LIMIT_DEFAULT,
  FINDINGS_LIMIT_MAX,
  FINDINGS_LIMIT_MIN,
  generateFindings,
  listFindings,
  type Finding,
} from '@/services/findings';
import { getProject } from '@/services/projects';

/**
 * RP06 — Findings library.
 *
 * design_plan.md §4.4: *"Generate from top open gaps; executive/technical
 * what/why/fix; thin-run disclosures."*
 *
 * The disclosure is the point of this screen, not a footnote on it. §4.4 and
 * the backend's own contract say a findings run generated from thin evidence
 * must be labelled as one, so:
 *
 *  - the backend's `thinRun` flag is rendered as a warning band above the
 *    findings, in the backend's own terms (fewer than three credible findings);
 *  - each finding that was generated thin carries its own `disclosedGap` — the
 *    sentence saying which evidence is missing — rendered with the finding
 *    rather than buried in the list;
 *  - the panel that says what generation will draw from is shown **before**
 *    generation, so the thin-ness is predictable rather than a surprise.
 *
 * §6.4's finding contract names eight things a finding should explain:
 * observation, source/time, importance, recommendation, expected mechanism,
 * confidence, owner and verification. The stored row carries the first four and
 * the source link. The last three are not recorded by the generate route, and
 * this page names them as missing rather than implying them.
 */
export default function FindingsLibraryPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<{ name: string; domain: string } | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [thinRun, setThinRun] = useState(false);
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [limit, setLimit] = useState(FINDINGS_LIMIT_DEFAULT);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [detail, findingsResult, gapResult] = await Promise.all([
          getProject(projectId, { signal }),
          listFindings(projectId, { signal }),
          listGaps(projectId, undefined, { signal }),
        ]);
        setProject({ name: detail.name, domain: detail.domain });
        setFindings(findingsResult.findings);
        setThinRun(findingsResult.thinRun);
        setGaps(gapResult.gaps);
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

  /**
   * The open gaps generation ranks over — the same order the backend uses
   * (`priorityScore` descending, unprioritised last). A gap with no priority
   * score is not a low-priority gap; it is one nobody has scored, and it sorts
   * below every scored gap accordingly.
   */
  const openGaps = useMemo(
    () => (gaps ?? []).filter((gap) => gap.status === 'open'),
    [gaps],
  );

  /** Only issues and gaps are actionable; a strength is not a finding to fix. */
  const actionableGaps = useMemo(
    () => openGaps.filter((gap) => gap.category === 'issue' || gap.category === 'gap'),
    [openGaps],
  );

  const hasGapAnalysis = (gaps ?? []).length > 0;

  const prerequisites = useMemo<ConfiguratorPrerequisite[]>(
    () => [
      {
        label: 'A gap analysis for this project',
        met: hasGapAnalysis,
        detail: hasGapAnalysis
          ? `${gaps?.length ?? 0} classified gap(s), of which ${openGaps.length} are open and ${
              actionableGaps.length
            } are action-able (issue or gap).`
          : 'Findings are generated from the project’s classified gaps. There are none — run the audit modules and sync gaps first.',
      },
      {
        label: 'An LLM provider configured on the server',
        met: true,
        // The server answers 503 when this is unset, and the screen cannot read
        // the server's environment. It is stated as an advisory precondition
        // rather than a checked one, because claiming to have verified it would
        // be a guess.
        blocking: false,
        detail:
          'Copy is written by a constrained model. If no provider key is configured the request is refused with a 503 and nothing is stored.',
      },
    ],
    [hasGapAnalysis, gaps, openGaps, actionableGaps],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Findings" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!project || !findings || !gaps) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const thinFindings = findings.filter((finding) => finding.thinRun);

  return (
    <div className="space-y-6">
      <ScopeBanner
        scope={{ projectName: project.name, domain: project.domain, mode: 'live' }}
      />

      <PageHeader
        breadcrumbs={[
          { label: 'Projects', href: '/ops/projects' },
          { label: project.name, href: `/projects/${projectId}` },
          { label: 'Findings' },
        ]}
        title="Findings"
        context={
          <span className="text-meta text-muted-foreground">
            What/why/fix copy written from this project&apos;s own classified gaps.
            Every finding is a model interpretation of a stored observation, never a
            measurement in its own right.
          </span>
        }
        status={
          thinRun && findings.length > 0 ? (
            <span className="text-meta font-medium text-warning">
              Thin run — fewer than three credible findings
            </span>
          ) : undefined
        }
      />

      {/* ── The disclosure, above the findings it qualifies ────────────── */}
      {findings.length > 0 && thinRun ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
          <AlertTitle>This is a thin run, not a full picture</AlertTitle>
          <AlertDescription>
            Fewer than three credible findings could be generated from the evidence
            this project holds, so the backend flagged the whole run as thin. The
            findings below are real, but they are a fraction of what a complete
            evidence set would support — do not read the gaps they leave out as
            things that are fine.
            {thinFindings.length > 0 ? (
              <>
                {' '}
                {thinFindings.length} of them name the specific evidence that was
                missing.
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {findings.length === 0 ? (
        <EmptyState
          variant="not-measured"
          subject="findings copy"
          prerequisite={
            hasGapAnalysis
              ? 'No findings have been generated for this project yet. Generation reads the open gaps listed below and writes one finding per gap it can support.'
              : 'Findings are generated from a project’s classified gaps, and this project has no gap analysis yet. Run the audits, then sync gaps.'
          }
          action={{
            label: 'Priority inputs (gaps)',
            href: `/projects/${projectId}/priorities`,
          }}
        />
      ) : (
        <Tabs defaultValue="executive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="executive">Executive</TabsTrigger>
              <TabsTrigger value="technical">Technical</TabsTrigger>
            </TabsList>
            <p className="text-meta text-muted-foreground">
              Both registers are written from the same observation. Neither is a
              measurement.
            </p>
          </div>

          <TabsContent value="executive" className="mt-4 space-y-3">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                projectId={projectId}
                register="executive"
              />
            ))}
          </TabsContent>
          <TabsContent value="technical" className="mt-4 space-y-3">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                projectId={projectId}
                register="technical"
              />
            ))}
          </TabsContent>
        </Tabs>
      )}

      {/* ── What generation draws from, before it runs ─────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">
            Top open gaps generation will draw from
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!hasGapAnalysis ? (
            <EmptyState
              variant="not-measured"
              subject="a gap analysis"
              prerequisite="No gaps have been classified for this project, so there is nothing for findings copy to be written from."
              action={{ label: 'Open priorities', href: `/projects/${projectId}/priorities` }}
            />
          ) : (
            <>
              <p className="text-table text-muted-foreground">
                Ranked by priority score, descending — the project&apos;s own
                prioritisation, not a ranking this screen invented. A gap with no
                priority score is unscored and sorts below every scored gap; it is
                not a low-priority gap.
              </p>
              <ul className="divide-y divide-border">
                {actionableGaps.slice(0, 5).map((gap) => (
                  <li key={gap.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="text-table">{gap.title}</span>
                    <span className="text-meta text-muted-foreground">
                      {gap.dimension}
                      {' · '}
                      {GAP_ACTION_LABEL[gap.action as keyof typeof GAP_ACTION_LABEL] ?? gap.action}
                      {gap.severity ? ` · severity ${gap.severity}` : ''}
                      {gap.priorityScore !== null
                        ? ` · priority ${gap.priorityScore}`
                        : ' · not prioritised yet'}
                    </span>
                    <Link
                      href={`/projects/${projectId}/priorities/${gap.id}`}
                      className="text-meta text-primary underline-offset-4 hover:underline"
                    >
                      Open gap
                    </Link>
                  </li>
                ))}
              </ul>
              {actionableGaps.length > 5 ? (
                <p className="text-meta text-muted-foreground">
                  Showing the top 5 of {actionableGaps.length} action-able open
                  gaps. Generation takes its own top-ranked set, capped at{' '}
                  {limit}.
                </p>
              ) : null}

              <div className="space-y-1.5 border-t border-border pt-4">
                <Label htmlFor="findings-limit">Findings to attempt</Label>
                <Input
                  id="findings-limit"
                  name="limit"
                  type="number"
                  inputMode="numeric"
                  min={FINDINGS_LIMIT_MIN}
                  max={FINDINGS_LIMIT_MAX}
                  value={limit}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    // The server clamps to 1–10; clamping here keeps the field
                    // and the request in agreement instead of silently
                    // disagreeing about what was asked for.
                    setLimit(
                      Number.isFinite(parsed)
                        ? Math.min(Math.max(parsed, FINDINGS_LIMIT_MIN), FINDINGS_LIMIT_MAX)
                        : FINDINGS_LIMIT_DEFAULT,
                    );
                  }}
                  className="max-w-24"
                  aria-describedby="findings-limit-help"
                />
                <p id="findings-limit-help" className="text-meta text-muted-foreground">
                  Between {FINDINGS_LIMIT_MIN} and {FINDINGS_LIMIT_MAX}. Generation
                  attempts one finding per top-ranked open gap and skips any whose
                  copy fails the claims check, so a request for {limit} may
                  legitimately return fewer — that shortfall is reported, not
                  retried.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <RunConfigurator
        startLabel="Generate findings"
        prerequisites={prerequisites}
        parameters={[
          {
            key: 'limit',
            label: 'Findings to attempt',
            value: `${limit} (server clamps to 1–10)`,
          },
          {
            key: 'basis',
            label: 'Ranked over',
            value: `${actionableGaps.length} action-able open gap(s)`,
          },
        ]}
        scope={
          <>
            One new batch of findings for{' '}
            <span className="font-medium">{project.name}</span>, written from the
            project&apos;s own top-ranked open gaps. Re-generating creates a fresh
            batch rather than replacing the existing one.
          </>
        }
        // No estimate: the model call is not metered in requests or credits that
        // this build can read, and a fabricated number would be un-reconcilable.
        configuration={[
          {
            label: 'Gap analysis',
            availability: hasGapAnalysis ? 'available' : 'unavailable',
            detail: hasGapAnalysis
              ? `${gaps.length} classified gap(s) stored.`
              : 'No gaps have been classified yet.',
            actionLabel: hasGapAnalysis ? undefined : 'Open priorities',
            actionHref: hasGapAnalysis ? undefined : `/projects/${projectId}/priorities`,
          },
          {
            label: 'Findings copy provider',
            availability: 'unverified',
            detail:
              'The screen cannot read the server’s provider configuration. A 503 on start means none is configured and nothing was stored.',
          },
        ]}
        onStart={async () => {
          setStartError(null);
          await generateFindings(projectId, { limit });
        }}
        onStarted={() => {
          // Re-read the stored rows rather than rendering the mutation's echo:
          // what is on screen should be what the project holds.
          void load();
        }}
        // Copy generation calls an LLM once per gap, sequentially, with a
        // regeneration on a claims-discipline failure — so it can legitimately
        // exceed a minute. A lost response here is reported as unknown rather
        // than retried.
        startTimeoutMs={120_000}
        error={startError}
        // Generation is synchronous: the request returns the stored batch.
        runInFlight={false}
      />
    </div>
  );
}

/**
 * One finding.
 *
 * The observation is the gap the copy was written from, and it is rendered with
 * its own provenance (`measured`) and a link back to the gap row, so the
 * interpretation can never be read without the thing it interprets. The gap is
 * fetched by id on the gap screen rather than embedded here — §5.6 is explicit
 * that gap prose must be resolved from its own row rather than cached in a
 * second place.
 */
function FindingCard({
  finding,
  projectId,
  register,
}: {
  finding: Finding;
  projectId: string;
  register: 'executive' | 'technical';
}) {
  const what = register === 'executive' ? finding.whatExecutive : finding.whatTechnical;
  const why = register === 'executive' ? finding.whyExecutive : finding.whyTechnical;
  const fix = register === 'executive' ? finding.fixExecutive : finding.fixTechnical;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="text-subsection">{finding.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* The copy is a model's reading of a stored observation. */}
            <ProvenanceBadge kind="model-interpretation" />
            {finding.thinRun ? (
              <ProvenanceBadge kind="unmeasured" label="Generated from thin evidence" />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
          <span>
            Written <Timestamp value={finding.createdAt} />
          </span>
          {finding.gapId ? (
            <Link
              href={`/projects/${projectId}/priorities/${finding.gapId}`}
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              Source gap
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </Link>
          ) : (
            <span>
              No source gap recorded — this copy is not traceable to a stored
              observation.
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {finding.thinRun ? (
          <Alert>
            <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
            <AlertTitle>Generated from thin evidence</AlertTitle>
            <AlertDescription>
              {finding.disclosedGap ??
                'The generation run recorded that evidence was thin, but it did not say which evidence was missing.'}
            </AlertDescription>
          </Alert>
        ) : null}

        <Section title="What was observed" text={what} />
        <Section title="Why it matters" text={why} />
        <Section title="What to do" text={fix} />

        <Separator />
        <p className="text-meta text-muted-foreground">
          A finding is expected to state its observation, source and time, the
          importance, the recommendation and the expected mechanism, plus a
          confidence, an owner and how it will be verified. This stored finding
          records the first five. Confidence, owner and verification are not
          captured by the generate route, so they are absent here rather than
          guessed — a reviewed, editable finding (G10) is what would add them.
        </p>
      </CardContent>
    </Card>
  );
}

function Section({ title, text }: { title: string; text: string | null }) {
  return (
    <div>
      <div className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {text && text.trim().length > 0 ? (
        // Model-authored prose. Rendered as text, never as markup (§10.5).
        <p className="mt-1 whitespace-pre-wrap text-body leading-relaxed">{text}</p>
      ) : (
        <p className="mt-1 text-table text-unmeasured">Not stated in this register.</p>
      )}
    </div>
  );
}

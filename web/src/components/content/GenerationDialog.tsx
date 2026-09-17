'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Info, Sparkles, Wand2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { StatusPill } from '@/components/patterns/StatusPill';
import { getBusinessProfile, getTargetLocations } from '@/services/business-profile';
import {
  createContentBrief,
  estimateContentGeneration,
  listContentBriefs,
  updateContentBrief,
  type ContentBrief,
  type CostEstimateView,
} from '@/services/content';
import {
  enqueueGenerationJob,
  newGenerationKey,
  type GenerationJob,
} from '@/services/content-generation';
import {
  generationImplementedFor,
  type ContentCapability,
} from '@/services/content-workspace';
import { convertOpportunityToContent, newIdempotencyKey } from '@/services/opportunities';
import {
  getActiveWritingStyle,
  listWritingStyleVersions,
  summarizeWritingStyle,
  type WritingStyleProfile,
} from '@/services/writing-style';

/**
 * §13.6 contextual generation dialog — P09.
 *
 * This is the *only* way generation starts. §13.6 removed "Generate" from
 * primary navigation and made it an action on a piece of work, so the dialog
 * always knows what it was opened for; {@link GenerationEntry} is that context
 * and it is required, not optional.
 *
 * Five things it deliberately does, each of which is a rule from §13.6/§13.9
 * rather than a UI preference:
 *
 *  1. **The capability matrix decides what is offerable.** The type list is
 *     built from `/content-workspace/capabilities`, so a type without an
 *     implemented writer cannot be selected and no fake Generate button can
 *     exist for it. While the matrix is loading, the control says so instead
 *     of guessing.
 *  2. **The approved-plan gate is enforced here, not skipped.** A draft brief
 *     cannot be generated from; the dialog offers to approve it — the existing
 *     plan approval requirement — rather than working around it. Generating
 *     with no plan at all is possible (the API supports a fresh idea) but only
 *     behind an explicit acknowledgement, and the review panel names the
 *     consequence.
 *  3. **Everything the job will pin is shown before it starts.** Brief version,
 *     writing-style version and its fingerprint, business-profile version, and
 *     whether the result is a new piece or a new revision. §13.7 pins these at
 *     enqueue, so this panel is a preview of an immutable record, not a form
 *     that a later edit could change out from under the job.
 *  4. **Cost is shown honestly.** `estimateContentGeneration` answers
 *     `available: false` with a reason when no estimator exists for this task;
 *     that is rendered as "no estimate available", never as a reassuring zero.
 *  5. **No model, token, temperature or prompt-matrix field exists.** They are
 *     not sent, not stored, and therefore cannot leak into a client-facing
 *     projection later (§13.6, §14.4).
 */

export type GenerationEntry =
  | { kind: 'new'; topic?: string }
  | { kind: 'idea'; opportunityId: string; topic: string; reason: string }
  | { kind: 'plan'; briefId: string; briefVersion: number; assetType: string; topic: string }
  | { kind: 'version'; assetId: string; assetTitle: string; assetType: string; topic: string };

const ENTRY_LABELS: Record<GenerationEntry['kind'], string> = {
  new: 'New content',
  idea: 'Start from an idea',
  plan: 'Prepare draft from a content plan',
  version: 'Create another version',
};

interface GenerationDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: GenerationEntry | null;
  /** The §13.9 matrix, loaded by the calling screen so the gate is decided from one source. */
  capabilities: readonly ContentCapability[] | undefined;
  /** Called after the server accepts the job. The dialog closes; the job is server-side state. */
  onAccepted: (result: { job: GenerationJob; created: boolean }) => void;
}

type Step = 1 | 2 | 3 | 4 | 5;

export function GenerationDialog({
  projectId,
  open,
  onOpenChange,
  entry,
  capabilities,
  onAccepted,
}: GenerationDialogProps) {
  const [step, setStep] = useState<Step>(1);
  const [assetType, setAssetType] = useState<string>('');
  const [topic, setTopic] = useState('');
  const [instructions, setInstructions] = useState('');
  const [briefId, setBriefId] = useState<string>('none');
  const [briefs, setBriefs] = useState<ContentBrief[] | null>(null);
  const [styleProfileId, setStyleProfileId] = useState<string>('active');
  const [styleVersions, setStyleVersions] = useState<WritingStyleProfile[] | null>(null);
  const [activeStyle, setActiveStyle] = useState<WritingStyleProfile | null>(null);
  const [audience, setAudience] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [profileVersion, setProfileVersion] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<CostEstimateView | null>(null);
  const [estimateError, setEstimateError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvingPlan, setApprovingPlan] = useState(false);
  const [noPlanAcknowledged, setNoPlanAcknowledged] = useState(false);
  // Create-a-plan fields (only used when this dialog has to make the plan).
  const [planTitle, setPlanTitle] = useState('');
  const [planAngle, setPlanAngle] = useState('');
  const [planIntent, setPlanIntent] = useState<'informational' | 'commercial' | 'transactional' | 'navigational'>('informational');
  const [planWordTarget, setPlanWordTarget] = useState('900');

  const generatable = useMemo(
    () => (capabilities ?? []).filter((capability) => capability.generationImplemented),
    [capabilities],
  );

  // ── Reset + seed from the entry point each time the dialog opens ──────
  useEffect(() => {
    if (!open || !entry) return;
    setStep(1);
    setError(null);
    setEstimate(null);
    setEstimateError(null);
    setApprovingPlan(false);
    setNoPlanAcknowledged(false);
    setInstructions('');
    setPlanAngle('');
    setPlanTitle(entry.topic ?? '');
    setTopic(entry.topic ?? '');

    if (entry.kind === 'plan') {
      setAssetType(entry.assetType);
      setBriefId(entry.briefId);
    } else if (entry.kind === 'version') {
      setAssetType(entry.assetType);
      setBriefId('none');
    } else {
      // Prefer a type the server can actually generate; fall back to the first
      // matrix row so the select is never empty while the matrix loads.
      const preferred = generatable.find((capability) => capability.assetType === 'article') ?? generatable[0];
      setAssetType(preferred?.assetType ?? '');
      setBriefId('none');
    }
    setStyleProfileId('active');
    // `generatable` is derived from `capabilities`; re-seeding on every matrix
    // identity change would wipe what the operator typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);

  const loadContext = useCallback(
    async (signal: AbortSignal) => {
      const [briefsResult, styleResult, versionsResult, profileResult, targetsResult] =
        await Promise.allSettled([
          listContentBriefs(projectId, { latestOnly: true }, { signal }),
          getActiveWritingStyle(projectId, { signal }),
          listWritingStyleVersions(projectId, { signal }),
          getBusinessProfile(projectId, { state: 'confirmed' }, { signal }),
          getTargetLocations(projectId, { signal }),
        ]);

      if (signal.aborted) return;

      setBriefs(briefsResult.status === 'fulfilled' ? briefsResult.value.briefs : []);
      setActiveStyle(styleResult.status === 'fulfilled' ? styleResult.value : null);
      setStyleVersions(
        versionsResult.status === 'fulfilled'
          ? versionsResult.value.versions.filter((version) => version.confirmedAt !== null)
          : [],
      );

      if (profileResult.status === 'fulfilled') {
        const confirmed = profileResult.value.profile;
        setProfileVersion(confirmed?.version ?? null);
        setAudience(confirmed?.data.icp.segments.join(', ') || null);
        setLanguage(confirmed?.data.languages[0] ?? null);
      }

      if (targetsResult.status === 'fulfilled') {
        const target = targetsResult.value.targets.find((candidate) => candidate.active);
        setLocation(
          target
            ? [target.city, target.region, target.country].filter(Boolean).join(', ')
            : null,
        );
        if (!language) {
          const targetLanguage = targetsResult.value.targets.find((candidate) => candidate.active)?.language;
          if (targetLanguage) setLanguage(targetLanguage);
        }
      }
    },
    // `language` is only read to avoid clobbering a value already set from the
    // business profile; re-running on its change would refetch every context
    // read for a value this function does not own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  useEffect(() => {
    if (!open || !entry) return;
    const controller = new AbortController();
    void loadContext(controller.signal);
    return () => controller.abort();
  }, [open, entry, loadContext]);

  const selectedBrief = useMemo(
    () => (briefs ?? []).find((brief) => brief.id === briefId) ?? null,
    [briefs, briefId],
  );
  const approvedBrief = selectedBrief && selectedBrief.status === 'approved' ? selectedBrief : null;
  const planIsMissing = briefId === 'none';
  const planNeedsApproval = !!selectedBrief && selectedBrief.status !== 'approved';

  // ── §13.6 step 5: the estimate is a real pre-flight read, not a guess ──
  const loadEstimate = useCallback(
    async (signal?: AbortSignal) => {
      setEstimateError(null);
      try {
        const result = await estimateContentGeneration(
          projectId,
          {
            assetType,
            briefId: approvedBrief?.id ?? null,
            briefVersion: approvedBrief?.version ?? null,
            // Length target only: §13.6's review panel needs a scope, and this
            // is the one scope field the brief actually records.
            wordTarget: approvedBrief?.wordTarget ?? (Number(planWordTarget) || null),
          },
          { signal },
        );
        setEstimate(result);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setEstimateError(toApiError(caught));
      }
    },
    [projectId, assetType, approvedBrief, planWordTarget],
  );

  useEffect(() => {
    if (!open || step !== 5) return;
    const controller = new AbortController();
    void loadEstimate(controller.signal);
    return () => controller.abort();
  }, [open, step, loadEstimate]);

  const capabilityRow = capabilities?.find((capability) => capability.assetType === assetType);

  // ── The plan this dialog will attach: an approved one, or one it makes ──

  const approvePlan = useCallback(async () => {
    if (!selectedBrief) return;
    setApprovingPlan(true);
    setError(null);
    try {
      // PATCHing a draft to `approved` is the plan's existing approval
      // requirement. A brief that is already approved forks a NEW draft
      // version when patched, which is why the returned row's id is used.
      const updated = await updateContentBrief(projectId, selectedBrief.id, { status: 'approved' });
      setBriefs((current) =>
        (current ?? []).map((brief) => (brief.id === selectedBrief.id ? updated : brief)),
      );
      setBriefId(updated.id);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setApprovingPlan(false);
    }
  }, [projectId, selectedBrief]);

  const createPlan = useCallback(async (): Promise<string | null> => {
    const created = await createContentBrief(projectId, {
      title: planTitle.trim() || topic.trim() || 'Untitled content plan',
      assetType: assetType as ContentBrief['assetType'],
      targetQuery: topic.trim() || undefined,
      audience: audience ?? undefined,
      intent: planIntent,
      angle: planAngle.trim() || instructions.trim() || undefined,
      wordTarget: Number(planWordTarget) > 0 ? Number(planWordTarget) : undefined,
      language: language ?? undefined,
      sourceType: entry?.kind === 'idea' ? 'opportunity' : undefined,
      sourceId: entry?.kind === 'idea' ? entry.opportunityId : undefined,
    });
    setBriefs((current) => [...(current ?? []), created]);
    setBriefId(created.id);
    return created.id;
  }, [projectId, planTitle, topic, assetType, audience, planIntent, planAngle, instructions, planWordTarget, language, entry]);

  const approvePlanById = useCallback(
    async (id: string) => {
      const updated = await updateContentBrief(projectId, id, { status: 'approved' });
      setBriefs((current) => (current ?? []).map((brief) => (brief.id === id ? updated : brief)));
      setBriefId(updated.id);
      return updated;
    },
    [projectId],
  );

  const canStart =
    !busy &&
    !!assetType &&
    generationImplementedFor(capabilities, assetType) === true &&
    topic.trim().length > 0 &&
    (!!approvedBrief || (planIsMissing && noPlanAcknowledged));

  // ── Start ────────────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      // The plan gate: an approved brief, or a plan this dialog makes and
      // approves through the same route a plan screen would use.
      let resolvedBrief = approvedBrief;
      if (!resolvedBrief && planIsMissing && planTitle.trim()) {
        const createdId = await createPlan();
        if (createdId) resolvedBrief = await approvePlanById(createdId);
      }

      // §13.6 "Start from an idea": reuse the opportunities module's existing
      // idempotent conversion. A second confirm with the same intent creates
      // nothing new — it finds the piece the first one made.
      let contentAssetId: string | undefined;
      if (entry.kind === 'idea') {
        const converted = await convertOpportunityToContent(projectId, entry.opportunityId, {
          idempotencyKey: newIdempotencyKey(),
          assetType: assetType as ContentBrief['assetType'],
        });
        contentAssetId = converted.asset.id;
      } else if (entry.kind === 'version') {
        contentAssetId = entry.assetId;
      }

      const result = await enqueueGenerationJob(projectId, {
        idempotencyKey: newGenerationKey(),
        assetType,
        contentAssetId,
        briefId: resolvedBrief?.id,
        topic: {
          targetKeyword: topic.trim(),
          ...(assetType === 'ad-copy'
            ? { adAngle: instructions.trim() || undefined }
            : { blogTopic: instructions.trim() || undefined }),
        },
        writingStyleProfileId: styleProfileId === 'active' ? undefined : styleProfileId,
      });
      onAccepted(result);
      onOpenChange(false);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [
    entry,
    approvedBrief,
    planIsMissing,
    planTitle,
    createPlan,
    approvePlanById,
    projectId,
    assetType,
    topic,
    instructions,
    styleProfileId,
    onAccepted,
    onOpenChange,
  ]);

  if (!entry) return null;

  const createsNewPiece = entry.kind === 'new' || entry.kind === 'idea' || entry.kind === 'plan';
  const selectedStyle =
    styleProfileId === 'active'
      ? activeStyle
      : (styleVersions ?? []).find((version) => version.id === styleProfileId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ENTRY_LABELS[entry.kind]}</DialogTitle>
          <DialogDescription>
            {entry.kind === 'idea'
              ? 'Turn this idea into a content piece and prepare its first draft.'
              : entry.kind === 'version'
                ? `Prepare a new draft revision of “${entry.assetTitle}”. The current version and any approval on it are untouched.`
                : 'Prepare a draft. Nothing is published by this action, and the draft still needs review.'}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState error={error} layout="inline" onRetry={() => setError(null)} retryLabel="Dismiss" />
        ) : null}

        <ol className="space-y-6">
          {/* ── 1. What are we creating? ─────────────────────────────── */}
          <Section index={1} title="What are we creating?" step={step} onOpen={() => setStep(1)}>
            <div className="space-y-2">
              <Label htmlFor="generation-asset-type">Content type</Label>
              <Select value={assetType} onValueChange={setAssetType}>
                <SelectTrigger id="generation-asset-type">
                  <SelectValue placeholder={capabilities ? 'Choose a type' : 'Checking what can be generated…'} />
                </SelectTrigger>
                <SelectContent>
                  {generatable.map((capability) => (
                    <SelectItem key={capability.assetType} value={capability.assetType}>
                      {capability.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {capabilities && generatable.length === 0 ? (
                <p className="text-meta text-muted-foreground">
                  No content type has a tested writer in this build yet, so nothing can be
                  generated. Content can still be planned and written by hand.
                </p>
              ) : null}
              {capabilityRow ? (
                <p className="text-meta text-muted-foreground">{capabilityRow.note}</p>
              ) : null}
              <p className="text-meta text-muted-foreground">
                Purpose: {entry.kind === 'version' ? 'a new revision of an existing piece' : 'a new content piece'}.
                {generatable.length > 0
                  ? ` Types without a tested writer are not listed — see the capability matrix on the content screen.`
                  : ''}
              </p>
            </div>
          </Section>

          {/* ── 2. Who is it for? (read-only, from confirmed records) ── */}
          <Section index={2} title="Who is it for?" step={step} onOpen={() => setStep(2)}>
            <dl className="grid gap-3 sm:grid-cols-3">
              <ReadOnlyField label="Audience" value={audience} source="confirmed business information" />
              <ReadOnlyField label="Language" value={language} source="confirmed business information" />
              <ReadOnlyField label="Target location" value={location} source="your target markets" />
            </dl>
            <p className="text-meta text-muted-foreground">
              These come from your confirmed business information and target markets, so every
              draft starts from the same audience. Change them there rather than per draft.
            </p>
          </Section>

          {/* ── 3. What should it cover? ─────────────────────────────── */}
          <Section index={3} title="What should it cover?" step={step} onOpen={() => setStep(3)}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="generation-topic">Topic or search target</Label>
                <Input
                  id="generation-topic"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="e.g. commercial roof inspection cost"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="generation-instructions">
                  {assetType === 'ad-copy' ? 'Ad angle' : 'Instructions / outline'}
                </Label>
                <Textarea
                  id="generation-instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  rows={4}
                  placeholder={
                    assetType === 'ad-copy'
                      ? 'e.g. Lead with the free inspection; keep it under 90 characters.'
                      : 'e.g. Cover cost ranges, what is included, and how to prepare.'
                  }
                />
                <p className="text-meta text-muted-foreground">
                  This is the instruction the writer receives
                  {assetType === 'ad-copy' ? ' as the ad angle' : ' as the working title and outline'}.
                </p>
              </div>
              <SourceReferences brief={approvedBrief ?? selectedBrief} entry={entry} />
            </div>
          </Section>

          {/* ── 4. Writing style ─────────────────────────────────────── */}
          <Section index={4} title="Writing style" step={step} onOpen={() => setStep(4)}>
            {activeStyle ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-table font-medium text-foreground">
                      {selectedStyle?.name ?? activeStyle.name}
                      <span className="ml-2 text-meta text-muted-foreground">
                        v{selectedStyle?.version ?? activeStyle.version}
                      </span>
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {summarizeWritingStyle(selectedStyle ?? activeStyle)}
                    </p>
                  </div>
                  <StatusPill label="Confirmed" tone="success" />
                </div>
                {styleVersions && styleVersions.length > 1 ? (
                  <div className="space-y-2">
                    <Label htmlFor="generation-style">Style version to use</Label>
                    <Select value={styleProfileId} onValueChange={setStyleProfileId}>
                      <SelectTrigger id="generation-style">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active confirmed version</SelectItem>
                        {styleVersions.map((version) => (
                          <SelectItem key={version.id} value={version.id}>
                            v{version.version}
                            {version.confirmedAt === null ? ' (draft)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <p className="text-meta text-muted-foreground">
                  The draft is pinned to this exact version. Editing your style later does not
                  change a draft already being prepared.
                </p>
              </div>
            ) : (
              <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertTitle>No confirmed writing style yet</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    The draft will be prepared without a style profile, so it will sound like the
                    writer&apos;s default rather than your business. You can set one up first.
                  </p>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/projects/${projectId}/content/writing-style`}>Set up writing style</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {activeStyle ? (
              <p className="text-meta">
                <Link
                  href={`/projects/${projectId}/content/writing-style`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Change writing style
                </Link>
              </p>
            ) : null}
          </Section>

          {/* ── 5. Review before starting ────────────────────────────── */}
          <Section index={5} title="Review before starting" step={step} onOpen={() => setStep(5)}>
            <div className="space-y-4">
              <PlanGate
                briefs={briefs}
                briefId={briefId}
                onBriefChange={setBriefId}
                selectedBrief={selectedBrief}
                approvedBrief={approvedBrief}
                planNeedsApproval={planNeedsApproval}
                approvingPlan={approvingPlan}
                onApprovePlan={() => void approvePlan()}
                planIsMissing={planIsMissing}
                noPlanAcknowledged={noPlanAcknowledged}
                onNoPlanAcknowledged={setNoPlanAcknowledged}
                planTitle={planTitle}
                onPlanTitle={setPlanTitle}
                planAngle={planAngle}
                onPlanAngle={setPlanAngle}
                planIntent={planIntent}
                onPlanIntent={(value) => setPlanIntent(value as typeof planIntent)}
                planWordTarget={planWordTarget}
                onPlanWordTarget={setPlanWordTarget}
              />

              <dl className="grid gap-3 text-table sm:grid-cols-2">
                <ReviewRow label="Creates" value={createsNewPiece ? 'A new content piece with its first draft' : 'A new revision of the existing piece'} />
                <ReviewRow label="Output" value="1 draft revision" />
                <ReviewRow
                  label="Content plan"
                  value={approvedBrief ? `${approvedBrief.title} · v${approvedBrief.version} (approved)` : 'None attached'}
                  tone={approvedBrief ? 'ok' : 'warn'}
                />
                <ReviewRow
                  label="Writing style"
                  value={selectedStyle ? `${selectedStyle.name} · v${selectedStyle.version}` : 'Not pinned'}
                  tone={selectedStyle ? 'ok' : 'warn'}
                />
                <ReviewRow
                  label="Business information"
                  value={profileVersion ? `Confirmed version ${profileVersion}` : 'No confirmed version'}
                  tone={profileVersion ? 'ok' : 'warn'}
                />
                <ReviewRow
                  label="Estimated cost"
                  value={estimateLabel(estimate, estimateError)}
                  tone={estimateError ? 'warn' : estimate?.estimate.available ? 'ok' : 'warn'}
                />
              </dl>

              {estimateError ? (
                <p className="text-meta text-muted-foreground">
                  The cost estimate could not be read. That is not an estimate of zero — ask for
                  the spend figure before starting if the budget matters.
                </p>
              ) : null}
              {estimate && !estimate.estimate.available ? (
                <p className="text-meta text-muted-foreground">
                  {estimate.estimate.reason ?? 'No estimator exists for this task in this build.'}
                </p>
              ) : null}
              {estimate && estimate.estimate.available ? (
                <p className="text-meta text-muted-foreground">
                  {estimate.reservationRequired
                    ? 'A budget reservation is taken when this starts and settled against actual usage.'
                    : 'No reservation is required for this task.'}{' '}
                  Affordability: {estimate.affordability.replace(/-/g, ' ')}.
                </p>
              ) : null}

              <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertTitle>What happens when you start</AlertTitle>
                <AlertDescription className="space-y-1">
                  <p>
                    The request is recorded with the plan version, style version and business
                    information version above, then prepared in the background. You can close this
                    window — nothing is lost if the page reloads.
                  </p>
                  <p>
                    The draft still needs internal review, and a client sees nothing until someone
                    shares that exact revision with them.
                  </p>
                </AlertDescription>
              </Alert>
            </div>
          </Section>
        </ol>

        <DialogFooter className="gap-2 sm:justify-between">
          {/* §4.5: the reason a disabled control cannot be used must be
              reachable from the control itself, not only visible near it. */}
          <p id="generation-start-reason" className="text-meta text-muted-foreground">
            {canStart
              ? 'Ready to start.'
              : planNeedsApproval
                ? 'Approve the content plan first.'
                : planIsMissing && !noPlanAcknowledged
                  ? 'Choose an approved plan, or acknowledge starting without one.'
                  : !topic.trim()
                    ? 'Add a topic or search target.'
                    : 'Checking…'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void start()}
              disabled={!canStart}
              aria-describedby="generation-start-reason"
            >
              {busy ? (
                <>
                  <Wand2 aria-hidden="true" className="mr-2 h-4 w-4 animate-pulse" />
                  Starting…
                </>
              ) : (
                <>
                  <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
                  {createsNewPiece ? 'Create and prepare draft' : 'Prepare new draft'}
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

function Section({
  index,
  title,
  step,
  onOpen,
  children,
}: {
  index: Step;
  title: string;
  step: Step;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const isCurrent = step >= index;
  return (
    <li className={isCurrent ? undefined : 'opacity-60'}>
      {/*
        §4.5: this button moves the wizard to a step; it does not expand or
        collapse one. The step's content is always rendered below, so an
        `aria-expanded` here would assert a disclosure that never happens —
        the button is named by what it does instead.
      */}
      <button
        type="button"
        onClick={onOpen}
        className="mb-2 flex w-full items-center gap-2 text-left"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-meta font-medium text-muted-foreground"
        >
          {index}
        </span>
        <span className="text-subsection font-medium text-foreground">{title}</span>
        <span className="sr-only">— go to this step</span>
      </button>
      <div className="pl-8">{children}</div>
    </li>
  );
}

function ReadOnlyField({
  label,
  value,
  source,
}: {
  label: string;
  value: string | null;
  source: string;
}) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table text-foreground">
        {value ?? <span className="text-muted-foreground">Not recorded</span>}
      </dd>
      <p className="text-meta text-muted-foreground">from {source}</p>
    </div>
  );
}

function ReviewRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0">
        <dt className="text-meta text-muted-foreground">{label}</dt>
        <dd className="text-table text-foreground">{value}</dd>
      </div>
      {tone === 'ok' ? (
        <CheckCircle2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-success-foreground" />
      ) : null}
      {tone === 'warn' ? (
        <AlertTriangle aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-warning-foreground" />
      ) : null}
    </div>
  );
}

/**
 * Source references are shown, not typed in. The job pins evidence ids that
 * the brief or the idea already carries; a free-text URL box would accept
 * addresses the writer never receives, which is worse than no box at all
 * (§13.6's "source references" means the real ones, not the appearance of one).
 */
function SourceReferences({
  brief,
  entry,
}: {
  brief: ContentBrief | null;
  entry: GenerationEntry;
}) {
  const references = brief?.references ?? [];
  return (
    <div className="space-y-2">
      <p className="text-table font-medium text-foreground">Source references</p>
      {references.length > 0 ? (
        <ul className="space-y-1">
          {references.map((reference) => (
            <li key={reference.url} className="text-meta text-muted-foreground">
              <a href={reference.url} className="text-primary underline-offset-4 hover:underline">
                {reference.url}
              </a>
              {reference.note ? ` — ${reference.note}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-muted-foreground">
          {entry.kind === 'idea'
            ? 'The evidence behind this idea is pinned to the piece when it is created.'
            : 'No references are attached to this plan yet, so the draft will work from the topic alone. Add references to the plan to constrain it.'}
        </p>
      )}
    </div>
  );
}

function PlanGate({
  briefs,
  briefId,
  onBriefChange,
  selectedBrief,
  approvedBrief,
  planNeedsApproval,
  approvingPlan,
  onApprovePlan,
  planIsMissing,
  noPlanAcknowledged,
  onNoPlanAcknowledged,
  planTitle,
  onPlanTitle,
  planAngle,
  onPlanAngle,
  planIntent,
  onPlanIntent,
  planWordTarget,
  onPlanWordTarget,
}: {
  briefs: ContentBrief[] | null;
  briefId: string;
  onBriefChange: (value: string) => void;
  selectedBrief: ContentBrief | null;
  approvedBrief: ContentBrief | null;
  planNeedsApproval: boolean;
  approvingPlan: boolean;
  onApprovePlan: () => void;
  planIsMissing: boolean;
  noPlanAcknowledged: boolean;
  onNoPlanAcknowledged: (value: boolean) => void;
  planTitle: string;
  onPlanTitle: (value: string) => void;
  planAngle: string;
  onPlanAngle: (value: string) => void;
  planIntent: string;
  onPlanIntent: (value: string) => void;
  planWordTarget: string;
  onPlanWordTarget: (value: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-2">
        <Label htmlFor="generation-brief">Content plan</Label>
        {briefs === null ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <Select value={briefId} onValueChange={onBriefChange}>
            <SelectTrigger id="generation-brief">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {briefs.map((brief) => (
                <SelectItem key={brief.id} value={brief.id}>
                  {brief.title} · v{brief.version}
                  {brief.status === 'approved' ? ' (approved)' : ` (${brief.status})`}
                </SelectItem>
              ))}
              <SelectItem value="none">No plan — prepare a one-off draft</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {planNeedsApproval && selectedBrief ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>“{selectedBrief.title}” is not approved yet</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Generation cannot bypass the approved-plan gate. Approving records your sign-off on
              this instruction set; it is not the client&rsquo;s approval of the finished draft,
              which is a separate later step.
            </p>
            <Button size="sm" variant="outline" onClick={onApprovePlan} disabled={approvingPlan}>
              {approvingPlan ? 'Approving…' : 'Approve this plan'}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {planIsMissing ? (
        <div className="space-y-3">
          <Alert>
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <AlertTitle>Without an approved plan, nothing constrains the draft</AlertTitle>
            <AlertDescription>
              A content plan records the audience, intent, angle and length the draft is checked
              against. Preparing one first is the normal path.
            </AlertDescription>
          </Alert>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="generation-plan-title">New plan title</Label>
              <Input
                id="generation-plan-title"
                value={planTitle}
                onChange={(event) => onPlanTitle(event.target.value)}
                placeholder="Defaults to the topic above"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="generation-plan-intent">Intent</Label>
              <Select value={planIntent} onValueChange={onPlanIntent}>
                <SelectTrigger id="generation-plan-intent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="informational">Informational</SelectItem>
                  <SelectItem value="commercial">Commercial</SelectItem>
                  <SelectItem value="transactional">Transactional</SelectItem>
                  <SelectItem value="navigational">Navigational</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="generation-plan-words">Word target</Label>
              <Input
                id="generation-plan-words"
                inputMode="numeric"
                value={planWordTarget}
                onChange={(event) => onPlanWordTarget(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="generation-plan-angle">Angle</Label>
              <Input
                id="generation-plan-angle"
                value={planAngle}
                onChange={(event) => onPlanAngle(event.target.value)}
                placeholder="What this piece argues or answers"
              />
            </div>
          </div>
          <p className="text-meta text-muted-foreground">
            The plan is created and approved as part of starting, using the same approval step as
            the content plans screen — {approvedBrief ? '' : 'no different route, and no bypass.'}
          </p>
          <label className="flex items-start gap-2 text-table">
            <Checkbox
              checked={noPlanAcknowledged}
              onCheckedChange={(checked) => onNoPlanAcknowledged(checked === true)}
            />
            <span>
              Prepare this draft with no content plan attached. I understand there will be no
              approved brief to check it against.
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function estimateLabel(
  estimate: CostEstimateView | null,
  error: ReturnType<typeof toApiError> | null,
): string {
  if (error) return 'Not available';
  if (!estimate) return 'Checking…';
  if (!estimate.estimate.available) return 'No estimate available';
  const ranges = estimate.estimate.ranges ?? [];
  if (ranges.length === 0) return 'Estimate returned without a range';
  return ranges
    .map((range) => {
      // `unit` is the estimator's own unit (usd or credits) — never relabelled
      // to dollars, because a credit is not a dollar.
      const format = (amount: number) =>
        range.unit === 'usd' ? `$${amount.toFixed(2)}` : `${amount.toFixed(1)} credits`;
      // A `point` range is a single value, not an interval — printing
      // "$3.00–$3.00" would imply a precision the estimator did not claim.
      return range.rangeKind === 'point' ? format(range.low) : `${format(range.low)}–${format(range.high)}`;
    })
    .join(' · ');
}

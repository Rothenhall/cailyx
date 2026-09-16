'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, ClipboardCheck, Copy, Download, RefreshCw } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { formatNumber, notMeasuredLabel } from '@/lib/format';
import {
  ASSET_TYPE_LABELS,
  checkCopy,
  getAssetContent,
  isGeneratable,
  listAssetRevisions,
  recordAssetLifecycle,
  saveAssetContent,
  versionConflictOf,
  type AssetContent,
  type ContentRevision,
  type CopyCheckReport,
  type VersionConflict,
} from '@/services/content';

/**
 * CT04 — Content detail and editor.
 *
 * design_plan.md §4.4: *"Article fields/Markdown/FAQ/JSON-LD or ad variants;
 * preview/export, QA, revisions, source facts."* §5.8 Stage D is the detail:
 * the article panel carries title, meta description, slug, Markdown body, word
 * count, FAQ pairs, JSON-LD and the generation model; the ad panel carries each
 * variant **and its character counts**, with the caveat that *"model
 * instructions do not guarantee ad-platform limits."*
 *
 * Three rules shape the editor:
 *
 *  1. **Every save is a new immutable revision, guarded by `expectedVersion`.**
 *     A save that quotes a stale version is a 409, and this screen shows the
 *     server's version beside the local draft and asks what to do — it never
 *     claims a save that did not happen, and it never silently overwrites a
 *     concurrent edit (§3.5 "Concurrent update").
 *  2. **Nothing outside this editor has a persistence story.** There is no
 *     rich-text backend and no autosave; the stored original is revision N, and
 *     the export path says so plainly so a copy edited in another tool is not
 *     mistaken for the stored draft.
 *  3. **A generated draft, an external edit and a published URL are three
 *     different facts.** The revision's origin and the asset's lifecycle status
 *     are labelled separately, and "Record as published" is named for what it
 *     does — it records a URL a human published, it does not publish anything.
 */

const HEADLINE_TARGET = 30;
const DESCRIPTION_TARGET = 90;

interface DraftState {
  title: string;
  body: string;
  /** The whole `fields` object, so unknown keys survive a save. */
  fields: Record<string, unknown>;
}

export default function ContentAssetPage() {
  const params = useParams<{ projectId: string; assetId: string }>();
  const projectId = params.projectId;
  const assetId = params.assetId;

  const [asset, setAsset] = useState<AssetContent | null>(null);
  const [revisions, setRevisions] = useState<ContentRevision[] | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [revisionError, setRevisionError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkReport, setCheckReport] = useState<CopyCheckReport | null>(null);
  const [checkError, setCheckError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [checkedRevision, setCheckedRevision] = useState<number | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishUrl, setPublishUrl] = useState('');
  const [publishError, setPublishError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  // §10.4 double-submit protection: a ref, so two clicks in one tick cannot
  // both pass the guard before state updates.
  const saveInFlight = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoadError(null);
        const [assetContent, revisionList] = await Promise.all([
          getAssetContent(projectId, assetId, { signal }),
          listAssetRevisions(projectId, assetId, { signal }),
        ]);
        setAsset(assetContent);
        setRevisions(revisionList.revisions);
        setDraft(draftFrom(assetContent));
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadError(toApiError(caught));
      }
    },
    [projectId, assetId],
  );

  const loadRevisions = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setRevisionError(null);
        const result = await listAssetRevisions(projectId, assetId, { signal });
        setRevisions(result.revisions);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setRevisionError(toApiError(caught));
      }
    },
    [projectId, assetId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const stored = asset?.current ?? null;
  const isAdCopy = asset?.assetType === 'ad-copy';

  const dirty = useMemo(() => {
    if (!asset || !draft) return false;
    const sameTitle = draft.title === (stored?.title ?? asset.title);
    const sameBody = isAdCopy ? true : draft.body === (stored?.body ?? '');
    const sameFields = JSON.stringify(draft.fields) === JSON.stringify(stored?.fields ?? {});
    return !sameTitle || !sameBody || !sameFields;
  }, [asset, draft, stored, isAdCopy]);

  const draftWords = draft ? countWords(isAdCopy ? '' : draft.body) : 0;

  async function onSave() {
    if (!asset || !draft || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAssetContent(projectId, assetId, {
        title: draft.title.trim() || asset.title,
        // Ad copy has no single prose body — its content lives in `fields`.
        ...(isAdCopy ? {} : { body: draft.body }),
        // Sent whole: the server falls back per key, so a partial object would
        // silently drop the keys left out (including generated JSON-LD).
        fields: draft.fields,
        expectedVersion: asset.currentVersion,
      });
      setAsset(saved);
      setDraft(draftFrom(saved));
      setConflict(null);
      setSavedAt(saved.current?.createdAt ?? null);
      await loadRevisions();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const stale = versionConflictOf(caught);
      if (stale) {
        // Preserve the local draft and surface the server's version — never a
        // silent overwrite, and never a "Saved" claim.
        setConflict(stale);
        await load();
      } else {
        setSaveError(toApiError(caught));
      }
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  async function onCheck() {
    if (!draft) return;
    setChecking(true);
    setCheckError(null);
    try {
      const copy = isAdCopy ? adCopyAsText(draft) : `${draft.title}\n\n${draft.body}`;
      const report = await checkCopy(projectId, copy.slice(0, 5000));
      setCheckReport(report);
      setCheckedRevision(asset?.currentVersion ?? null);
    } catch (caught) {
      setCheckError(toApiError(caught));
    } finally {
      setChecking(false);
    }
  }

  async function onRecordPublished() {
    setPublishing(true);
    setPublishError(null);
    try {
      await recordAssetLifecycle(projectId, assetId, {
        status: 'published',
        ...(publishUrl.trim() ? { assetUrl: publishUrl.trim() } : {}),
      });
      setPublishOpen(false);
      await load();
    } catch (caught) {
      setPublishError(toApiError(caught));
    } finally {
      setPublishing(false);
    }
  }

  const exportText = draft && asset ? buildExport(asset, draft, isAdCopy) : '';

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Content asset" breadcrumbs={[{ label: 'Content', href: contentHref(projectId) }]} />
        <ErrorState error={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  if (!asset || !draft) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const revisionLabel =
    asset.currentVersion === 0
      ? 'No revision saved yet'
      : `Revision ${asset.currentVersion}`;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Content', href: contentHref(projectId) }]}
        title={draft.title || asset.title}
        context={
          <span className="flex flex-wrap items-center gap-2">
            <span>{ASSET_TYPE_LABELS[asset.assetType]}</span>
            <StatusPill label={lifecycleLabel(asset.status)} tone={lifecycleTone(asset.status)} />
            <span className="text-muted-foreground">{revisionLabel}</span>
            {stored?.origin ? <ProvenanceBadge kind={originProvenance(stored.origin)} /> : null}
          </span>
        }
        primaryAction={{
          label: saving ? 'Saving…' : dirty ? `Save as revision ${asset.currentVersion + 1}` : 'Save revision',
          onClick: () => void onSave(),
          disabled: saving || conflict !== null,
          disabledReason: conflict
            ? 'The server has a newer revision. Resolve the conflict below before saving.'
            : 'Nothing has changed since this revision was loaded.',
        }}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={contentHref(projectId)}>Asset library</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Reload
            </Button>
          </div>
        }
      />

      {/* §5.8 Stage D: pre-G09 content lives on the asset row, not in a revision. */}
      {asset.legacyContentOnly ? (
        <Alert>
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>This content was never saved as a revision</AlertTitle>
          <AlertDescription>
            No revision exists for this asset yet. What is shown is the text the generator wrote
            directly onto the record before revisions existed — read-only context. Your first save
            creates revision 1 and leaves this original where it is.
          </AlertDescription>
        </Alert>
      ) : null}

      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          draft={draft}
          isAdCopy={isAdCopy}
          onUseServer={() => {
            setDraft(draftFrom(asset));
            setConflict(null);
          }}
          onKeepMine={() => {
            // The operator has seen both versions. Adopting the server's version
            // number is what makes the next save a real write on top of it rather
            // than a second 409.
            setAsset({ ...asset, currentVersion: conflict.currentVersion });
            setConflict(null);
          }}
        />
      ) : null}

      {saveError ? (
        <ErrorState
          error={saveError}
          layout="inline"
          preserveNotice="Your draft is still in this editor and has not been lost."
        />
      ) : null}

      {/*
        A save is only announced while the editor still matches what was saved.
        The moment a field changes, the claim stops being true, so it is not
        shown — the alternative is a stale "Saved" that hides unsaved work.
      */}
      {savedAt && !dirty ? (
        <p className="text-table text-success-foreground" role="status">
          Saved as revision {asset.currentVersion} · <Timestamp value={savedAt} />
        </p>
      ) : null}

      <Tabs defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit">Editor</TabsTrigger>
          <TabsTrigger value="preview">Preview &amp; export</TabsTrigger>
          <TabsTrigger value="qa">Quality check</TabsTrigger>
          <TabsTrigger value="revisions">
            Revisions{revisions ? ` (${revisions.length})` : ''}
          </TabsTrigger>
        </TabsList>

        {/* ── Editor ─────────────────────────────────────────────────── */}
        <TabsContent value="edit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Fields</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-meta text-muted-foreground">
                Editing here is plain text, not a rich-text document: a save stores the exact text
                you see as a new revision. Earlier revisions are never modified.
              </p>

              <div className="space-y-2">
                <Label htmlFor="asset-title">Title</Label>
                <Input
                  id="asset-title"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </div>

              {isAdCopy ? (
                <AdCopyFields
                  fields={draft.fields}
                  onChange={(fields) => setDraft({ ...draft, fields })}
                />
              ) : (
                <ArticleFields
                  fields={draft.fields}
                  onChange={(fields) => setDraft({ ...draft, fields })}
                  body={draft.body}
                  onBodyChange={(body) => setDraft({ ...draft, body })}
                />
              )}

              <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-meta text-muted-foreground">
                <span>
                  {isAdCopy
                    ? 'Ad copy has no prose body — all of its content is in the variants above.'
                    : `${formatNumber(draftWords)} words in this draft (counted here; the server recounts on save)`}
                </span>
                {stored ? (
                  <span>
                    Stored at revision {stored.revision}: {formatNumber(stored.wordCount)} words
                  </span>
                ) : null}
                {stored?.contentHash ? (
                  <span title={stored.contentHash}>
                    Content digest {stored.contentHash.slice(0, 12)}…
                  </span>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Source facts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-2 text-table">
              <dl className="grid gap-1 sm:grid-cols-2">
                <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                  <dt className="text-muted-foreground">Generated from brief</dt>
                  <dd className="font-medium text-foreground">
                    {stored?.briefId
                      ? `${stored.briefId.slice(0, 10)}… at v${stored.briefVersion ?? notMeasuredLabel()}`
                      : 'No brief recorded on this revision'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                  <dt className="text-muted-foreground">Revision origin</dt>
                  <dd className="font-medium text-foreground">
                    {stored ? originLabel(stored.origin) : notMeasuredLabel()}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                  <dt className="text-muted-foreground">Saved</dt>
                  <dd className="font-medium text-foreground">
                    {stored ? <Timestamp value={stored.createdAt} /> : notMeasuredLabel()}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 sm:flex-col sm:gap-0">
                  <dt className="text-muted-foreground">Lifecycle</dt>
                  <dd className="font-medium text-foreground">{lifecycleLabel(asset.status)}</dd>
                </div>
              </dl>
              {!isGeneratable(asset.assetType) ? (
                <p className="text-meta text-muted-foreground">
                  This asset type is brief-only: it is never machine-generated, so any text here was
                  written or pasted in by a person.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Preview & export ───────────────────────────────────────── */}
        <TabsContent value="preview" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Preview</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void onCopy()}>
                  <Copy aria-hidden="true" className="mr-2 h-4 w-4" />
                  {copied ? 'Copied' : 'Copy draft'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadText(exportFilename(asset, draft), exportText)}
                >
                  <Download aria-hidden="true" className="mr-2 h-4 w-4" />
                  Download draft
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Shown as plain text on purpose: the stored source is the Markdown you see, and
                rendered HTML from stored content is not treated as trusted markup.
              </p>
              <pre className="evidence max-h-[32rem] overflow-y-auto rounded-md border border-border bg-surface-sunken p-3">
                {exportText}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Working outside Cailyx</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-2 text-table">
              <p className="text-muted-foreground">
                Until an editorial integration exists, the approved process is to copy or download
                this draft into your own editorial tool. Two things follow from that:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  Edits made outside Cailyx do not come back on their own. Paste the finished text
                  back into the editor and save so the stored revision matches what shipped.
                </li>
                <li>
                  Exported text is revision {asset.currentVersion}, not the live page. Nothing here
                  publishes anything.
                </li>
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── QA ─────────────────────────────────────────────────────── */}
        <TabsContent value="qa" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-subsection">Claims discipline check</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onCheck()}
                disabled={checking}
                aria-busy={checking}
              >
                <ClipboardCheck aria-hidden="true" className="mr-2 h-4 w-4" />
                {checking ? 'Checking…' : 'Check this draft'}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                A deterministic check for banned phrases, numeric statements that need a graded
                source, and rate claims without multi-run provenance. It reads the text in this
                editor — it does not grade a live page, and the generator is not automatically
                protected by the claim-approval workflow, so running this is a deliberate step.
              </p>

              {checkError ? (
                <ErrorState
                  error={checkError}
                  layout="inline"
                  onRetry={() => void onCheck()}
                  preserveNotice="This is a read-only check; no draft was changed."
                />
              ) : null}

              {!checkReport && !checkError ? (
                <p className="text-table text-muted-foreground">
                  No check has been run for this draft yet.
                </p>
              ) : null}

              {checkReport ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      label={
                        checkReport.result === 'passed' ? 'Passed' : checkResultLabel(checkReport.result)
                      }
                      tone={checkReport.result === 'passed' ? 'success' : 'danger'}
                    />
                    <span className="text-meta text-muted-foreground">
                      Checked the text of revision {checkedRevision ?? asset.currentVersion}. This
                      result is not stored against the revision by this screen.
                    </span>
                  </div>

                  {checkReport.banned.length > 0 ? (
                    <div>
                      <h4 className="text-table font-medium text-foreground">Banned phrases</h4>
                      <ul className="list-disc space-y-1 pl-5 text-table">
                        {checkReport.banned.map((hit, index) => (
                          <li key={`${hit.phrase}-${index}`}>
                            <span className="font-medium">{hit.phrase}</span> — matched “
                            {hit.match}”
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {checkReport.numericClaims.length > 0 ? (
                    <div>
                      <h4 className="text-table font-medium text-foreground">
                        Numbers needing a graded source
                      </h4>
                      <ul className="list-disc space-y-1 pl-5 text-table">
                        {checkReport.numericClaims.map((claim, index) => (
                          <li key={index}>{claim}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {checkReport.singleRunRate ? (
                    <p className="text-table text-warning-foreground">
                      This copy states a rate without multi-run provenance. A single observation is
                      not a rate.
                    </p>
                  ) : null}

                  {checkReport.violations.length > 0 ? (
                    <div>
                      <h4 className="text-table font-medium text-foreground">Violations</h4>
                      <ul className="list-disc space-y-1 pl-5 text-table">
                        {checkReport.violations.map((violation, index) => (
                          <li key={index}>{violation}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Revisions ──────────────────────────────────────────────── */}
        <TabsContent value="revisions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Revision history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <p className="text-meta text-muted-foreground">
                Revisions are immutable. Loading an older one into the editor does not restore it —
                saving writes a new revision on top of the current one.
              </p>

              {revisionError ? (
                <ErrorState
                  error={revisionError}
                  layout="inline"
                  onRetry={() => void loadRevisions()}
                  preserveNotice="The editor above still holds your draft."
                />
              ) : null}

              {revisions && revisions.length === 0 ? (
                <EmptyState variant="not-measured" subject="saved revisions">
                  No revision has been saved for this asset. Generate it from an approved brief or
                  write a first draft and save.
                </EmptyState>
              ) : null}

              {revisions && revisions.length > 0 ? (
                <ul className="divide-y divide-border">
                  {revisions.map((revision) => (
                    <li
                      key={revision.id}
                      className="flex flex-wrap items-start justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-table font-medium text-foreground">
                          Revision {revision.revision}
                          <span className="ml-2 text-meta text-muted-foreground">
                            {originLabel(revision.origin)}
                          </span>
                          {revision.revision === asset.currentVersion ? (
                            <span className="ml-2 text-meta text-muted-foreground">
                              (current)
                            </span>
                          ) : null}
                        </p>
                        <p className="text-meta text-muted-foreground">
                          <Timestamp value={revision.createdAt} /> ·{' '}
                          {formatNumber(revision.wordCount)} words
                          {revision.briefVersion !== null
                            ? ` · brief v${revision.briefVersion}`
                            : ' · no brief recorded'}
                          {revision.authorId ? ` · ${revision.authorId}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDraft({
                              title: revision.title ?? draft.title,
                              body: revision.body ?? '',
                              fields: deepCopy(revision.fields),
                            });
                            setSavedAt(null);
                          }}
                        >
                          Load into editor
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Publication ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-subsection">Publication</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPublishUrl('');
              setPublishOpen(true);
            }}
          >
            Record as published
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 pt-2 text-table">
          <p className="text-muted-foreground">
            Current lifecycle: <strong>{lifecycleLabel(asset.status)}</strong>. Cailyx does not
            publish for you here — a person publishes in the CMS or ad tool, then records the live
            URL against this asset. That keeps a stored draft and a live page from being confused
            for one another.
          </p>
          <p className="text-muted-foreground">
            This record is also not the same thing as pushing to a configured destination: that path
            checks for an approval raised against the exact revision it is about to send. Recording a
            URL records a fact; it does not authorise a publication.
          </p>
          {isAdCopy ? (
            <p className="text-muted-foreground">
              Generating ad text never starts a campaign. Ad activation needs its own destination,
              budget choice and approval outside this screen.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record as published</DialogTitle>
            <DialogDescription>
              This records that a human published this asset and where it lives. It does not push
              anything to a website, a CMS or an ad platform.
            </DialogDescription>
          </DialogHeader>

          {publishError ? (
            <ErrorState
              error={publishError}
              layout="inline"
              preserveNotice="The asset's lifecycle was not changed."
            />
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="publish-url">Live URL</Label>
            <Input
              id="publish-url"
              value={publishUrl}
              onChange={(event) => setPublishUrl(event.target.value)}
              placeholder="https://example.com/guides/…"
              aria-describedby="publish-url-help"
            />
            <p id="publish-url-help" className="text-meta text-muted-foreground">
              The exact address a reader would open. Leave it empty only if you genuinely do not
              have one yet — recording a status without a URL leaves no way to verify the page.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)} disabled={publishing}>
              Cancel
            </Button>
            <Button onClick={() => void onRecordPublished()} disabled={publishing} aria-busy={publishing}>
              {publishing ? 'Recording…' : 'Record as published'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

// ── Article fields ──────────────────────────────────────────────────────

function ArticleFields({
  fields,
  onChange,
  body,
  onBodyChange,
}: {
  fields: Record<string, unknown>;
  onChange: (fields: Record<string, unknown>) => void;
  body: string;
  onBodyChange: (body: string) => void;
}) {
  const metaDescription = asString(fields.metaDescription);
  const slug = asString(fields.slug);
  const faq = asFaq(fields.faq);
  const jsonLd = fields.jsonLd;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="meta-description">Meta description</Label>
          <Input
            id="meta-description"
            value={metaDescription}
            onChange={(event) => onChange({ ...fields, metaDescription: event.target.value })}
          />
          <p className="text-meta text-muted-foreground">
            {formatNumber(metaDescription.length)} characters — search engines commonly display
            about 150–160.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Proposed slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(event) => onChange({ ...fields, slug: event.target.value })}
          />
          <p className="text-meta text-muted-foreground">
            A suggested path. It is not a live URL until someone publishes it.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="body">Markdown body</Label>
        <Textarea
          id="body"
          rows={18}
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          className="font-mono text-table"
        />
        <p className="text-meta text-muted-foreground">
          “##” subheadings, plain Markdown. Saving stores exactly this text.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>FAQ pairs</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ ...fields, faq: [...faq, { question: '', answer: '' }] })}
          >
            Add pair
          </Button>
        </div>
        {faq.length === 0 ? (
          <p className="text-table text-muted-foreground">
            No FAQ pairs on this revision.
          </p>
        ) : (
          <ul className="space-y-3">
            {faq.map((pair, index) => (
              <li key={index} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-meta text-muted-foreground">Pair {index + 1}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange({ ...fields, faq: faq.filter((_, position) => position !== index) })
                    }
                  >
                    Remove
                  </Button>
                </div>
                <Input
                  aria-label={`Question ${index + 1}`}
                  value={pair.question}
                  onChange={(event) =>
                    onChange({
                      ...fields,
                      faq: faq.map((entry, position) =>
                        position === index ? { ...entry, question: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Textarea
                  aria-label={`Answer ${index + 1}`}
                  rows={3}
                  value={pair.answer}
                  onChange={(event) =>
                    onChange({
                      ...fields,
                      faq: faq.map((entry, position) =>
                        position === index ? { ...entry, answer: event.target.value } : entry,
                      ),
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <Label>JSON-LD</Label>
        <p className="text-meta text-muted-foreground">
          Built deterministically from the article&rsquo;s own fields, so it is shown read-only here
          and saved back unchanged. A schema block must describe the visible facts, and it carries
          no promise of a rich result.
        </p>
        {jsonLd ? (
          <pre className="evidence max-h-72 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3">
            {JSON.stringify(jsonLd, null, 2)}
          </pre>
        ) : (
          <p className="text-table text-muted-foreground">
            No JSON-LD on this revision.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Ad copy variants ────────────────────────────────────────────────────

function AdCopyFields({
  fields,
  onChange,
}: {
  fields: Record<string, unknown>;
  onChange: (fields: Record<string, unknown>) => void;
}) {
  const variants = asVariants(fields.variants);
  const overLimit = variants.filter(
    (variant) =>
      variant.headline.length > HEADLINE_TARGET ||
      variant.description.length > DESCRIPTION_TARGET,
  ).length;

  return (
    <div className="space-y-3">
      {variants.length === 0 ? (
        <p className="text-table text-muted-foreground">
          No ad variants on this revision. Generating ad copy produces four.
        </p>
      ) : null}

      {overLimit > 0 ? (
        <p className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-table text-warning-foreground">
          {overLimit} variant{overLimit === 1 ? '' : 's'} exceed the length the generator targets (
          {HEADLINE_TARGET} / {DESCRIPTION_TARGET} characters). The model is instructed on these
          limits but does not enforce them, and they are not a platform guarantee — check the ad
          platform&rsquo;s own rules before running anything.
        </p>
      ) : null}

      <ul className="space-y-3">
        {variants.map((variant, index) => (
          <li key={index} className="space-y-2 rounded-md border border-border p-3">
            <span className="text-meta text-muted-foreground">Variant {index + 1}</span>
            <div className="space-y-2">
              <Label htmlFor={`headline-${index}`}>Headline</Label>
              <Input
                id={`headline-${index}`}
                value={variant.headline}
                onChange={(event) =>
                  onChange({
                    ...fields,
                    variants: variants.map((entry, position) =>
                      position === index ? { ...entry, headline: event.target.value } : entry,
                    ),
                  })
                }
              />
              <p
                className={
                  variant.headline.length > HEADLINE_TARGET
                    ? 'text-meta text-warning-foreground'
                    : 'text-meta text-muted-foreground'
                }
              >
                {formatNumber(variant.headline.length)} of {HEADLINE_TARGET} characters
                {variant.headline.length > HEADLINE_TARGET ? ' — over' : ''}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`description-${index}`}>Description</Label>
              <Textarea
                id={`description-${index}`}
                rows={2}
                value={variant.description}
                onChange={(event) =>
                  onChange({
                    ...fields,
                    variants: variants.map((entry, position) =>
                      position === index ? { ...entry, description: event.target.value } : entry,
                    ),
                  })
                }
              />
              <p
                className={
                  variant.description.length > DESCRIPTION_TARGET
                    ? 'text-meta text-warning-foreground'
                    : 'text-meta text-muted-foreground'
                }
              >
                {formatNumber(variant.description.length)} of {DESCRIPTION_TARGET} characters
                {variant.description.length > DESCRIPTION_TARGET ? ' — over' : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Conflict ────────────────────────────────────────────────────────────

function ConflictPanel({
  conflict,
  draft,
  isAdCopy,
  onUseServer,
  onKeepMine,
}: {
  conflict: VersionConflict;
  draft: DraftState;
  isAdCopy: boolean;
  onUseServer: () => void;
  onKeepMine: () => void;
}) {
  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="text-subsection">Your save was refused: a newer revision exists</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-2">
        <p className="text-table text-foreground">
          {conflict.message} Nothing was overwritten and nothing was saved. Your draft is still in
          the editor.
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h4 className="text-table font-medium text-foreground">
              Your draft (not saved)
            </h4>
            <pre className="evidence max-h-64 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3">
              {isAdCopy ? adCopyAsText(draft) : draft.body}
            </pre>
          </div>
          <div className="space-y-2">
            <h4 className="text-table font-medium text-foreground">
              Server revision {conflict.currentVersion}
            </h4>
            <pre className="evidence max-h-64 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3">
              {isAdCopy
                ? asVariants(conflict.current?.fields.variants)
                    .map((variant) => `${variant.headline}\n${variant.description}`)
                    .join('\n\n')
                : (conflict.current?.body ?? '')}
            </pre>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" size="sm" onClick={onUseServer}>
            Discard my draft and load revision {conflict.currentVersion}
          </Button>
          <Button variant="outline" size="sm" onClick={onKeepMine}>
            Keep my draft — save it on top of revision {conflict.currentVersion}
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">
          Keeping your draft writes a new revision above the server&rsquo;s. Revision{' '}
          {conflict.currentVersion} itself is never modified, so nothing is destroyed either way —
          but read the two versions before you choose.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function contentHref(projectId: string): string {
  return `/projects/${projectId}/content`;
}

function draftFrom(asset: AssetContent): DraftState {
  const fields = deepCopy(asset.current?.fields ?? {});
  // Pre-G09 content was stored as one flat object on the asset row, so its
  // parsed `fields` still carry the title, the Markdown body and a word count
  // that now have first-class homes on the revision. Sending them back would
  // write a second, staler copy of each into the new revision — a body that no
  // longer matches `body`. The generated shape is
  // { metaDescription, slug, faq, jsonLd } (or { variants }), and that is what
  // a save stores.
  delete fields.bodyMarkdown;
  delete fields.wordCount;
  delete fields.title;
  return {
    title: asset.current?.title ?? asset.title,
    body: asset.current?.body ?? '',
    fields,
  };
}

/** `fields` is stored as JSON, so a shallow copy is enough — but be explicit. */
function deepCopy(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fields ?? {})) as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFaq(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      question: typeof entry.question === 'string' ? entry.question : '',
      answer: typeof entry.answer === 'string' ? entry.answer : '',
    }));
}

function asVariants(value: unknown): Array<{ headline: string; description: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      headline: typeof entry.headline === 'string' ? entry.headline : '',
      description: typeof entry.description === 'string' ? entry.description : '',
    }));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function adCopyAsText(draft: DraftState | { fields: Record<string, unknown> }): string {
  const variants = asVariants(draft.fields.variants);
  return variants.map((variant, index) => `${index + 1}. ${variant.headline}\n${variant.description}`).join('\n\n');
}

/** What "Copy draft" and "Download draft" hand over. */
function buildExport(
  asset: AssetContent,
  draft: DraftState,
  isAdCopy: boolean,
): string {
  const header = [
    `# ${draft.title}`,
    '',
    `Asset type: ${ASSET_TYPE_LABELS[asset.assetType]}`,
    `Cailyx revision: ${asset.currentVersion}`,
    isAdCopy ? null : `Slug: ${asString(draft.fields.slug) || notMeasuredLabel()}`,
    isAdCopy
      ? null
      : `Meta description: ${asString(draft.fields.metaDescription) || notMeasuredLabel()}`,
    '',
    'This is the stored text at the revision above. Edits made outside this export are not saved',
    'back automatically.',
    '',
  ].filter((line): line is string => line !== null);

  if (isAdCopy) {
    return [...header, adCopyAsText(draft)].join('\n');
  }

  const faq = asFaq(draft.fields.faq);
  const jsonLd = draft.fields.jsonLd;

  return [
    ...header,
    draft.body,
    '',
    faq.length > 0
      ? ['## FAQ pairs', '', ...faq.map((pair) => `**${pair.question}**\n\n${pair.answer}`)].join('\n')
      : '',
    '',
    jsonLd
      ? ['## JSON-LD', '', '```json', JSON.stringify(jsonLd, null, 2), '```'].join('\n')
      : '',
  ].join('\n');
}

function exportFilename(asset: AssetContent, draft: DraftState): string {
  const base = (draft.title || asset.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base || 'draft'}-r${asset.currentVersion}.md`;
}

/** A Blob download — no server round-trip, so no request can be mistaken for a save. */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function lifecycleLabel(status: string): string {
  switch (status) {
    case 'recommended':
      return 'Recommended';
    case 'in-progress':
      return 'In progress';
    case 'published':
      return 'Published';
    default:
      return status;
  }
}

function lifecycleTone(status: string) {
  switch (status) {
    case 'published':
      return 'success' as const;
    case 'in-progress':
      return 'info' as const;
    default:
      return 'neutral' as const;
  }
}

function originLabel(origin: ContentRevision['origin']): string {
  switch (origin) {
    case 'generation':
      return 'Generated draft';
    case 'operator-edit':
      return 'Operator edit';
    case 'client-edit':
      return 'Client edit';
    case 'import':
      return 'Imported';
  }
}

function originProvenance(origin: ContentRevision['origin']) {
  switch (origin) {
    case 'generation':
      return 'model-interpretation' as const;
    case 'operator-edit':
    case 'client-edit':
      return 'operator-supplied' as const;
    case 'import':
      return 'derived' as const;
  }
}

function checkResultLabel(result: CopyCheckReport['result']): string {
  switch (result) {
    case 'banned-phrase':
      return 'Banned phrase found';
    case 'ungraded-number':
      return 'Ungraded number';
    case 'single-run-rate':
      return 'Single-run rate';
    case 'passed':
      return 'Passed';
  }
}

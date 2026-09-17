'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatusPill } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  FORMALITY_LABELS,
  FORMALITY_VALUES,
  confirmWritingStyle,
  getActiveWritingStyle,
  getWritingStyleSuggestions,
  listWritingStyleVersions,
  saveWritingStyleDraft,
  type Formality,
  type WritingStyleDraftInput,
  type WritingStyleProfile,
  type WritingStyleSuggestion,
} from '@/services/writing-style';

/**
 * P09 — Writing style (§13.8), a secondary destination in the Content group.
 *
 * §13.8's rule is that **the style generation uses is a confirmed, versioned
 * record**, not the latest thing anyone observed. Three things follow, and each
 * is why a control below behaves the way it does:
 *
 *  1. **A draft changes nothing.** Saving is explicitly "save a draft"; it is
 *     never presented as applying the style. Only Confirm inserts a confirmed
 *     version, and generation jobs pin that version's fingerprint.
 *  2. **Observed style is shown apart from the confirmed profile.**
 *     Suggestions come from a different source (the brand-voice extraction),
 *     and `sufficientData: false` means the sample is too small to summarize
 *     responsibly — so the panel offers manual setup instead of presenting a
 *     thin guess as "your style".
 *  3. **History is readable and restorable.** Editing a confirmed style makes a
 *     new version; the old one is never rewritten. "Restore" therefore saves
 *     that version's content as a fresh draft and confirms it, which is what
 *     the server's contract allows — confirming an already-confirmed row is a
 *     409, not a restore.
 *
 * It is a *project* setting, not a client one: the client portal reads the
 * active confirmed style but never edits it.
 */

interface DraftFields {
  name: string;
  summary: string;
  tone: string;
  formality: Formality;
  audience: string;
  preferredWords: string;
  avoidWords: string;
  exampleSentences: string;
  ctaPreferences: string;
}

const EMPTY_DRAFT: DraftFields = {
  name: '',
  summary: '',
  tone: '',
  formality: 'neutral',
  audience: '',
  preferredWords: '',
  avoidWords: '',
  exampleSentences: '',
  ctaPreferences: '',
};

export default function WritingStylePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [active, setActive] = useState<WritingStyleProfile | null | undefined>(undefined);
  const [versions, setVersions] = useState<WritingStyleProfile[] | null>(null);
  const [suggestions, setSuggestions] = useState<WritingStyleSuggestion[] | null>(null);
  const [suggestionsRefused, setSuggestionsRefused] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [style, history] = await Promise.all([
          getActiveWritingStyle(projectId, { signal }),
          listWritingStyleVersions(projectId, { signal }),
        ]);
        setActive(style);
        setVersions(history.versions);
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
    // Suggestions are a separate read from a separate source, and they are
    // operator-only — a refusal here must not take the page down with it.
    void getWritingStyleSuggestions(projectId, { signal: controller.signal })
      .then((result) => {
        setSuggestions(result);
        setSuggestionsRefused(false);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setSuggestionsRefused(true);
        setSuggestions([]);
      });
    return () => controller.abort();
  }, [load, projectId]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, message?: string) => {
      setBusy(key);
      setActionError(null);
      setNotice(null);
      try {
        await action();
        if (message) setNotice(message);
        await load();
        return true;
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : 'That action could not be completed.');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const toInput = useCallback(
    (fields: DraftFields): WritingStyleDraftInput => ({
      name: fields.name.trim() || 'House style',
      summary: fields.summary.trim() || undefined,
      tone: fields.tone.trim() || undefined,
      formality: fields.formality,
      audience: fields.audience.trim() || undefined,
      // One entry per line: a comma-split would silently mangle a phrase that
      // legitimately contains a comma.
      preferredWords: splitLines(fields.preferredWords),
      avoidWords: splitLines(fields.avoidWords),
      exampleSentences: splitLines(fields.exampleSentences),
      ctaPreferences: fields.ctaPreferences.trim() || undefined,
    }),
    [],
  );

  const saveDraft = useCallback(async () => {
    const saved = await run('save', () => saveWritingStyleDraft(projectId, toInput(draft)));
    if (saved) {
      setEditing(false);
      setNotice('Draft saved. It is not in effect until you confirm it.');
    }
  }, [draft, projectId, run, toInput]);

  const confirmDraft = useCallback(
    async (fields: DraftFields) => {
      // Two explicit steps, in this order, because the server will not confirm
      // a row that is already confirmed and there may be no draft at all.
      const saved = await run('save-confirm', async () => {
        await saveWritingStyleDraft(projectId, toInput(fields));
        await confirmWritingStyle(projectId);
      });
      if (saved) {
        setEditing(false);
        setNotice('Confirmed. New generation jobs pin this version; jobs already running keep the version they started with.');
      }
    },
    [projectId, run, toInput],
  );

  const restore = useCallback(
    async (profile: WritingStyleProfile) => {
      await confirmDraft({
        name: profile.name,
        summary: profile.summary ?? '',
        tone: profile.tone ?? '',
        formality: (FORMALITY_VALUES as readonly string[]).includes(profile.formality)
          ? (profile.formality as Formality)
          : 'neutral',
        audience: profile.audience ?? '',
        preferredWords: (profile.preferredWords ?? []).join('\n'),
        avoidWords: (profile.avoidWords ?? []).join('\n'),
        exampleSentences: (profile.exampleSentences ?? []).join('\n'),
        ctaPreferences: profile.ctaPreferences ?? '',
      });
    },
    [confirmDraft],
  );

  const startFromSuggestion = useCallback((suggestion: WritingStyleSuggestion) => {
    setDraft({
      ...EMPTY_DRAFT,
      name: 'House style',
      summary: suggestion.summary ?? '',
      tone: suggestion.tone.join(', '),
      preferredWords: suggestion.vocabulary.join('\n'),
      ctaPreferences: suggestion.callToActions.join(', '),
    });
    setEditing(true);
    setNotice('Loaded into the draft below. Nothing is saved or in effect until you save and confirm.');
  }, []);

  const pendingDrafts = useMemo(
    () => (versions ?? []).filter((version) => version.confirmedAt === null),
    [versions],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Writing style" />
        <ErrorState error={error} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Content', href: `/projects/${projectId}/content` },
          { label: 'Writing style' },
        ]}
        title="Writing style"
        context="The confirmed voice generated content is written in. Versioned, so a job always pins the style it actually used."
        secondaryActions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${projectId}/content`}>Content</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
              Reload
            </Button>
          </div>
        }
      />

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>That action did not complete</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* ── the confirmed style, or the honest absence of one ─────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-subsection">In effect</CardTitle>
              {active === undefined ? null : active ? (
                <StatusPill label={`Confirmed · v${active.version}`} tone="success" />
              ) : (
                <StatusPill label="No confirmed style" tone="warning" />
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {active === undefined ? (
                <Skeleton className="h-32 rounded-lg" />
              ) : active ? (
                <>
                  <p className="text-table text-foreground">{active.name}</p>
                  {active.summary ? (
                    <p className="text-table text-muted-foreground">{active.summary}</p>
                  ) : (
                    <p className="text-meta text-muted-foreground">No summary was written for this version.</p>
                  )}
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <Field label="Tone" value={active.tone} />
                    <Field
                      label="Formality"
                      value={FORMALITY_LABELS[active.formality as Formality] ?? active.formality}
                    />
                    <Field label="Audience" value={active.audience} />
                    <Field label="Call to action" value={active.ctaPreferences} />
                    <Field
                      label="Preferred words"
                      value={active.preferredWords.length > 0 ? active.preferredWords.join(', ') : null}
                    />
                    <Field
                      label="Words to avoid"
                      value={active.avoidWords.length > 0 ? active.avoidWords.join(', ') : null}
                    />
                    <Field
                      label="Example sentences"
                      value={
                        active.exampleSentences.length > 0 ? active.exampleSentences.join(' · ') : null
                      }
                      wide
                    />
                  </dl>
                  <p className="text-meta text-muted-foreground">
                    Confirmed <Timestamp value={active.confirmedAt ?? active.createdAt} /> · fingerprint{' '}
                    <code className="text-meta">{active.fingerprint.slice(0, 12)}…</code>. A generation
                    job pins this fingerprint, so editing the style later cannot silently change a job
                    that has already started.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft({
                        name: active.name,
                        summary: active.summary ?? '',
                        tone: active.tone ?? '',
                        formality: (FORMALITY_VALUES as readonly string[]).includes(active.formality)
                          ? (active.formality as Formality)
                          : 'neutral',
                        audience: active.audience ?? '',
                        preferredWords: active.preferredWords.join('\n'),
                        avoidWords: active.avoidWords.join('\n'),
                        exampleSentences: active.exampleSentences.join('\n'),
                        ctaPreferences: active.ctaPreferences ?? '',
                      });
                      setEditing(true);
                    }}
                  >
                    Edit as a new version
                  </Button>
                </>
              ) : (
                <EmptyState
                  variant="not-measured"
                  subject="a confirmed writing style"
                  prerequisite="write one below, or accept what the brand-voice analysis found"
                  action={{ label: 'Write one now', onClick: () => setEditing(true) }}
                >
                  Generation still works without one — it just writes in a neutral voice, and this
                  page is where that changes. Nothing here invents a style from thin material.
                </EmptyState>
              )}
            </CardContent>
          </Card>

          {/* ── draft editor ─────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-subsection">
                {editing ? 'Draft a version' : 'Change the style'}
              </CardTitle>
              {editing ? null : (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
                  New draft
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {!editing ? (
                <p className="text-table text-muted-foreground">
                  {pendingDrafts.length > 0
                    ? `${pendingDrafts.length} draft${pendingDrafts.length === 1 ? '' : 's'} saved and not in effect. Continue one below, or confirm it as-is.`
                    : 'Saving creates a draft version. Nothing changes for generation until a version is confirmed.'}
                </p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      id="style-name"
                      label="Name"
                      value={draft.name}
                      placeholder="House style"
                      onChange={(name) => setDraft((current) => ({ ...current, name }))}
                    />
                    <TextField
                      id="style-tone"
                      label="Tone"
                      value={draft.tone}
                      placeholder="Direct, warm, no hype"
                      onChange={(tone) => setDraft((current) => ({ ...current, tone }))}
                    />
                    <div className="space-y-1.5">
                      <Label htmlFor="style-formality">Formality</Label>
                      <Select
                        value={draft.formality}
                        onValueChange={(next) =>
                          setDraft((current) => ({ ...current, formality: next as Formality }))
                        }
                      >
                        <SelectTrigger id="style-formality">
                          <SelectValue>{FORMALITY_LABELS[draft.formality]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FORMALITY_VALUES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {FORMALITY_LABELS[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <TextField
                      id="style-audience"
                      label="Audience"
                      value={draft.audience}
                      placeholder="Operations managers at mid-size logistics firms"
                      onChange={(audience) => setDraft((current) => ({ ...current, audience }))}
                    />
                  </div>

                  <TextAreaField
                    id="style-summary"
                    label="Summary"
                    rows={3}
                    value={draft.summary}
                    hint="One or two sentences a writer can follow. Shown to clients as the description of their voice."
                    onChange={(summary) => setDraft((current) => ({ ...current, summary }))}
                  />
                  <TextAreaField
                    id="style-preferred"
                    label="Preferred words"
                    rows={3}
                    value={draft.preferredWords}
                    hint="One per line. These are guidance, not a ban on synonyms."
                    onChange={(preferredWords) => setDraft((current) => ({ ...current, preferredWords }))}
                  />
                  <TextAreaField
                    id="style-avoid"
                    label="Words to avoid"
                    rows={3}
                    value={draft.avoidWords}
                    hint="One per line. Add the reason in the summary if it matters — a bare list invites the wrong substitution."
                    onChange={(avoidWords) => setDraft((current) => ({ ...current, avoidWords }))}
                  />
                  <TextAreaField
                    id="style-examples"
                    label="Example sentences"
                    rows={3}
                    value={draft.exampleSentences}
                    hint="One per line, as the house would actually write them."
                    onChange={(exampleSentences) =>
                      setDraft((current) => ({ ...current, exampleSentences }))
                    }
                  />
                  <TextAreaField
                    id="style-cta"
                    label="Call to action"
                    rows={2}
                    value={draft.ctaPreferences}
                    hint="How the business asks for the next step, and how it does not."
                    onChange={(ctaPreferences) => setDraft((current) => ({ ...current, ctaPreferences }))}
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => void saveDraft()} disabled={busy !== null}>
                      {busy === 'save' ? 'Saving…' : 'Save as draft'}
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => void confirmDraft(draft)}
                      disabled={busy !== null}
                    >
                      {busy === 'save-confirm' ? 'Confirming…' : 'Save and confirm'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraft(EMPTY_DRAFT);
                      }}
                      disabled={busy !== null}
                    >
                      Discard this draft
                    </Button>
                  </div>
                  <p className="text-meta text-muted-foreground">
                    “Save as draft” stores a candidate and changes nothing. “Save and confirm” stores
                    it and makes it the version new generation jobs pin.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* ── observed style, kept separate ────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">What the brand-voice analysis found</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {suggestionsRefused ? (
                <p className="text-meta text-muted-foreground">
                  Not available to your role. It is a separate read from the confirmed style, so its
                  absence does not affect anything above.
                </p>
              ) : suggestions === null ? (
                <Skeleton className="h-24 rounded-lg" />
              ) : suggestions.length === 0 ? (
                <p className="text-meta text-muted-foreground">
                  Nothing observed yet. This comes from the brand-voice extraction on the presence
                  data — run that first, or write the style by hand above.
                </p>
              ) : (
                suggestions.map((suggestion) => (
                  <div key={suggestion.presenceBrandVoiceId} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-table font-medium text-foreground">
                        {suggestion.extraction}
                      </span>
                      <StatusPill
                        label={suggestion.sufficientData ? 'Enough material' : 'Too thin to rely on'}
                        tone={suggestion.sufficientData ? 'info' : 'warning'}
                      />
                    </div>
                    {suggestion.sufficientData ? (
                      <>
                        {suggestion.summary ? (
                          <p className="text-table text-muted-foreground">{suggestion.summary}</p>
                        ) : null}
                        <p className="text-meta text-muted-foreground">
                          Tone: {suggestion.tone.join(', ') || 'not detected'} ·{' '}
                          {suggestion.sampleSize} samples · <Timestamp value={suggestion.createdAt} />
                        </p>
                        <Button variant="outline" size="sm" onClick={() => startFromSuggestion(suggestion)}>
                          <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
                          Use as a starting draft
                        </Button>
                      </>
                    ) : (
                      <p className="text-meta text-muted-foreground">
                        {suggestion.sampleSize} samples is too little to describe as this business’s
                        style. Writing one by hand is the honest option — a summary from this would
                        be a guess wearing a label.
                      </p>
                    )}
                  </div>
                ))
              )}
              <p className="text-meta text-muted-foreground">
                Observed style never becomes the active style on its own. It is evidence, and
                confirming is a decision a person makes.
              </p>
            </CardContent>
          </Card>

          {/* ── version history ──────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-subsection">Versions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {versions === null ? (
                <Skeleton className="h-24 rounded-lg" />
              ) : versions.length === 0 ? (
                <p className="text-meta text-muted-foreground">No version has been saved yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {versions.map((version) => (
                    <li key={version.id} className="space-y-1 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-table text-foreground">
                          v{version.version} · {version.name}
                        </span>
                        <StatusPill
                          label={version.confirmedAt ? 'Confirmed' : 'Draft'}
                          tone={version.confirmedAt ? 'success' : 'neutral'}
                        />
                      </div>
                      <p className="text-meta text-muted-foreground">
                        {version.sourceType === 'suggested-accepted' ? 'From a suggestion' : 'Written by hand'} ·{' '}
                        <Timestamp value={version.confirmedAt ?? version.createdAt} />
                        {version.confirmedAt ? ' confirmed' : ' saved'}
                        {active && version.id === active.id ? ' · in effect' : ''}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {version.confirmedAt === null ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void run('confirm', () => confirmWritingStyle(projectId, version.version), `Version ${version.version} is now in effect.`)}
                          >
                            Confirm this draft
                          </Button>
                        ) : version.id === active?.id ? null : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void restore(version)}
                          >
                            Restore as a new version
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-meta text-muted-foreground">
                Confirming never edits an older row: the previous versions stay exactly as they were,
                which is what makes a queued job&apos;s pinned version meaningful.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function Field({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="text-table text-foreground">{value ?? 'Not recorded'}</dd>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function TextAreaField({
  id,
  label,
  value,
  rows,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  rows: number;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

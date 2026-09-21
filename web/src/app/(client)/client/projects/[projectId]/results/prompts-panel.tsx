'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import {
  createPortalPromptRequest,
  listPortalPromptRequests,
  listPortalPrompts,
  type PortalPromptRequest,
  type PortalQuerySet,
} from '@/services/portal';

/**
 * C4 (client-portal.md §13, §20) — the client's read-only view of their real,
 * active prompt list, plus the lightweight add/delete request mechanism.
 *
 * Deliberately not a "prompts" page of its own: §13 stays read-only for the
 * client and the request mechanism is intentionally lighter than the
 * Approval/review flow content gets, so it lives as a section of the page
 * that already shows what these prompts produced (AI visibility results),
 * rather than as a 9th top-level nav destination.
 */
export function PromptsPanel({ projectId }: { projectId: string }) {
  const [sets, setSets] = useState<PortalQuerySet[] | null>(null);
  const [requests, setRequests] = useState<PortalPromptRequest[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setError(null);
        const [nextSets, nextRequests] = await Promise.all([
          listPortalPrompts(projectId, { signal }),
          listPortalPromptRequests(projectId, { signal }),
        ]);
        setSets(nextSets);
        setRequests(nextRequests);
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

  const items = useMemo(
    () => (sets ?? []).flatMap((set) => set.items.map((item) => ({ ...item, persona: set.persona }))),
    [sets],
  );

  const handleSubmitted = useCallback(
    (created: PortalPromptRequest) => {
      setRequests((current) => (current ? [created, ...current] : [created]));
      setOpen(false);
    },
    [],
  );

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-subsection">Prompts</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState error={error} onRetry={() => void load()} showServerMessage={false} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-subsection">Prompts</CardTitle>
          <p className="mt-1 text-meta text-muted-foreground">
            {sets === null
              ? 'Loading your active prompt set…'
              : `${items.length} prompt${items.length === 1 ? '' : 's'} across ${sets.length} active set${sets.length === 1 ? '' : 's'} — the exact questions we measure.`}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              Request a change
            </Button>
          </DialogTrigger>
          <DialogContent>
            <RequestPromptChangeForm
              projectId={projectId}
              items={items}
              onSubmitted={handleSubmitted}
            />
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-6">
        {sets === null ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            variant="not-measured"
            subject="an active prompt set"
            prerequisite="Your delivery team activates the first set during onboarding."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-table">{item.prompt}</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {humanizeStage(item.persona)} · {humanizeStage(item.funnelStage)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-meta text-muted-foreground">
          Prompts are read-only here — your team adds or removes them for you. Propose a new one or
          flag one for removal with &ldquo;Request a change&rdquo; above.
        </p>

        {requests && requests.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-table font-semibold">Your requests</h3>
            <ul className="space-y-2">
              {requests.map((req) => (
                <li key={req.id} className="rounded-lg border px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-table">
                      <span className="font-medium">{req.action === 'add' ? 'Add' : 'Remove'}:</span>{' '}
                      {req.action === 'add' ? req.prompt : req.targetPromptText}
                    </p>
                    <StatusPill label={humanizeStage(req.status)} tone={requestTone(req.status)} />
                  </div>
                  <p className="mt-1 text-meta text-muted-foreground">
                    Requested <Timestamp value={req.createdAt} />
                    {req.overQuota ? ' · this would exceed your plan\'s prompt limit' : ''}
                  </p>
                  {req.decisionNote ? (
                    <p className="mt-1 text-meta text-muted-foreground">Note: {req.decisionNote}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestPromptChangeForm({
  projectId,
  items,
  onSubmitted,
}: {
  projectId: string;
  items: Array<{ id: string; prompt: string; persona: string }>;
  onSubmitted: (created: PortalPromptRequest) => void;
}) {
  const [action, setAction] = useState<'add' | 'remove'>('add');
  const [prompt, setPrompt] = useState('');
  const [persona, setPersona] = useState<string>('problem-aware');
  const [targetItemId, setTargetItemId] = useState<string>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<PortalPromptRequest | null>(null);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    if (action === 'add' && prompt.trim().length < 5) {
      setSubmitError('Write out the question you want us to track (at least 5 characters).');
      return;
    }
    if (action === 'remove' && !targetItemId) {
      setSubmitError('Pick which prompt to flag for removal.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await createPortalPromptRequest(projectId, {
        action,
        prompt: action === 'add' ? prompt.trim() : undefined,
        persona: action === 'add' ? persona : undefined,
        targetItemId: action === 'remove' ? targetItemId : undefined,
        note: note.trim() || undefined,
      });
      setResult(created);
      onSubmitted(created);
    } catch (caught) {
      setSubmitError(toApiError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }, [action, note, onSubmitted, persona, prompt, projectId, targetItemId]);

  if (result) {
    return (
      <div className="space-y-4">
        <DialogHeader>
          <DialogTitle>Request sent</DialogTitle>
        </DialogHeader>
        <Alert>
          <Info aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>Your team will review this</AlertTitle>
          <AlertDescription>
            {result.overQuota
              ? "This would put you over your plan's prompt limit — your team will follow up about upgrading."
              : "We'll let you know once it's acted on."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>Request a prompt change</DialogTitle>
        <DialogDescription>
          Propose a new question to track, or flag an existing one for removal. Your team makes the
          actual change.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <RadioGroup value={action} onValueChange={(v) => setAction(v as 'add' | 'remove')} className="flex gap-6">
          <div className="flex items-center gap-2">
            <RadioGroupItem value="add" id="prompt-action-add" />
            <Label htmlFor="prompt-action-add">Add a new prompt</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="remove" id="prompt-action-remove" />
            <Label htmlFor="prompt-action-remove">Remove an existing prompt</Label>
          </div>
        </RadioGroup>

        {action === 'add' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="prompt-text">The question</Label>
              <Textarea
                id="prompt-text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. What's the best CRM for a 10-person sales team?"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-persona">Buyer stage</Label>
              <Select value={persona} onValueChange={setPersona}>
                <SelectTrigger id="prompt-persona">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="problem-aware">Problem-aware</SelectItem>
                  <SelectItem value="solution-aware">Solution-aware</SelectItem>
                  <SelectItem value="product-aware">Product-aware</SelectItem>
                  <SelectItem value="most-aware">Most-aware</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="prompt-target">Which prompt?</Label>
            <Select value={targetItemId} onValueChange={setTargetItemId}>
              <SelectTrigger id="prompt-target">
                <SelectValue placeholder="Choose a prompt" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.prompt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="prompt-note">Note (optional)</Label>
          <Textarea id="prompt-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>

        {submitError ? <p className="text-meta text-destructive">{submitError}</p> : null}
      </div>

      <DialogFooter>
        <Button onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? 'Sending…' : 'Send request'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function humanizeStage(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function requestTone(status: string): StatusTone {
  if (status === 'approved') return 'success';
  if (status === 'declined') return 'danger';
  return 'info';
}

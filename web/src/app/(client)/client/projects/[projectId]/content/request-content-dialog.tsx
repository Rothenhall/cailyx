'use client';

import { useCallback, useState } from 'react';
import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toApiError } from '@/components/patterns/ErrorState';
import { createPortalContentRequest, type ContentRequestPriority, type PortalContentRequest } from '@/services/portal';

/**
 * C4 (client-portal.md §14, §22) — structured "request new content" form.
 *
 * The type list mirrors `CONTENT_WORKSPACE_ASSET_TYPES`
 * (`backend/src/modules/content-workspace/content-workspace.types.ts`)
 * exactly — the same six types the workspace already tracks as content,
 * never a separately invented taxonomy. Submitting creates a real
 * content-workspace item immediately (§22): it will not appear in "Shared
 * with you" above until your team shares a revision, same as any other
 * piece — this dialog just confirms the request was received.
 */
const CONTENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'article', label: 'Article / Guide' },
  { value: 'landing-page', label: 'Landing page' },
  { value: 'faq', label: 'FAQ / Knowledge content' },
  { value: 'email-campaign', label: 'Email campaign' },
  { value: 'social-content', label: 'Social content' },
  { value: 'ad-copy', label: 'Ad copy' },
];

const PRIORITY_OPTIONS: Array<{ value: ContentRequestPriority; label: string }> = [
  { value: 'low', label: 'Low — no rush' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High — time-sensitive' },
];

export function RequestContentDialog({
  projectId,
  onSubmitted,
}: {
  projectId: string;
  onSubmitted?: (created: PortalContentRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [contentType, setContentType] = useState('article');
  const [topic, setTopic] = useState('');
  const [priority, setPriority] = useState<ContentRequestPriority>('normal');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<PortalContentRequest | null>(null);

  const reset = useCallback(() => {
    setContentType('article');
    setTopic('');
    setPriority('normal');
    setNote('');
    setSubmitError(null);
    setResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) reset();
    },
    [reset],
  );

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    if (topic.trim().length < 2) {
      setSubmitError('Tell us the target keyword or topic.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await createPortalContentRequest(projectId, {
        contentType,
        topic: topic.trim(),
        priority,
        note: note.trim() || undefined,
      });
      setResult(created);
      onSubmitted?.(created);
    } catch (caught) {
      setSubmitError(toApiError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }, [contentType, note, onSubmitted, priority, projectId, topic]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">Request new content</Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Request sent</DialogTitle>
            </DialogHeader>
            <Alert>
              <Info aria-hidden="true" className="h-4 w-4" />
              <AlertTitle>Your delivery team has it</AlertTitle>
              <AlertDescription>
                It&apos;s in the queue as soon as they pick it up. It will show up here, in Content,
                once they share a draft with you.
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Request new content</DialogTitle>
              <DialogDescription>
                Tell us what to write and we&apos;ll get it into the plan.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="content-request-type">Content type</Label>
                <Select value={contentType} onValueChange={setContentType}>
                  <SelectTrigger id="content-request-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTENT_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="content-request-topic">Target keyword or topic</Label>
                <Input
                  id="content-request-topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. best CRM for small law firms"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="content-request-priority">Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as ContentRequestPriority)}>
                  <SelectTrigger id="content-request-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="content-request-note">Anything else? (optional)</Label>
                <Textarea
                  id="content-request-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="Angle, must-cover points, links to include…"
                />
              </div>

              {submitError ? <p className="text-meta text-destructive">{submitError}</p> : null}
            </div>

            <DialogFooter>
              <Button onClick={() => void handleSubmit()} disabled={submitting}>
                {submitting ? 'Sending…' : 'Send request'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

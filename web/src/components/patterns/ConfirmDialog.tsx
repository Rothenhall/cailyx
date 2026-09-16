'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { RunEstimate } from '@/types';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { RunEstimateSummary } from '@/components/patterns/RunConfigurator';

/**
 * §3.3 Confirmation dialog — exact target, effect, scope, cost if known, with
 * explicit destructive wording.
 *
 * §10.4's "Delete/cascade" row is the strictest case this component serves:
 * *"Exact target and downstream effect, destructive confirmation; no fake
 * undo."* Two consequences are baked in rather than left to callers:
 *
 *  - **A destructive action requires a typed confirmation of the target.** It
 *    is not enough to click a red button; the operator types the name of the
 *    thing being destroyed, which is what prevents "wrong row, right dialog".
 *  - **No undo is offered.** The copy states plainly that there is none,
 *    because a disabled "Undo" affordance or a hopeful toast is a lie about
 *    what the server did.
 *
 * Construction is `ui/alert-dialog`, which is the Radix alert dialog: focus is
 * trapped inside while open and returned to the element that opened it on
 * close (§3.4), and it has the alertdialog role a plain dialog does not.
 *
 * `confirmLabel` is required and must name the action — "Delete project", not
 * "OK". The label is the last thing an operator reads before an irreversible
 * change, so a generic word here is a defect, not a style choice.
 */

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the dialog is asking about, e.g. "Delete project". */
  title: string;
  /**
   * The confirm button's label. Must name the action — "Delete project",
   * "Replace competitor list", "Publish report". Never "OK"/"Yes"/"Confirm".
   */
  confirmLabel: string;
  /** The mutation. A rejection is shown in place and the dialog stays open. */
  onConfirm: () => void | Promise<void>;
  /** Called after the server accepted. Use it to close, refetch, or navigate. */
  onConfirmed?: () => void;
  cancelLabel?: string;
  /** Label for the exact target, e.g. "Project", "Report", "Competitor list". */
  targetLabel?: string;
  /**
   * The exact target being acted on, verbatim. For a destructive action this
   * string is also what the operator must type to confirm.
   */
  target?: string;
  /** What will happen as a result. Required for destructive actions. */
  effect?: ReactNode;
  /** How far the effect reaches, e.g. "Deletes 3 projects, 41 reports and all
   *  message history for this client." */
  scope?: ReactNode;
  /** Known cost, rendered with credits and currency kept separate. */
  cost?: RunEstimate;
  /** Marks an irreversible action: destructive styling, destructive wording,
   *  and a required typed confirmation. */
  destructive?: boolean;
  /**
   * Overrides the phrase the operator must type. Defaults to `target` for a
   * destructive action. Supply one only when the safe phrase is not the target
   * name (e.g. a typed confirmation of the client name for a project delete).
   */
  confirmPhrase?: string;
  /** Forwarded to `ErrorState` when the mutation returns a 409, so the
   *  operator can reconcile instead of retrying blindly. */
  onReload?: () => void;
  /** Rendered under the facts, e.g. a link into the affected records. */
  children?: ReactNode;
  className?: string;
}

/**
 * A confirmation dialog that states the target, effect, scope and cost before
 * an irreversible mutation.
 *
 * ```tsx
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Delete project"
 *   targetLabel="Project"
 *   target={project.name}
 *   effect="The project, its runs and its reports are removed for everyone."
 *   destructive
 *   confirmLabel="Delete project"
 *   onConfirm={() => deleteProject(project.id)}
 * />
 * ```
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
  onConfirmed,
  cancelLabel = 'Cancel',
  targetLabel,
  target,
  effect,
  scope,
  cost,
  destructive = false,
  confirmPhrase,
  onReload,
  children,
  className,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const pendingRef = useRef(false);

  // A reopened dialog must not remember the previous target's typed phrase.
  useEffect(() => {
    if (!open) {
      setTyped('');
      setError(null);
      setPending(false);
      pendingRef.current = false;
    }
  }, [open]);

  const requiredPhrase = confirmPhrase ?? (destructive ? target : undefined);
  const needsTyping = destructive || confirmPhrase !== undefined;
  const phraseMatches = !needsTyping || (requiredPhrase !== undefined && typed === requiredPhrase);
  // If a destructive dialog was built without a target or phrase, there is no
  // way to ask for a typed confirmation — say so instead of quietly allowing
  // an unconfirmed destructive action.
  const missingPhraseSource = needsTyping && requiredPhrase === undefined;

  const handleConfirm = async () => {
    if (pendingRef.current || !phraseMatches || missingPhraseSource) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onConfirmed?.();
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      if (!aborted) setError(toApiError(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const descriptionId = 'confirm-dialog-summary';
  const phraseHelpId = needsTyping ? 'confirm-dialog-phrase-help' : undefined;

  return (
    <AlertDialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <AlertDialogContent className={cn('max-w-lg', className)} aria-describedby={descriptionId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription id={descriptionId}>
            {target
              ? `This confirms one specific ${targetLabel?.toLowerCase() ?? 'item'}: ${target}.`
              : 'This confirms one specific action. Check the details before continuing.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-table">
          {target && (
            <div className="rounded-md border border-border-strong bg-surface-sunken px-3 py-2">
              <p className="text-meta text-muted-foreground">
                {targetLabel ?? 'Target'} — exact target
              </p>
              <p className="break-words font-medium text-foreground">{target}</p>
            </div>
          )}

          {effect && (
            <div>
              <p className="text-meta text-muted-foreground">Effect</p>
              <div className="text-foreground">{effect}</div>
            </div>
          )}

          {scope && (
            <div>
              <p className="text-meta text-muted-foreground">Scope</p>
              <div className="text-foreground">{scope}</div>
            </div>
          )}

          {cost && (
            <div>
              <p className="text-meta text-muted-foreground">Cost</p>
              <RunEstimateSummary estimate={cost} />
            </div>
          )}

          {destructive && (
            <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-danger-foreground">
              This cannot be undone. Cailyx keeps no restore point for this action, so there is no
              undo to offer afterwards.
            </p>
          )}

          {children}

          {needsTyping && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-typed">
                {missingPhraseSource
                  ? 'This action needs a typed confirmation, but no target was provided.'
                  : `Type ${requiredPhrase} to confirm`}
              </Label>
              <Input
                id="confirm-typed"
                value={typed}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={missingPhraseSource || pending}
                aria-describedby={phraseHelpId}
                aria-invalid={!phraseMatches && typed.length > 0}
                onChange={(event) => setTyped(event.target.value)}
              />
              <p id={phraseHelpId} className="text-meta text-muted-foreground">
                The {confirmLabel.toLowerCase()} button stays disabled until this matches exactly.
              </p>
            </div>
          )}

          {error && <ErrorState error={error} layout="inline" onReload={onReload} />}

          {pending && (
            <p role="status" aria-live="polite" className="text-meta text-muted-foreground">
              Sending the request. Do not close this window.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          {/* Deliberately a plain Button rather than AlertDialogAction: Radix's
              Action closes on click, and this dialog must stay open while the
              mutation is in flight and if it fails. */}
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void handleConfirm()}
            disabled={pending || !phraseMatches || missingPhraseSource}
            aria-busy={pending}
          >
            {pending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

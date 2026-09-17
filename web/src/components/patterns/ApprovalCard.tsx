'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CalendarClock, ExternalLink, Info } from 'lucide-react';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ApprovalDecision, ApprovalItem } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import {
  APPROVAL_DECISION_LABEL,
  StatusPill,
  approvalDecisionTone,
} from '@/components/patterns/StatusPill';
import { ErrorState, toApiError } from '@/components/patterns/ErrorState';
import { Timestamp } from '@/components/patterns/Timestamp';

/**
 * §3.3 Approval card — exact version, requestor, reviewer, due date, decision
 * requested, consequence of delay.
 *
 * The version is the point of the whole component, so it is the largest thing
 * on the card and the decision controls are stated to bind to it: an approval
 * is not "I approve this article", it is "I approve *this version of* this
 * article". A card that buries the version invites a reviewer to approve v2
 * while reading v3, which is a correctness bug in the product, not a layout
 * preference.
 *
 * Two facts the backend may not supply are handled explicitly rather than
 * quietly dropped: an unassigned reviewer and an unstated delay consequence
 * both render as "not stated" text, because a blank space reads as "nothing to
 * worry about".
 */

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** IANA zone for the due date; defaults to the viewer's. */
  timeZone?: string;
  /** Records a decision. Rejections are shown in place. */
  /**
   * Records a decision.
   *
   * Typed `Exclude<ApprovalDecision, 'pending'>` on purpose: `ApprovalDecision`
   * is the *state* union (it includes `pending`), but `pending` is not a
   * decision anyone records — it is the absence of one. Passing the wider union
   * forced every handler to narrow out a member the component can never send,
   * which is the component leaking its own vocabulary onto its callers.
   */
  onDecide?: (decision: Exclude<ApprovalDecision, 'pending'>) => void | Promise<void>;
  /**
   * The decisions this viewer may record. Defaults to approve / request
   * changes / reject; narrow it for a client who cannot reject outright.
   * `pending` is never a decision a user records.
   */
  allowedDecisions?: ReadonlyArray<Exclude<ApprovalDecision, 'pending'>>;
  /** Opens the artifact at this exact version. Pass a route or an external
   *  URL; the reviewer must be able to read what they are approving. */
  href?: string;
  /** Non-route alternative to `href`. */
  onOpenVersion?: () => void;
  /** Assigns a reviewer when `item.reviewer` is unset. */
  onAssignReviewer?: () => void;
  /** Extra context under the facts — a change summary, a diff link. */
  children?: ReactNode;
  className?: string;
}

const DEFAULT_DECISIONS: ReadonlyArray<Exclude<ApprovalDecision, 'pending'>> = [
  'approved',
  'changes-requested',
  'rejected',
];

/**
 * One approval request. Renders the version under review, who asked, who must
 * decide, by when, what is being asked, and what happens if nobody decides.
 */
export function ApprovalCard({
  item,
  timeZone,
  onDecide,
  allowedDecisions = DEFAULT_DECISIONS,
  href,
  onOpenVersion,
  onAssignReviewer,
  children,
  className,
}: ApprovalCardProps) {
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const pendingRef = useRef(false);

  const isPending = item.decision === 'pending';
  const canDecide = isPending && Boolean(onDecide);

  const handleDecide = async (decision: Exclude<ApprovalDecision, 'pending'>) => {
    if (!onDecide || pendingRef.current) return;
    pendingRef.current = true;
    setPending(decision);
    setError(null);
    try {
      await onDecide(decision);
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === 'AbortError';
      if (!aborted) setError(toApiError(cause));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="gap-3 space-y-0 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The version, deliberately the most prominent element. */}
            <p className="text-meta uppercase tracking-wide text-muted-foreground">
              Version under review
            </p>
            <p className="break-words text-subsection font-semibold text-foreground">
              {item.version}
            </p>
          </div>
          <StatusPill
            label={APPROVAL_DECISION_LABEL[item.decision]}
            tone={approvalDecisionTone(item.decision)}
          />
        </div>

        <p className="flex items-start gap-1.5 text-meta text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {isPending
              ? 'A decision applies to this version only. If the item changes, a new decision is required.'
              : `This decision was recorded against ${item.version}. Any later version needs its own decision.`}
          </span>
        </p>
      </CardHeader>

      <CardContent className="space-y-3 pb-4">
        <dl className="grid gap-x-6 gap-y-2 text-table sm:grid-cols-2">
          <div>
            <dt className="text-meta text-muted-foreground">Requested by</dt>
            <dd className="text-foreground">{item.requestor}</dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Reviewer</dt>
            <dd className="text-foreground">
              {item.reviewer ?? (
                <span className="text-unmeasured-foreground">
                  No reviewer assigned
                  {onAssignReviewer && (
                    <>
                      {' — '}
                      <button
                        type="button"
                        onClick={onAssignReviewer}
                        className="text-primary underline underline-offset-4"
                      >
                        assign one
                      </button>
                    </>
                  )}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Due</dt>
            <dd className="text-foreground">
              {item.dueDate ? (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                  <Timestamp value={item.dueDate} dateOnly timeZone={timeZone} />
                </span>
              ) : (
                <span className="text-muted-foreground">No due date set</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-meta text-muted-foreground">Decision requested</dt>
            <dd className="text-foreground">{item.decisionRequested}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-meta text-muted-foreground">If no decision is made by the due date</dt>
            <dd className={cn(item.delayConsequence ? 'text-foreground' : 'text-muted-foreground')}>
              {/* Never invented: an unstated consequence is stated as unstated. */}
              {item.delayConsequence ?? 'Not stated by the requestor — confirm before the due date.'}
            </dd>
          </div>
        </dl>

        {children}

        {(href || onOpenVersion) && (
          <div>
            {href ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href}>
                  <ExternalLink aria-hidden="true" />
                  Open {item.version}
                </Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={onOpenVersion}>
                <ExternalLink aria-hidden="true" />
                Open {item.version}
              </Button>
            )}
          </div>
        )}

        {error && <ErrorState error={error} layout="inline" />}
      </CardContent>

      {canDecide && (
        <CardFooter className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {allowedDecisions.includes('approved') && (
            <Button
              type="button"
              onClick={() => void handleDecide('approved')}
              disabled={pending !== null}
              aria-busy={pending === 'approved'}
            >
              {pending === 'approved' ? 'Recording…' : `Approve ${item.version}`}
            </Button>
          )}
          {allowedDecisions.includes('changes-requested') && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleDecide('changes-requested')}
              disabled={pending !== null}
              aria-busy={pending === 'changes-requested'}
            >
              {pending === 'changes-requested' ? 'Recording…' : 'Request changes'}
            </Button>
          )}
          {allowedDecisions.includes('rejected') && (
            <Button
              type="button"
              variant="outline"
              className="border-danger/40 text-danger-foreground hover:bg-danger-subtle"
              onClick={() => void handleDecide('rejected')}
              disabled={pending !== null}
              aria-busy={pending === 'rejected'}
            >
              {pending === 'rejected' ? 'Recording…' : 'Reject'}
            </Button>
          )}
          {pending !== null && (
            <span role="status" aria-live="polite" className="text-meta text-muted-foreground">
              Sending the decision. It is not recorded until the server confirms.
            </span>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

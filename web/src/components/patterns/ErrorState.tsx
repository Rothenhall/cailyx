'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Lock,
  RefreshCcw,
  SearchX,
  ServerCrash,
  ShieldAlert,
  Timer,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * §3.5 / §10.4 ErrorState — one renderer per `ApiError.kind`.
 *
 * design_plan.md §10.4 assigns each status class a *behavior*, not just a
 * message, and §3.5 adds two rules that are easy to get wrong in a screen:
 *
 *  - a 403 must explain the restriction and **must not retry on a loop**, so
 *    this component renders no retry control for it, whatever the caller
 *    passes;
 *  - a 429 is a *bounded* cooldown that honors `Retry-After`, so the retry
 *    control stays disabled until that period has actually elapsed.
 *
 * Every other class preserves page context (the caller keeps rendering its
 * surrounding content) and, where work is kept, says so via `preserveNotice`.
 */

/** The cooldown above this many seconds is shown as "about N minutes" rather
 *  than a per-second countdown — a ticking number for an hour-long wait is
 *  noise, and a per-second live region would be worse. */
const COUNTDOWN_TICK_LIMIT_SECONDS = 120;

type ErrorTone = 'danger' | 'warning' | 'info' | 'unmeasured';

const TONE_WRAP: Record<ErrorTone, string> = {
  danger: 'border-danger/30 bg-danger-subtle',
  warning: 'border-warning/30 bg-warning-subtle',
  info: 'border-info/30 bg-info-subtle',
  unmeasured: 'border-unmeasured/30 bg-unmeasured-subtle',
};

const TONE_ICON: Record<ErrorTone, string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
  unmeasured: 'text-unmeasured',
};

const TONE_TITLE: Record<ErrorTone, string> = {
  danger: 'text-danger-foreground',
  warning: 'text-warning-foreground',
  info: 'text-info-foreground',
  unmeasured: 'text-unmeasured-foreground',
};

interface KindPresentation {
  title: string;
  body: string;
  tone: ErrorTone;
  icon: LucideIcon;
  /** Whether a retry control is appropriate *at all* for this class. */
  retryable: boolean;
  /** What the retry actually does for this class — a 401 refreshes the
   *  session, it does not repeat the failed write. */
  retryLabel: string;
}

const PRESENTATION: Record<ApiError['kind'], KindPresentation> = {
  invalid: {
    title: 'Some fields need attention',
    body: 'Correct the fields listed below and submit again. Nothing on this page was saved.',
    tone: 'danger',
    icon: AlertTriangle,
    retryable: false,
    retryLabel: 'Try again',
  },
  unauthenticated: {
    title: 'Your session has ended',
    body: 'Sign in again to continue. Nothing you had already submitted has been lost.',
    tone: 'warning',
    icon: Lock,
    retryable: true,
    retryLabel: 'Refresh session',
  },
  forbidden: {
    title: 'You do not have access to this action',
    body: 'This is a permissions decision, not a temporary failure — trying again will not change it.',
    tone: 'warning',
    icon: ShieldAlert,
    // §3.5 "Insufficient role": do not repeatedly refresh on 403.
    retryable: false,
    retryLabel: 'Try again',
  },
  'not-found': {
    title: 'This item is not available',
    body: 'It may have been removed, or it may belong to another client.',
    tone: 'unmeasured',
    icon: SearchX,
    retryable: false,
    retryLabel: 'Try again',
  },
  conflict: {
    title: 'Someone else changed this first',
    body: 'The server has a newer version than the one you were working from.',
    tone: 'warning',
    icon: AlertTriangle,
    retryable: false,
    retryLabel: 'Try again',
  },
  'rate-limited': {
    title: 'Too many requests',
    body: 'Cailyx limits how often the same request can be repeated, so one account cannot slow the service down for everyone else.',
    tone: 'info',
    icon: Timer,
    retryable: true,
    retryLabel: 'Try again',
  },
  unavailable: {
    title: 'A connected service is unavailable',
    body: 'The rest of this page is unaffected. This is usually temporary.',
    tone: 'warning',
    icon: ServerCrash,
    retryable: true,
    retryLabel: 'Try again',
  },
  network: {
    title: 'Could not reach the server',
    body: 'Check your connection and try again. Nothing you had already submitted has been lost.',
    tone: 'warning',
    icon: WifiOff,
    retryable: true,
    retryLabel: 'Try again',
  },
  unknown: {
    title: 'Something went wrong',
    body: 'This section could not be loaded. The information around it is unaffected.',
    tone: 'danger',
    icon: AlertTriangle,
    retryable: true,
    retryLabel: 'Try again',
  },
};

/** How a 404 should be described. §10.4: "404 → missing/private or missing
 *  prerequisite according to endpoint" — the endpoint knows which, the
 *  component does not, so the caller states it rather than this file guessing. */
export type NotFoundReason = 'missing-or-private' | 'missing' | 'private' | 'prerequisite';

const NOT_FOUND_BODY: Record<NotFoundReason, string> = {
  'missing-or-private':
    'It may not exist, or you may not have access to it. Ask your delivery lead if you expected to see it.',
  missing: 'It may have been deleted. Check the current list before retrying.',
  private: 'It belongs to a client you do not have access to. Ask your delivery lead for access.',
  prerequisite:
    'A step or connection this depends on has not been completed yet. Finish that step first, then come back.',
};

export interface ErrorStateAction {
  label: string;
  onClick: () => void;
}

export interface ErrorStateProps {
  /** The typed failure. Use `toApiError` when all you have is an `unknown`. */
  error: ApiError;
  /** `page` centers the block in a section; `inline` is a compact block meant
   *  to sit inside a form, dialog, or card without taking over the layout. */
  layout?: 'page' | 'inline';
  /** Retry handler. Rendered for every class except `forbidden` and `invalid`,
   *  which §3.5/§10.4 say must not loop. Omit it to render no retry control. */
  onRetry?: () => void;
  /** Overrides the per-class default ("Refresh session" for a 401, "Try again"
   *  otherwise). */
  retryLabel?: string;
  /** Sign-in destination offered alongside retry on a 401. */
  signInHref?: string;
  /** The action the user was denied, phrased as a verb phrase —
   *  e.g. "publish this report". Used for 403 copy. */
  restrictedAction?: string;
  /** What the user *can* do instead, e.g. "Ask your delivery lead to publish
   *  it, or request the Publisher role." Used for 403 copy. */
  permittedPath?: string;
  /** Which 404 this is. Defaults to the non-leaking "missing-or-private". */
  notFoundReason?: NotFoundReason;
  /** Provider or integration name for a 503, e.g. "Google Search Console". */
  providerName?: string;
  /** 409 "offer compare/reload": the reload handler. */
  onReload?: () => void;
  /** 409 secondary action — open a diff against the server version. */
  onCompare?: () => void;
  /** Shown where work is kept, e.g. "Your draft is still here — nothing was
   *  overwritten." §10.4: preserve context and say what survived. */
  preserveNotice?: string;
  /** DOM id prefix for invalid fields, so the summary links land on the real
   *  inputs (§3.4). Defaults to `field-`. */
  fieldIdPrefix?: string;
  /** Show the raw server message under the fixed copy. Staff surfaces should
   *  keep the default `true` — real server detail is more useful than a
   *  paraphrase. Client-facing screens should pass `false` (or use
   *  `<ClientErrorBoundary>`-style wrappers): a raw backend message can name
   *  internal fields, operators, or storage paths the reader should never
   *  need to see. */
  showServerMessage?: boolean;
  className?: string;
}

/**
 * Renders a failure according to its §10.4 class: what happened, what the user
 * can do about it, and — for a 400 — links straight to the offending fields.
 *
 * The component never renders a retry control for a 403, and never enables one
 * for a 429 before `Retry-After` has elapsed, because those are the two cases
 * §3.5 calls out explicitly.
 */
export function ErrorState({
  error,
  layout = 'page',
  onRetry,
  retryLabel,
  signInHref,
  restrictedAction,
  permittedPath,
  notFoundReason = 'missing-or-private',
  providerName,
  onReload,
  onCompare,
  preserveNotice,
  fieldIdPrefix = 'field-',
  showServerMessage = true,
  className,
}: ErrorStateProps) {
  const presentation = PRESENTATION[error.kind];
  const Icon = presentation.icon;

  // 429 cooldown. §10.4: honor Retry-After *when available*; when the header
  // is absent we do not invent a wait — the user simply may try again.
  const retryAfter = error.kind === 'rate-limited' ? error.retryAfterSeconds : undefined;
  const [remaining, setRemaining] = useState(retryAfter ?? 0);

  useEffect(() => {
    setRemaining(retryAfter ?? 0);
  }, [retryAfter]);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const coolingDown = remaining > 0;
  const showRetry = presentation.retryable && Boolean(onRetry);

  let body: string = presentation.body;
  if (error.kind === 'not-found') body = NOT_FOUND_BODY[notFoundReason];
  if (error.kind === 'forbidden') {
    const denied = restrictedAction
      ? `You cannot ${restrictedAction} at your current access level.`
      : presentation.body;
    const path = permittedPath ?? 'Ask your delivery lead if you need it.';
    body = `${denied} ${path}`;
  }
  if (error.kind === 'rate-limited' && !error.retryAfterSeconds) {
    body = `${presentation.body} Wait a moment before trying again.`;
  }
  if (error.kind === 'unavailable' && providerName) {
    body = `${providerName} is not responding right now. ${presentation.body}`;
  }
  if (error.kind === 'conflict') {
    body += ' Reload to see the current version before you save again.';
  }

  const fieldEntries = Object.entries(error.fieldErrors ?? {});

  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border',
        TONE_WRAP[presentation.tone],
        layout === 'page' ? 'p-6' : 'p-4',
        layout === 'page' && 'mx-auto max-w-reading',
        className,
      )}
    >
      <div className="flex gap-3">
        <Icon aria-hidden="true" className={cn('mt-0.5 h-5 w-5 shrink-0', TONE_ICON[presentation.tone])} />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className={cn('text-subsection font-semibold', TONE_TITLE[presentation.tone])}>
            {presentation.title}
          </h2>
          <p className="text-table text-foreground">{body}</p>

          {fieldEntries.length > 0 && (
            <ul className="space-y-1 text-table">
              {fieldEntries.map(([field, messages]) => (
                <li key={field}>
                  <a
                    href={`#${fieldIdPrefix}${field}`}
                    className="font-medium text-primary underline underline-offset-4"
                  >
                    {field}
                  </a>
                  <span className="text-muted-foreground"> — {messages.join('; ')}</span>
                </li>
              ))}
            </ul>
          )}

          {coolingDown && (
            <p className="text-table text-foreground" id="errorstate-cooldown">
              {remaining > COUNTDOWN_TICK_LIMIT_SECONDS
                ? `You can try again in about ${Math.ceil(remaining / 60)} minutes.`
                : `You can try again in ${remaining} second${remaining === 1 ? '' : 's'}.`}
            </p>
          )}

          {error.kind === 'conflict' && (
            <p className="text-table text-foreground">
              Your unsaved changes have been kept on this page.
            </p>
          )}

          {preserveNotice && (
            <p className="flex items-start gap-2 text-table text-foreground">
              <RefreshCcw aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              {preserveNotice}
            </p>
          )}

          {showServerMessage && error.message && error.message !== body && (
            <p className="text-meta text-muted-foreground">{error.message}</p>
          )}

          {error.status > 0 && (
            <p className="text-meta text-muted-foreground">
              Response status {error.status}
            </p>
          )}

          {(showRetry || onReload || onCompare || signInHref) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {showRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRetry}
                  disabled={coolingDown}
                  aria-describedby={coolingDown ? 'errorstate-cooldown' : undefined}
                >
                  {retryLabel ?? presentation.retryLabel}
                </Button>
              )}
              {onReload && (
                <Button type="button" size="sm" onClick={onReload}>
                  Reload current version
                </Button>
              )}
              {onCompare && (
                <Button type="button" variant="outline" size="sm" onClick={onCompare}>
                  Compare changes
                </Button>
              )}
              {signInHref && (
                <Button asChild variant="outline" size="sm">
                  <a href={signInHref}>Sign in</a>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Normalizes anything a `catch` block produced into an `ApiError`, so a screen
 * never has to branch on `unknown` before it can render `ErrorState`.
 *
 * A non-`ApiError` becomes `kind: 'unknown'`, which §10.4 keeps context for
 * rather than discarding.
 */
/**
 * §4.3: a client screen says what kind of failure happened, in words, and never
 * echoes the server's own message. A backend message can name internal record
 * IDs, provider fields, statuses or module names — none of which belong on a
 * client screen — whereas this returns the same plain-language sentence
 * `ErrorState` renders for that class of failure.
 *
 * `fallback` is used when nothing better is available: an unmapped failure has
 * no more accurate sentence than the one the caller already wrote, and the
 * caller's sentence keeps the context of *what* was being attempted.
 */
export function clientActionMessage(cause: unknown, fallback: string): string {
  const error = toApiError(cause);
  if (error.kind === 'unknown') return fallback;
  return PRESENTATION[error.kind]?.body ?? fallback;
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof Error) {
    return new ApiError({ kind: 'unknown', status: 0, message: cause.message, body: cause });
  }
  return new ApiError({
    kind: 'unknown',
    status: 0,
    message: 'An unexpected error occurred.',
    body: cause,
  });
}

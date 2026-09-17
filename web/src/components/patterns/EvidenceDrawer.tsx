'use client';

import * as React from 'react';
import { ExternalLink, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ProvenanceBadge } from '@/components/patterns/ProvenanceBadge';
import { StatusPill, type StatusTone } from '@/components/patterns/StatusPill';
import { Timestamp } from '@/components/patterns/Timestamp';
import { useIsDesktop } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import type { ProvenanceKind } from '@/types';

/**
 * §10.5 "Validate outbound link schemes": only http(s) and app-relative
 * targets are rendered as links, so a stored evidence URL can never smuggle a
 * `javascript:` or `data:` payload into an anchor.
 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('/')) return href;
  return /^https?:\/\//i.test(href) ? href : undefined;
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Where the evidence came from. */
export interface EvidenceSource {
  /** Named source, e.g. "Google Search Console" or "GPT-4o via API". */
  name: string;
  /** ISO 8601 instant the evidence was captured (rendered with its timezone). */
  capturedAt: string;
  /** The exact run/version this evidence belongs to. */
  runId?: string;
  /** Direct link to the provider resource, when one exists. */
  url?: string;
  /** The request that produced it, so the check can be reproduced. */
  query?: string;
}

/** The raw answer/check text, kept verbatim. */
export interface EvidenceRaw {
  /** Short description of what this is, e.g. "Model answer" or "Check output". */
  label?: string;
  /**
   * Plain text only. It is rendered as escaped text inside the `.evidence`
   * utility — fetched HTML must never enter the page as trusted markup
   * (§10.5), and this component deliberately offers no HTML input.
   */
  text: string;
}

/** A qualitative confidence statement, never a fabricated statistic (§6.4). */
export interface EvidenceConfidence {
  level: 'high' | 'medium' | 'low' | 'unknown';
  /** What the level rests on, e.g. "5 of 5 checks returned an answer". */
  basis: string;
}

export interface EvidenceRelatedLink {
  label: string;
  href?: string;
  kind?: 'gap' | 'work' | 'run' | 'report' | 'deployment';
}

export interface EvidenceDrawerProps {
  /** Controlled open state — the drawer never opens itself. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the drawer. Required: an unnamed dialog is unusable
   *  to a screen reader. */
  title: string;
  source: EvidenceSource;
  /** The observed fact — what the source actually returned or showed. */
  observed: React.ReactNode;
  /** What Cailyx reads into the observation. Kept visually distinct from the
   *  fact and labelled by provenance, because an interpretation is not a
   *  measurement (§3.3, §6.4). */
  interpretation?: React.ReactNode;
  /** Provenance of the interpretation. Defaults to `model-interpretation`. */
  interpretationKind?: ProvenanceKind;
  /** Raw answer/check, rendered escaped in the `.evidence` utility class. */
  raw?: EvidenceRaw;
  confidence?: EvidenceConfidence;
  /** Gaps, work items, runs or reports this evidence relates to. */
  related?: EvidenceRelatedLink[];
  /** Provenance of the evidence itself. */
  provenance?: ProvenanceKind;
  /** Optional trigger element (e.g. a `Button`). Without one, the caller owns
   *  the only control that opens the drawer. */
  trigger?: React.ReactNode;
  /**
   * `overlay` is the §3.4 tablet/mobile form (a focus-trapped sheet);
   * `panel` is the desktop evidence panel, docked to the right and non-modal
   * so the page behind it stays readable; `auto` (the default) picks by
   * viewport, which is what §3.4 asks for.
   */
  variant?: 'auto' | 'overlay' | 'panel';
  /** IANA zone for the captured timestamp. */
  timeZone?: string;
  className?: string;
}

const CONFIDENCE_TONE: Record<EvidenceConfidence['level'], StatusTone> = {
  // Confidence is not a pass/fail verdict, so it never borrows success or
  // danger; "unknown" is an absence of information and reads as unmeasured.
  high: 'info',
  medium: 'neutral',
  low: 'warning',
  unknown: 'unmeasured',
};

const CONFIDENCE_LABEL: Record<EvidenceConfidence['level'], string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  unknown: 'Confidence not established',
};

// §4.3: "Gap / intervention → Opportunity / improvement"; a "run" is internal
// shorthand for a single measurement, and "deployment" is a change to the
// client's own website.
const RELATED_LABEL: Record<NonNullable<EvidenceRelatedLink['kind']>, string> = {
  gap: 'Opportunity',
  work: 'Work',
  run: 'Measurement',
  report: 'Report',
  deployment: 'Website change',
};

/**
 * §3.3 Evidence drawer — source, captured time, observed fact,
 * interpretation, raw answer/check, confidence and related gap/work.
 *
 * Built on `ui/sheet`, so on tablet and mobile (<1200px) it is a real overlay
 * dialog: focus is trapped and returned to the invoker, Escape closes it, and
 * the page behind it is inert (§3.4). On desktop it becomes the optional
 * non-modal evidence panel instead of covering the data the reader is
 * checking it against.
 *
 * Two rules are structural rather than conventional:
 *  - raw evidence is rendered as escaped text inside `.evidence`; a caller
 *    cannot pass HTML because no prop accepts it (§10.5);
 *  - the observation and the interpretation are separate props with separate
 *    provenance badges, so a model's reading of a fact cannot be presented as
 *    the fact.
 */
export function EvidenceDrawer({
  open,
  onOpenChange,
  title,
  source,
  observed,
  interpretation,
  interpretationKind = 'model-interpretation',
  raw,
  confidence,
  related,
  provenance,
  trigger,
  variant = 'auto',
  timeZone,
  className,
}: EvidenceDrawerProps) {
  const isDesktop = useIsDesktop();
  const asPanel = variant === 'panel' || (variant === 'auto' && isDesktop);
  const panelRef = React.useRef<HTMLElement | null>(null);

  // A non-modal panel is not focus-trapped, so it must at least move focus in
  // and hand it back to whatever opened it (§3.4).
  React.useEffect(() => {
    if (!asPanel || !open) return undefined;
    const invoker = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    };
  }, [asPanel, open]);

  const content = (
    <EvidenceContent
      title={title}
      source={source}
      observed={observed}
      interpretation={interpretation}
      interpretationKind={interpretationKind}
      raw={raw}
      confidence={confidence}
      related={related}
      provenance={provenance}
      timeZone={timeZone}
    />
  );

  if (asPanel) {
    if (!open) return trigger ? <>{trigger}</> : null;
    return (
      <>
        {trigger}
        {/*
         * `EvidenceContent` is shared with the real `<Sheet>` below and uses
         * `SheetTitle`/`SheetDescription` — Radix `Dialog.Title`/`Description`,
         * which read from Dialog context regardless of where in the tree they
         * render. The docked panel is a plain `<aside>`, not a Radix dialog,
         * so without a `Dialog.Root` somewhere above them they throw ("must be
         * used within Dialog") instead of rendering. `Sheet` (= `Dialog.Root`)
         * provides that context with no DOM of its own — no Overlay/Content/
         * Portal are rendered here — so this adds the context the shared body
         * needs without adding any modal chrome to the docked panel.
         */}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <aside
            ref={panelRef}
            tabIndex={-1}
            aria-label={title}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                onOpenChange(false);
              }
            }}
            className={cn(
              'fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-border bg-surface p-6 shadow-overlay focus:outline-none',
              className,
            )}
          >
            {content}
          </aside>
        </Sheet>
      </>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="right"
        className={cn('w-full overflow-y-auto bg-surface sm:max-w-md lg:max-w-lg', className)}
      >
        {content}
      </SheetContent>
    </Sheet>
  );
}

/** Drawer body, shared by the overlay and the docked panel so the two forms
 *  can never drift apart in what they disclose. */
function EvidenceContent({
  title,
  source,
  observed,
  interpretation,
  interpretationKind,
  raw,
  confidence,
  related,
  provenance,
  timeZone,
}: Omit<EvidenceDrawerProps, 'open' | 'onOpenChange' | 'trigger' | 'variant' | 'className'> & {
  /** Resolved by `EvidenceDrawer` before it reaches the shared body. */
  interpretationKind: ProvenanceKind;
}) {
  const url = safeHref(source.url);
  const queryCopy = [source.query, source.url].filter(Boolean).join('\n');

  return (
    <div className="flex flex-col gap-5">
      <SheetHeader className="space-y-2 text-left">
        <SheetTitle className="pr-8">{title}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
          <span>{source.name}</span>
          <span aria-hidden="true">·</span>
          <Timestamp value={source.capturedAt} timeZone={timeZone} />
          {provenance ? <ProvenanceBadge kind={provenance} /> : null}
        </SheetDescription>
      </SheetHeader>

      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-table">
        <dt className="text-muted-foreground">Source</dt>
        <dd className="min-w-0 break-words text-foreground">{source.name}</dd>

        {/* §4.3: the stored measurement id is an internal identifier, so it is
            not printed here — the capture date and the source name are what
            tell the reader which measurement this came from. The run itself
            stays reachable from the screen the evidence was opened on. */}

        <dt className="text-muted-foreground">Captured</dt>
        <dd className="min-w-0">
          <Timestamp value={source.capturedAt} timeZone={timeZone} />
        </dd>

        {source.url ? (
          <>
            <dt className="text-muted-foreground">Web address</dt>
            <dd className="min-w-0 break-all">
              {url ? (
                <a
                  href={url}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  {...(isExternalHref(url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {source.url}
                  <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  {isExternalHref(url) ? <span className="sr-only">(opens in a new tab)</span> : null}
                </a>
              ) : (
                // Not a link: §10.5 forbids rendering an unvalidated scheme as
                // something clickable.
                <span className="text-muted-foreground">
                  {source.url} <span className="text-meta">(not a link: unsupported URL scheme)</span>
                </span>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {source.query ? (
        <section aria-label="What we checked">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-meta font-semibold text-foreground">What we checked</h3>
            <CopyButton value={queryCopy} label="Copy what we checked" />
          </div>
          <p className="mt-1 rounded-md border border-border bg-surface-sunken p-2 font-mono text-meta break-words text-foreground">
            {source.query}
          </p>
        </section>
      ) : null}

      <section aria-label="Observed">
        <h3 className="text-meta font-semibold text-foreground">Observed</h3>
        <div className="mt-1 text-table text-foreground">{observed}</div>
      </section>

      {interpretation ? (
        <section aria-label="Our reading">
          <h3 className="flex flex-wrap items-center gap-2 text-meta font-semibold text-foreground">
            Our reading
            <ProvenanceBadge kind={interpretationKind} />
          </h3>
          <div className="mt-1 rounded-md border border-border bg-surface-sunken p-3 text-table text-foreground">
            {interpretation}
          </div>
          <p className="mt-1 text-meta text-muted-foreground">
            A reading of the observation above, not an additional measurement.
          </p>
        </section>
      ) : null}

      {raw ? (
        <section aria-label="The full answer we looked at">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-meta font-semibold text-foreground">
              {raw.label ?? 'The full answer we looked at'}
            </h3>
            <CopyButton value={raw.text} label="Copy this text" />
          </div>
          {/* `.evidence` keeps fetched text monospace and wrapped, visually
              outside the app's own chrome. React escapes these children, and
              no prop on this component accepts markup (§10.5). */}
          {/* §4.5: a scrollable region is keyboard-reachable — otherwise a
              keyboard-only reader cannot scroll the text they were sent here
              to read. `role="region"` plus the label makes it a landmark the
              screen reader announces. */}
          <pre
            role="region"
            tabIndex={0}
            aria-label={raw.label ?? 'The full answer we looked at'}
            className="evidence mt-1 max-h-80 overflow-auto rounded-md border border-border bg-surface-sunken p-3 text-foreground"
          >
            {raw.text}
          </pre>
        </section>
      ) : null}

      {confidence ? (
        <section aria-label="Confidence" className="flex flex-wrap items-center gap-2">
          <StatusPill label={CONFIDENCE_LABEL[confidence.level]} tone={CONFIDENCE_TONE[confidence.level]} />
          <p className="text-meta text-muted-foreground">{confidence.basis}</p>
        </section>
      ) : null}

      {related && related.length > 0 ? (
        <section aria-label="Related work and opportunities">
          <h3 className="flex items-center gap-1.5 text-meta font-semibold text-foreground">
            <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            Related
          </h3>
          <ul className="mt-1.5 space-y-1">
            {related.map((item) => {
              const href = safeHref(item.href);
              return (
                <li key={`${item.kind ?? 'related'}-${item.label}`} className="text-table">
                  {item.kind ? (
                    <span className="mr-1.5 text-meta text-muted-foreground">{RELATED_LABEL[item.kind]}</span>
                  ) : null}
                  {href ? (
                    <a className="font-medium text-primary hover:underline" href={href}>
                      {item.label}
                    </a>
                  ) : (
                    <span className="text-foreground">{item.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Copy-to-clipboard with a polite status announcement (§3.4: announce status
 * without hijacking the reader's place). Failures say what to do instead of
 * claiming a copy that did not happen.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function handleCopy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setState('failed');
    } else {
      navigator.clipboard.writeText(value).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 4000);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={value.length === 0}>
        {label}
      </Button>
      <span role="status" aria-live="polite" className="text-meta text-muted-foreground">
        {state === 'copied' ? 'Copied' : null}
        {state === 'failed' ? 'Could not copy — select the text and copy it manually.' : null}
      </span>
    </span>
  );
}

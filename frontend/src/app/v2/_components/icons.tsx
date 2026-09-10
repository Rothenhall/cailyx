/**
 * icons — /v2. Two sets, each doing the job it is good at.
 *
 * The twelve AGENT icons come from Animate UI: animated Lucide, so a tile
 * plays its own motion on hover. They replace a bespoke solid set, which in
 * turn had replaced raw Unicode codepoints rendered as text.
 *
 * The UTILITY icons below stay hand-drawn and solid on a 16px grid. They sit
 * at 12–14px inside dense chrome, where a 24-viewBox stroke thins to a grey
 * hairline on warm paper — the exact problem the solid set was built to fix.
 * Counters are knocked out with `fill-rule: evenodd`, so nothing depends on a
 * stroke width surviving a scale-down. Both sets inherit `currentColor`.
 *
 * @module app/v2/_components/icons
 */

import { Search } from '@/components/animate-ui/icons/search';
import { RadioTower } from '@/components/animate-ui/icons/radio-tower';
import { Lightbulb } from '@/components/animate-ui/icons/lightbulb';
import { Star } from '@/components/animate-ui/icons/star';
import { Route } from '@/components/animate-ui/icons/route';
import { UsersRound } from '@/components/animate-ui/icons/users-round';
import { Gavel } from '@/components/animate-ui/icons/gavel';
import { Sparkles } from '@/components/animate-ui/icons/sparkles';
import { List } from '@/components/animate-ui/icons/list';
import { BellRing } from '@/components/animate-ui/icons/bell-ring';
import { MessageCircleQuestion } from '@/components/animate-ui/icons/message-circle-question';
import { ChartBar } from '@/components/animate-ui/icons/chart-bar';

export type IconProps = { className?: string };

/** shared attrs — every icon is a solid mass on the same 16px grid */
const base = {
  viewBox: '0 0 16 16',
  fill: 'currentColor',
  'aria-hidden': true,
} as const;

/* ── agent roster · Animate UI ────────────────────────────────────────────
   The twelve agents now use Animate UI's animated Lucide icons, so each tile
   plays its own motion on hover. Two of them read better than the shapes they
   replace: `gavel` is a truer Council mark than a discussion bubble, and
   `message-circle-question` is literally the Attribution question.

   These arrive as 24-viewBox strokes at width 2, where the set above was
   16-viewBox solid fill. At tile size that thins out badly on warm paper, so
   `strokeWidth` is lifted to 2.25 — the one adjustment the swap needs. */
const AGENT_ANIM: Record<string, React.ComponentType<AnimatedIconProps>> = {
  seo: Search,
  geo: RadioTower,
  articles: Lightbulb,
  content: Lightbulb, // 'content' is the category; the agent key is 'articles'
  authority: Star,
  journeys: Route,
  personas: UsersRound,
  council: Gavel,
  mentions: Sparkles,
  serp: List,
  monitoring: BellRing,
  attribution: MessageCircleQuestion,
  rivals: ChartBar,
};

type AnimatedIconProps = {
  className?: string;
  size?: number;
  strokeWidth?: number;
  animateOnHover?: boolean;
};

export function AgentIcon({
  agentKey,
  className,
  size = 18,
  animateOnHover = false,
}: {
  agentKey: string;
  className?: string;
  size?: number;
  /** play the icon's own animation while the pointer is over its container */
  animateOnHover?: boolean;
}) {
  const Ico = AGENT_ANIM[agentKey];
  if (!Ico) return <DotIcon className={className} />;
  return (
    <Ico className={className} size={size} strokeWidth={2.25} animateOnHover={animateOnHover} />
  );
}

/** shown for an agent key the map does not know — deliberately mute */
function DotIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="8" cy="8" r="3.4" />
    </svg>
  );
}

/* ── utility ──────────────────────────────────────────────────────────── */

/** the brand lockup — three ascending tiles */
export function BrandMark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden>
      <rect x="1" y="11" width="7" height="7" rx="1.5" fill="var(--accent-dim)" />
      <rect x="7" y="6" width="7" height="7" rx="1.5" fill="var(--accent)" />
      <rect x="13" y="1" width="6" height="6" rx="1.5" fill="var(--cognac)" />
    </svg>
  );
}

export function ChevronDown({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3.6 6.1h8.8a.55.55 0 0 1 .43.9l-4.4 5a.55.55 0 0 1-.86 0l-4.4-5a.55.55 0 0 1 .43-.9Z" />
    </svg>
  );
}

export function ChevronLeft({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M10.4 3.6v8.8a.55.55 0 0 1-.9.43l-5-4.4a.55.55 0 0 1 0-.86l5-4.4a.55.55 0 0 1 .9.43Z" />
    </svg>
  );
}

export function PlugIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5" y="0.9" width="1.7" height="3.6" rx="0.85" />
      <rect x="9.3" y="0.9" width="1.7" height="3.6" rx="0.85" />
      <path d="M3.4 5.4h9.2v2.3a4.6 4.6 0 0 1-9.2 0V5.4Z" />
      <rect x="7.15" y="11.6" width="1.7" height="3.5" rx="0.85" />
    </svg>
  );
}

export function UsersIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="5.9" cy="4.8" r="2.8" />
      <path d="M5.9 8.9c2.9 0 5 1.8 5 4.8a.8.8 0 0 1-.8.8H1.7a.8.8 0 0 1-.8-.8c0-3 2.1-4.8 5-4.8Z" />
      <circle cx="11.9" cy="5.4" r="2.2" />
      <path d="M11.6 9.4c2.2.1 3.5 1.8 3.5 4.3a.8.8 0 0 1-.8.8h-2c.06-1.9-.36-3.6-1.3-4.9l.6-.2Z" />
    </svg>
  );
}

export function LogoutIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3.1 1.4h4.4a1.5 1.5 0 0 1 1.5 1.5v1.6H7.3V3.1a.4.4 0 0 0-.4-.4H3.4a.4.4 0 0 0-.4.4v9.8a.4.4 0 0 0 .4.4h3.5a.4.4 0 0 0 .4-.4v-1.4H9v1.6a1.5 1.5 0 0 1-1.5 1.5H3.1a1.5 1.5 0 0 1-1.5-1.5V2.9a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M11.2 4.6 15.1 8l-3.9 3.4V9.1H6.9V6.9h4.3V4.6Z" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7 2.9h2v4.1h4.1v2H9v4.1H7V9H2.9V7H7V2.9Z" />
    </svg>
  );
}

export function GridIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.5" />
      <rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.5" />
      <rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.5" />
      <rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.5" />
    </svg>
  );
}

export function SyncIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path fillRule="evenodd" d="M8 1.9A6.1 6.1 0 1 0 14.1 8h-1.7A4.4 4.4 0 1 1 8 3.6V1.9Z" />
      <path d="M6.7.4 10.1 2.75 6.7 5.1V.4Z" />
    </svg>
  );
}

export function BarIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="1.8" y="8.6" width="3" height="5.6" rx="1.1" />
      <rect x="6.5" y="4.2" width="3" height="10" rx="1.1" />
      <rect x="11.2" y="6.6" width="3" height="7.6" rx="1.1" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8.57 1.63a.8.8 0 0 0-1.14 0L2.9 6.17a.8.8 0 0 0 1.13 1.13L7 4.33v9.27a1 1 0 0 0 2 0V4.33l2.97 2.97a.8.8 0 0 0 1.13-1.13L8.57 1.63Z" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4.06 2.65 8 6.59l3.94-3.94a1 1 0 1 1 1.42 1.42L9.41 8l3.95 3.94a1 1 0 0 1-1.42 1.42L8 9.41l-3.94 3.95a1 1 0 0 1-1.42-1.42L6.59 8 2.64 4.06a1 1 0 1 1 1.42-1.41Z" />
    </svg>
  );
}

export function BoltIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M9.9 1 3.3 9.1h3.9L6.1 15l6.6-8.1H8.8L9.9 1Z" />
    </svg>
  );
}

export function LayersIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7.55 1.13a1 1 0 0 1 .9 0l6 3a.6.6 0 0 1 0 1.07l-6 3a1 1 0 0 1-.9 0l-6-3a.6.6 0 0 1 0-1.07l6-3Z" />
      <path d="M1.87 8.2 7.55 11a1 1 0 0 0 .9 0l5.68-2.8.42.21a.6.6 0 0 1 0 1.07l-6 3a1 1 0 0 1-.9 0l-6-3a.6.6 0 0 1 0-1.07l.22-.11Z" />
      <path d="M1.87 11.6 7.55 14.4a1 1 0 0 0 .9 0l5.68-2.8.42.21a.6.6 0 0 1 0 1.07l-6 3a1 1 0 0 1-.9 0l-6-3a.6.6 0 0 1 0-1.07l.22-.11Z" />
    </svg>
  );
}

export function ArrowRight({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8.9 3.1 13.8 8l-4.9 4.9v-3.8H2.5V6.9h6.4V3.1Z" />
    </svg>
  );
}

/** Google's 4-colour "G" — the one utility icon that keeps its own palette,
    because a monochrome Google mark reads as generic. */
export function GoogleGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.85 14.1a6.6 6.6 0 0 1 0-4.22V7.04H2.18a11 11 0 0 0 0 9.9l3.67-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.35c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.04l3.67 2.84C6.71 7.28 9.14 5.35 12 5.35Z"
      />
    </svg>
  );
}

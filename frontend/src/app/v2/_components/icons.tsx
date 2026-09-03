/**
 * icons — /v2. One solid-fill icon set on a 16px grid.
 *
 * Two reasons this exists. The agent roster was drawing Unicode codepoints
 * (⌁ ◎ ⍜ ⌸ ♺) as text, so its "icons" were whatever fallback face the OS
 * happened to pick — inconsistent weight, inconsistent metrics, and a real
 * tofu risk for the rarer glyphs. And the utility icons were 1.5px strokes,
 * which go thin and grey against warm paper at 14px.
 *
 * Filled masses hold their weight at small sizes. Counters are knocked out
 * with `fill-rule: evenodd` rather than drawn as hairlines, so nothing depends
 * on a stroke width surviving a scale-down. Everything inherits `currentColor`.
 *
 * @module app/v2/_components/icons
 */

export type IconProps = { className?: string };

/** shared attrs — every icon is a solid mass on the same 16px grid */
const base = {
  viewBox: '0 0 16 16',
  fill: 'currentColor',
  'aria-hidden': true,
} as const;

/* ── agent roster ─────────────────────────────────────────────────────── */

/** SEO — a magnifier: on-page inspection */
export function SeoIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path fillRule="evenodd" d="M7 1.3a5.7 5.7 0 1 0 3.35 10.31l3.02 3.02a1 1 0 0 0 1.42-1.42l-3.02-3.02A5.7 5.7 0 0 0 7 1.3Zm0 2a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4Z" />
    </svg>
  );
}

/** GEO — concentric rings: visibility across answer surfaces */
export function GeoIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path fillRule="evenodd" d="M8 .9a7.1 7.1 0 1 0 0 14.2A7.1 7.1 0 0 0 8 .9Zm0 2a5.1 5.1 0 1 1 0 10.2A5.1 5.1 0 0 1 8 2.9Z" />
      <path fillRule="evenodd" d="M8 4.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 1.9a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z" />
    </svg>
  );
}

/** Articles — a document with ruled lines knocked out */
export function ArticlesIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path
        fillRule="evenodd"
        d="M4.6 1h4.6l4 4v8.6A1.4 1.4 0 0 1 11.8 15H4.6a1.4 1.4 0 0 1-1.4-1.4V2.4A1.4 1.4 0 0 1 4.6 1Zm.8 6.6h5.2v1.3H5.4V7.6Zm0 3.2h3.6v1.3H5.4v-1.3Z"
      />
      <path d="M9.9 1.3 12.9 4.3h-2.4a.6.6 0 0 1-.6-.6V1.3Z" />
    </svg>
  );
}

/** Authority — a star: earned placement */
export function AuthorityIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8 1.4 9.71 5.65 14.28 5.96 10.76 8.9 11.88 13.34 8 10.9 4.12 13.34 5.24 8.9 1.72 5.96 6.29 5.65Z" />
    </svg>
  );
}

/** Journey — a branching path */
export function JourneyIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="7.2" y="8.4" width="1.6" height="6.2" rx="0.8" />
      <rect x="4.2" y="5.2" width="1.6" height="6" rx="0.8" transform="rotate(-45 5 8.2)" />
      <rect x="10.2" y="5.2" width="1.6" height="6" rx="0.8" transform="rotate(45 11 8.2)" />
      <circle cx="2.9" cy="3.4" r="2" />
      <circle cx="13.1" cy="3.4" r="2" />
    </svg>
  );
}

/** Persona — a figure */
export function PersonaIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="8" cy="4.7" r="3" />
      <path d="M8 9.1c3.1 0 5.5 1.9 5.5 5.1a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8c0-3.2 2.4-5.1 5.5-5.1Z" />
    </svg>
  );
}

/** Council — a deliberation bubble. Scales were the obvious metaphor but the
 *  pans collapse into the post at 16px; the council module is role agents
 *  debating and a synthesiser ranking the result, so discussion reads truer
 *  and survives the size. */
export function CouncilIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path
        fillRule="evenodd"
        d="M3 1.6h10a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2H8.6l-3.5 2.9a.6.6 0 0 1-1-.46V11.8H3a2 2 0 0 1-2-2V3.6a2 2 0 0 1 2-2Zm2 4.05a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Zm3 0a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Zm3 0a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z"
      />
    </svg>
  );
}

/** Mentions — a four-point spark */
export function MentionsIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8 .9c.62 4.1 2.1 5.58 6.2 6.2-4.1.62-5.58 2.1-6.2 6.2-.62-4.1-2.1-5.58-6.2-6.2C5.9 6.48 7.38 5 8 .9Z" />
      <circle cx="13.1" cy="12.8" r="1.7" />
    </svg>
  );
}

/** SERP — stacked result rows, the top one taking the answer slot */
export function SerpIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="1.6" y="2.4" width="12.8" height="3.4" rx="1.2" />
      <rect x="1.6" y="7.4" width="9.2" height="1.9" rx="0.95" />
      <rect x="1.6" y="10.8" width="11.6" height="1.9" rx="0.95" />
    </svg>
  );
}

/** Monitoring — a bell: scheduled re-runs and regression alerts */
export function MonitoringIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8 1.1a1.15 1.15 0 0 1 1.15 1.15v.38a4.5 4.5 0 0 1 3.35 4.35v2.44l1.13 1.65a.8.8 0 0 1-.66 1.25H3.03a.8.8 0 0 1-.66-1.25L3.5 9.42V6.98a4.5 4.5 0 0 1 3.35-4.35v-.38A1.15 1.15 0 0 1 8 1.1Z" />
      <path d="M6.3 13.2h3.4a1.7 1.7 0 0 1-3.4 0Z" />
    </svg>
  );
}

/** every agent key the backend can return, plus a neutral fallback */
export const AGENT_ICON: Record<string, (p: IconProps) => React.ReactElement> = {
  seo: SeoIcon,
  geo: GeoIcon,
  content: ArticlesIcon,
  authority: AuthorityIcon,
  journeys: JourneyIcon,
  personas: PersonaIcon,
  council: CouncilIcon,
  mentions: MentionsIcon,
  serp: SerpIcon,
  monitoring: MonitoringIcon,
};

export function AgentIcon({ agentKey, className }: { agentKey: string; className?: string }) {
  const Ico = AGENT_ICON[agentKey] ?? DotIcon;
  return <Ico className={className} />;
}

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

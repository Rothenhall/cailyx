import type { Metadata } from 'next';
import { Instrument_Sans, Jost } from 'next/font/google';
import { FeedbackProvider } from '@fasterfixes/react';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

/**
 * Brand typography — Rothenhall brand kit v1.1.0, `Brand/tokens/brand.css`.
 *
 * Jost is the display face (geometric, Futura lineage); Instrument Sans is the
 * body face (humanist grotesque), chosen for contrast against Jost rather than
 * for agreement with it. The kit retired Poppins and Inter precisely because a
 * second geometric sans made display and body rhyme, so neither may be
 * substituted here.
 *
 * next/font self-hosts both at build time and emits a sized fallback, so there
 * is no runtime request to Google and no layout shift. globals.css resolves
 * `--font-sans` / `--font-display` through these variables and keeps system
 * fallbacks, so the app still renders if the fonts fail to load.
 */
const jost = Jost({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-jost',
});

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-instrument-sans',
});

export const metadata: Metadata = {
  title: {
    default: 'Cailyx',
    template: '%s · Cailyx',
  },
  description: 'Search and AI-answer visibility, measured and delivered.',
};

/**
 * Root layout. Deliberately thin: the operator, client and public surfaces
 * each own their own shell under `(ops)`, `(client)` and `(public)`, because
 * design_plan.md §10.1 warns against a shared privileged data container that
 * could feed operator data into a client view.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jost.variable} ${instrumentSans.variable}`}>
      <body>
        {/* §3.4 — skip link is the first focusable element on every page. */}
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {/* Feedback widget. Wraps only the page content so the skip link stays
            the first focusable element and the toaster keeps its own layer. */}
        <FeedbackProvider projectId="proj_86a1389afe7b24b311188627">
          {children}
        </FeedbackProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}

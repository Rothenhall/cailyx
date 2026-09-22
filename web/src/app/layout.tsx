import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import { FeedbackProvider } from '@fasterfixes/react';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

/**
 * Typography — Graphite theme kit, ported in over the Rothenhall brand kit
 * v1.1.0 pairing (Jost display / Instrument Sans body), which had documented
 * this pairing as not to be substituted. This is a deliberate override of
 * that rule, not an oversight — see globals.css for the matching radius/
 * shadow/motion changes, all colour tokens are untouched.
 *
 * One face for both display and body, matching frontend/'s treatment.
 * Montserrat ships as a variable font, so it's loaded without a fixed weight
 * list — the softened 425/525/625/725 weight scale in tailwind.config.ts
 * (Graphite's own weights) is available directly.
 */
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-montserrat',
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
    <html lang="en" className={montserrat.variable}>
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

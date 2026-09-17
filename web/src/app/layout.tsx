import type { Metadata } from 'next';
import { FeedbackProvider } from '@fasterfixes/react';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

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
    <html lang="en">
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

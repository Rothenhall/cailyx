'use client';

/**
 * AuditsSection — /v2. The Audits rail destination.
 *
 * Splits the job the Audits *card* used to do alone. That card was both a
 * summary (scores at a glance) and a launcher (click a tile, take over the
 * screen), did neither well at 320px, and vanished entirely below a 1000px
 * viewport — so on a laptop in a client meeting the audit figures silently
 * disappeared.
 *
 * Here the card keeps the summary job on the Overview canvas, and this section
 * owns launching: pick a discipline, read it full-width. One job each.
 *
 * @module app/v2/_components/AuditsSection
 */

import { useState } from 'react';
import { AeoAuditWorkspace } from './AeoAuditWorkspace';
import { CompetitorsWorkspace } from './CompetitorsWorkspace';
import { KeywordsWorkspace } from './KeywordsWorkspace';
import { SeoAuditWorkspace } from './SeoAuditWorkspace';
import { TechnicalAuditWorkspace } from './TechnicalAuditWorkspace';

/**
 * Every audit-type module, clubbed here the same way the Audits card clubs
 * them. Tech Stack has no workspace of its own — its data lives in the
 * Technical report's own "Stack" section — so it opens Technical directly
 * rather than getting a redundant tab that shows the same workspace anyway.
 */
type Discipline = 'technical' | 'seo' | 'aeo' | 'competitors' | 'keywords';

const DISCIPLINES: { id: Discipline; label: string; blurb: string }[] = [
  { id: 'technical', label: 'Technical', blurb: 'Crawl, access, performance, stack' },
  { id: 'seo', label: 'SEO', blurb: 'Search Console queries and pages' },
  { id: 'aeo', label: 'AEO', blurb: 'Answer-engine visibility across engines' },
  { id: 'competitors', label: 'Rivals', blurb: 'Gap vs competitors' },
  { id: 'keywords', label: 'Keywords', blurb: 'Demand research' },
];

export function AuditsSection({
  projectId,
  domain,
  onClose,
  onNotify,
}: {
  projectId: string | null;
  domain: string | null;
  /**
   * Where each workspace's own back button goes. Threaded through rather than
   * stubbed: a back control that does nothing is worse than no back control,
   * and these workspaces were built as overlays that always had one.
   */
  onClose: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  /**
   * Technical leads because it is the audit that actually runs without a key,
   * and the findings it produces are what the other two read.
   */
  const [which, setWhich] = useState<Discipline>('technical');

  if (!projectId) {
    return (
      <div className="p-6">
        <p className="text-body text-faint">Select a project to run an audit.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* discipline strip — the launcher half of the old card's two jobs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {DISCIPLINES.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => setWhich(d.id)}
            title={d.blurb}
            className={`rounded-r2 px-2.5 py-1 text-caption transition-colors ${
              which === d.id ? 'bg-bg-inset font-semibold text-text' : 'text-faint hover:text-dim'
            }`}
          >
            {d.label}
          </button>
        ))}
        <span className="ml-auto truncate text-caption text-faint">{domain ?? '—'}</span>
      </div>

      {/* The workspaces position themselves absolutely (they were built as
          overlays), so they need a positioned parent that is not the canvas. */}
      <div className="relative min-h-0 flex-1">
        {which === 'technical' && (
          <TechnicalAuditWorkspace
            key={`tech-${projectId}`}
            projectId={projectId}
            domain={domain}
            onClose={onClose}
            onNotify={onNotify}
          />
        )}
        {which === 'seo' && (
          <SeoAuditWorkspace
            key={`seo-${projectId}`}
            projectId={projectId}
            domain={domain}
            onClose={onClose}
            onNotify={onNotify}
          />
        )}
        {which === 'aeo' && (
          <AeoAuditWorkspace
            key={`aeo-${projectId}`}
            projectId={projectId}
            domain={domain}
            onClose={onClose}
            onNotify={onNotify}
          />
        )}
        {which === 'competitors' && (
          <CompetitorsWorkspace
            key={`competitors-${projectId}`}
            projectId={projectId}
            domain={domain}
            onClose={onClose}
            onNotify={onNotify}
          />
        )}
        {which === 'keywords' && (
          <KeywordsWorkspace key={`keywords-${projectId}`} projectId={projectId} onClose={onClose} onNotify={onNotify} />
        )}
      </div>
    </div>
  );
}

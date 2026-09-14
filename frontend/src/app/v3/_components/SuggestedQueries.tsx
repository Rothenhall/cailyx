'use client';

/**
 * SuggestedQueries — a plain list card replacing /v2's Flywheel (a hand-built
 * SVG sunburst with drag/snap physics that hung half off the window edge).
 * Same underlying data (buyer-journey query suggestions from
 * /projects/:id/journeys/suggestions), read as a list instead of a chart —
 * picking one still hands it to the Cailyx Assistant the same way.
 *
 * @module app/v3/_components/SuggestedQueries
 */

import type { SuggestionWheel } from '@/components/terminal/Flywheel';
import { Card, CardHeader } from './Card';
import { SyncIcon } from './icons';

const MAX_SHOWN = 8;

export function SuggestedQueries({
  wheel,
  loading,
  onPick,
}: {
  wheel: SuggestionWheel | null;
  loading: boolean;
  onPick: (query: string) => void;
}) {
  const queries = (wheel?.stages ?? []).flatMap((stage) =>
    stage.themes.flatMap((theme) => theme.queries.map((q) => ({ text: q.text, stage: stage.label }))),
  );

  return (
    <Card>
      <CardHeader title="Suggested buyer queries" icon={<SyncIcon className="h-3.5 w-3.5" />} />
      <div className="p-3">
        {loading && queries.length === 0 && (
          <div className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="v3skel h-9 rounded-r2" />
            ))}
          </div>
        )}
        {!loading && queries.length === 0 && (
          <p className="px-1 py-2 text-body text-faint">No suggestions yet for this project.</p>
        )}
        <div className="space-y-1">
          {queries.slice(0, MAX_SHOWN).map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(q.text)}
              className="flex w-full items-start gap-2 rounded-r2 px-2.5 py-2 text-left transition-colors hover:bg-bg-inset"
            >
              <span className="mt-0.5 shrink-0 text-caption uppercase tracking-eyebrow text-faint">{q.stage}</span>
              <span className="text-ui text-text">{q.text}</span>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

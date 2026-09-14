'use client';

/**
 * ProjectSummary — the active project's identity + stats, editable inline.
 * Replaces /v2's ContextPanel (a "wall-mounted drawer" that morphed open from
 * a 54px nub with masked corner flares) with a normal dashboard card — same
 * data (name/category/notes/competitors/stats), no wall to weld to anymore.
 *
 * @module app/v3/_components/ProjectSummary
 */

import { useEffect, useState } from 'react';
import type { ProjectDetail } from '@/types/terminal';
import { getCompetitors, type Competitor } from '@/lib/terminal-api';
import { Card, CardHeader } from './Card';
import { LayersIcon } from './icons';

export function ProjectSummary({
  project,
  onSave,
}: {
  project: ProjectDetail | null;
  onSave: (patch: { name?: string; category?: string; notes?: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);

  useEffect(() => {
    setCategory(project?.category ?? '');
    setNotes(project?.notes ?? '');
    setEditing(false);
  }, [project?.id]);

  useEffect(() => {
    if (!project?.id) {
      setCompetitors([]);
      return;
    }
    getCompetitors(project.id)
      .then((r) => setCompetitors(r.tracked))
      .catch(() => setCompetitors([]));
  }, [project?.id]);

  if (!project) {
    return (
      <Card>
        <CardHeader title="Project" icon={<LayersIcon className="h-3.5 w-3.5" />} />
        <p className="px-4 py-4 text-body text-faint">Select a project to see its details.</p>
      </Card>
    );
  }

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ category: category.trim(), notes });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const stats = project.stats;

  return (
    <Card>
      <CardHeader
        title={project.domain}
        icon={<LayersIcon className="h-3.5 w-3.5" />}
        action={
          !editing && (
            <button type="button" onClick={() => setEditing(true)} className="text-caption text-faint hover:text-accent">
              edit
            </button>
          )
        }
      />
      <div className="space-y-3 p-4">
        {editing ? (
          <>
            <label className="block">
              <span className="mb-1 block text-caption text-faint">Category</span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption text-faint">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-r2 border border-border bg-bg-inset px-3 py-2 text-ui outline-none focus:border-border-strong"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-r2 bg-accent px-3 py-1.5 text-ui font-medium text-bg-raised disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-r2 border border-border px-3 py-1.5 text-ui text-dim"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 text-ui">
              <div>
                <dt className="text-caption text-faint">Category</dt>
                <dd className="text-text">{project.category || '—'}</dd>
              </div>
              <div>
                <dt className="text-caption text-faint">Client</dt>
                <dd className="text-text">{project.clientName || '—'}</dd>
              </div>
            </dl>
            {project.notes && (
              <p className="whitespace-pre-wrap text-body leading-relaxed text-dim">{project.notes}</p>
            )}
          </>
        )}

        {stats && (
          <div className="grid grid-cols-4 gap-2 border-t border-border pt-3">
            {[
              { label: 'Audits', value: stats.technicalAudits },
              { label: 'Reports', value: stats.reports },
              { label: 'Entities', value: stats.entities },
              { label: 'Gaps', value: stats.gaps },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <div className="num text-title font-semibold text-text">{s.value}</div>
                <div className="text-caption text-faint">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {competitors.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-1.5 text-caption text-faint">Competitors</div>
            <div className="flex flex-wrap gap-1.5">
              {competitors.map((c) => (
                <span key={c.domain ?? c.name} className="rounded-r2 bg-bg-inset px-2 py-1 text-caption text-dim">
                  {c.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

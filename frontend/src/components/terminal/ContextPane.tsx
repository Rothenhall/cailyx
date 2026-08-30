'use client';

/**
 * Context pane — the company profile the operator (and the agents) read before
 * doing anything: editable name + description, the context artefacts the
 * platform holds, and the competitor set.
 *
 * @module components/terminal/ContextPane
 */

import { useEffect, useState } from 'react';
import { patchProject } from '@/lib/terminal-api';
import type { AgentsResponse, ProjectDetail } from '@/types/terminal';

export const contextMeta = { key: 'context' as const, title: 'Context', icon: '▦' };

export function ContextPane({
  project,
  agents,
  onProjectChanged,
}: {
  project: ProjectDetail | null;
  agents: AgentsResponse | null;
  onProjectChanged: (p: ProjectDetail) => void;
}) {
  const [notes, setNotes] = useState('');
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setNotes(project?.notes ?? '');
    setName(project?.name ?? '');
    setDirty(false);
    setErr(null);
  }, [project?.id, project?.notes, project?.name]);

  const save = async () => {
    if (!project) return;
    setSaving(true);
    setErr(null);
    try {
      const updated = await patchProject(project.id, { name: name.trim() || project.name, notes });
      onProjectChanged({ ...project, ...updated });
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const competitors = parseCompetitors(project?.competitors ?? null);
  const s = project?.stats;

  const artefacts: Array<{ label: string; count: number; badge?: string }> = [
    { label: 'Technical audits', count: s?.technicalAudits ?? 0 },
    { label: 'AI visibility reports', count: s?.reports ?? 0 },
    { label: 'Entity records', count: s?.entities ?? 0 },
    { label: 'Gap roadmap items', count: s?.gaps ?? 0 },
    ...(agents
      ? agents.agents
          .filter((a) => ['personas', 'journeys', 'council', 'serp', 'authority'].includes(a.key))
          .map((a) => ({ label: a.name.replace(' Agent', ''), count: a.count, badge: a.status }))
      : []),
  ];

  return (
    <>
      {!project ? (
        <p className="p-3 text-faint">select a project</p>
      ) : (
        <div className="p-3">
          {/* profile */}
          <div className="mb-3 flex items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg-inset text-dim">
              {project.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true); }}
                className="w-full bg-transparent text-[14px] font-semibold text-text outline-none focus:text-accent"
              />
              <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                <Tag>{project.domain}</Tag>
                {project.category && <Tag>{project.category}</Tag>}
                {project.clientName && <Tag>{project.clientName}</Tag>}
                {project.status && <Tag>{project.status}</Tag>}
              </div>
            </div>
          </div>

          {/* description */}
          <label className="mb-1 block text-[11px] uppercase tracking-widest text-faint">Description</label>
          <textarea
            value={notes}
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            rows={6}
            placeholder="What this company does, who it sells to, what 'winning' looks like. The agents read this first."
            className="w-full resize-y rounded-md border border-border bg-bg-inset p-2 text-[12px] leading-relaxed text-dim outline-none focus:border-border-strong"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded border border-accent-dim bg-accent-dim/20 px-2 py-1 text-[11px] text-accent disabled:opacity-40"
            >
              {saving ? 'saving…' : dirty ? 'save context' : 'saved'}
            </button>
            {err && <span className="text-[11px] text-red">{err}</span>}
          </div>

          {/* artefacts */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-widest text-faint">Context documents</span>
            </div>
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {artefacts.map((a) => (
                <li key={a.label} className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
                  <span className="text-faint">▤</span>
                  <span className="flex-1 truncate text-dim">{a.label}</span>
                  {a.count > 0 ? (
                    <span className="rounded bg-bg-inset px-1.5 py-0.5 text-[10px] text-accent">{a.count}</span>
                  ) : (
                    <span className="text-[10px] text-faint">none</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* competitors */}
          <div className="mt-4">
            <span className="mb-1.5 block text-[11px] uppercase tracking-widest text-faint">Competitors</span>
            {competitors.length === 0 ? (
              <p className="text-[12px] text-faint">none set — intake enriches this from the homepage.</p>
            ) : (
              <ul className="space-y-1">
                {competitors.map((c) => (
                  <li key={c.name} className="flex items-center gap-2 text-[12px]">
                    <span className="text-faint">◦</span>
                    <span className="text-dim">{c.name}</span>
                    {c.domain && <span className="text-faint">{c.domain}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="mt-4 border-t border-border/60 pt-2 text-[11px] text-faint">
            What your CMO reads before doing anything — edit any of it, anytime.
          </p>
        </div>
      )}
    </>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-border bg-bg-inset px-1.5 py-0.5 text-faint">{children}</span>;
}

function parseCompetitors(raw: string | null): Array<{ name: string; domain: string | null }> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ name?: string; domain?: string | null } | string>;
    return arr
      .map((c) => (typeof c === 'string' ? { name: c, domain: null } : { name: c?.name ?? '', domain: c?.domain ?? null }))
      .filter((c) => c.name.length > 0);
  } catch {
    return [];
  }
}

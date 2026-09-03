'use client';

/**
 * ContextPanel — /v2. A brass component welded to the RIGHT wall: a slim nub
 * that morphs open into a near-full-height panel. Concave corner "flares"
 * (radial-gradient masks) fuse it to the wall. CSS-only morph.
 *
 * Live data: the active project (name · domain · category · notes · competitors)
 * plus its `stats` rollup and the agent counts that stand behind each context
 * document. Editing name / category / description PATCHes the project.
 *
 * @module app/v2/_components/ContextPanel
 */

import { useEffect, useState, type CSSProperties } from 'react';
import type { AgentsResponse, ProjectDetail } from '@/types/terminal';
import { Scrim } from './Scrim';
import { ChevronLeft, LayersIcon } from './icons';

const OPEN_W = 320;
/** the closed nub's width — the page derives its right gutter from this */
export const CONTEXT_NUB_W = 54;
const CLOSED_W = CONTEXT_NUB_W;
const CLOSED_H = 220; // the closed nub is short + vertically centred
const RO = 24; // convex radius on the exposed (left) corners
const FR = 22; // concave flare radius where it meets the wall
const OV = 1.5; // flare overlap — kills the sub-pixel seam
const PAD = 14; // content inset from the top/bottom edges

/* concave corner flare — a masked box that welds a wall corner smoothly */
function flareStyle(side: 'top' | 'bottom'): CSSProperties {
  const corner = side === 'top' ? '0% 0%' : '0% 100%';
  const mask = `radial-gradient(circle at ${corner}, transparent ${FR}px, #000 ${FR}px)`;
  return {
    position: 'absolute',
    right: 0,
    [side]: -FR,
    width: FR + OV,
    height: FR + OV,
    background: 'var(--accent)',
    WebkitMaskImage: mask,
    maskImage: mask,
  };
}

/** competitors are stored as a JSON string on the project row */
function parseCompetitors(json: string | null | undefined): Array<{ name: string; domain: string }> {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is { name?: string; domain?: string } => typeof x === 'object' && x !== null)
      .map((x) => ({ name: x.name ?? x.domain ?? '—', domain: x.domain ?? '' }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 text-bg-raised/75">{children}</span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-eyebrow font-semibold uppercase tracking-eyebrow text-bg-raised/55">{children}</p>
  );
}

export function ContextPanel({
  project,
  agents,
  onSave,
}: {
  project: ProjectDetail | null;
  agents: AgentsResponse | null;
  onSave: (patch: { name?: string; category?: string; notes?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* reseed whenever the console switches project (or the row refreshes and the
     operator has no unsaved edit in flight) */
  useEffect(() => {
    if (!project) return;
    setName(project.name ?? '');
    setCategory(project.category ?? '');
    setNotes(project.notes ?? '');
    setDirty(false);
    setErr(null);
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Escape closes the drawer, matching the wheel and the modals */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const agentCount = (key: string) => agents?.agents.find((a) => a.key === key)?.count ?? 0;

  const docs: Array<{ label: string; count: number }> = [
    { label: 'Technical audits', count: project?.stats?.technicalAudits ?? 0 },
    { label: 'AI visibility reports', count: project?.stats?.reports ?? 0 },
    { label: 'Entity records', count: project?.stats?.entities ?? 0 },
    { label: 'Gap roadmap items', count: project?.stats?.gaps ?? 0 },
    { label: 'Personas', count: agentCount('personas') },
    { label: 'Journeys', count: agentCount('journeys') },
    { label: 'Council', count: agentCount('council') },
  ];

  const comps = parseCompetitors(project?.competitors);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave({ name: name.trim(), category: category.trim(), notes });
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
    setErr(null);
  };

  return (
    <>
      {/* the shared scrim — one opacity, one blur, and it covers the top bar */}
      <Scrim open={open} onClose={() => setOpen(false)} z={10} />

      {/* outer shell — animates size/position; never clips (so the flares show) */}
      {/* v2drawer carries the morph in CSS (see v2.css) so reduced-motion applies */}
      <div
        className="v2drawer absolute right-0 z-20 will-change-[width]"
        style={{
          width: open ? OPEN_W : CLOSED_W,
          top: open ? 12 : `calc(50% - ${CLOSED_H / 2}px)`,
          bottom: open ? 12 : `calc(50% - ${CLOSED_H / 2}px)`,
          boxShadow: '-14px 0 48px -18px rgba(26,23,18,0.34)',
        }}
      >
        {/* concave corner flares — weld the top & bottom to the wall */}
        <span aria-hidden className="pointer-events-none" style={flareStyle('top')} />
        <span aria-hidden className="pointer-events-none" style={flareStyle('bottom')} />

        {/* brass body — flush square on the wall, rounded on the exposed side;
            clips the wide content while the shell is collapsed */}
        <div className="absolute inset-0 overflow-hidden rounded-l-r5" style={{ background: 'var(--accent)' }}>
          {/* closed nub — the toggle */}
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Show context"
              className="group absolute inset-0 z-10 flex items-center justify-end pr-[15px] outline-none"
            >
              <LayersIcon className="h-5 w-5 text-bg-raised transition-transform duration-state group-hover:scale-110" />
              {dirty && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-bg-raised" />}
            </button>
          )}

          {/* content */}
          <div
            className={`absolute right-0 flex flex-col transition-opacity duration-state ${
              open ? 'opacity-100 delay-200' : 'pointer-events-none opacity-0'
            }`}
            style={{ width: OPEN_W, top: PAD, bottom: PAD }}
          >
            <div className="flex items-center gap-2 px-5 pb-3 pt-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Hide context"
                className="grid h-6 w-6 place-items-center rounded-r2 text-bg-raised/70 transition-colors hover:bg-white/12 hover:text-bg-raised"
              >
                <ChevronLeft className="h-4 w-4 rotate-180" />
              </button>
              <span className="text-caption font-semibold uppercase tracking-eyebrow text-bg-raised/75">Context</span>
              <LayersIcon className="ml-auto h-4 w-4 text-bg-raised/90" />
            </div>
            <div className="h-px bg-gradient-to-l from-white/20 via-white/10 to-transparent" />

            <div
              className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 18px), transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 14px, #000 calc(100% - 18px), transparent)',
              }}
            >
              {!project ? (
                <p className="py-8 text-center text-body text-bg-raised/60">No project selected.</p>
              ) : (
                <>
                  {/* profile */}
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-white/12 text-body font-semibold text-bg-raised">
                      {(name || project.domain).slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <input
                        value={name}
                        onChange={(e) => edit(setName)(e.target.value)}
                        placeholder="project name"
                        className="w-full bg-transparent text-title font-semibold text-bg-raised outline-none placeholder:text-bg-raised/40"
                      />
                      <div className="mt-1.5 flex flex-wrap gap-1 text-eyebrow">
                        <Tag>{project.domain}</Tag>
                        {project.status && <Tag>{project.status}</Tag>}
                      </div>
                    </div>
                  </div>

                  {/* category */}
                  <div>
                    <Label>Category</Label>
                    <input
                      value={category}
                      onChange={(e) => edit(setCategory)(e.target.value)}
                      placeholder="e.g. AI visibility diagnostics"
                      className="w-full rounded-r3 border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-body text-bg-raised/90 outline-none transition-colors placeholder:text-bg-raised/40 focus:border-white/40 focus:bg-white/[0.09]"
                    />
                  </div>

                  {/* description */}
                  <div>
                    <Label>Description</Label>
                    <textarea
                      value={notes}
                      onChange={(e) => edit(setNotes)(e.target.value)}
                      rows={3}
                      placeholder="What your CMO should know before doing anything…"
                      className="no-scrollbar w-full resize-none rounded-r3 border border-white/15 bg-white/[0.06] p-2.5 text-body leading-relaxed text-bg-raised/90 outline-none transition-colors placeholder:text-bg-raised/40 focus:border-white/40 focus:bg-white/[0.09]"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={save}
                        disabled={!dirty || saving}
                        className="rounded-r2 bg-white/12 px-2.5 py-1 text-caption font-medium text-bg-raised transition-colors hover:bg-white/20 disabled:opacity-40"
                      >
                        {saving ? 'saving…' : dirty ? 'save context' : 'saved'}
                      </button>
                      {err && <span className="truncate text-caption text-bg-raised">{err}</span>}
                    </div>
                  </div>

                  {/* documents */}
                  <div>
                    <Label>Context documents</Label>
                    <ul className="overflow-hidden rounded-r3 border border-white/12">
                      {docs.map((d, i) => (
                        <li
                          key={d.label}
                          className={`flex items-center gap-2.5 px-3 py-2 text-body transition-colors hover:bg-white/[0.07] ${
                            i ? 'border-t border-white/10' : ''
                          }`}
                        >
                          <span className="h-1 w-1 shrink-0 rounded-full bg-bg-raised/40" />
                          <span className="flex-1 truncate text-bg-raised/85">{d.label}</span>
                          {d.count > 0 ? (
                            <span className="rounded-md bg-white/14 px-1.5 py-px text-eyebrow tabular-nums text-bg-raised">{d.count}</span>
                          ) : (
                            <span className="text-eyebrow text-bg-raised/40">none</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* competitors */}
                  <div>
                    <Label>Competitors</Label>
                    {comps.length === 0 ? (
                      <p className="text-body text-bg-raised/50">None recorded on this project.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {comps.map((c) => (
                          <li key={`${c.name}-${c.domain}`} className="flex items-center gap-2.5 text-body">
                            <span className="h-1 w-1 shrink-0 rounded-full bg-bg-raised/50" />
                            <span className="text-bg-raised/85">{c.name}</span>
                            <span className="truncate text-bg-raised/45">{c.domain}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <p className="mt-auto border-t border-white/12 pt-3 text-caption leading-relaxed text-bg-raised/45">
                    What your CMO reads before doing anything — edit any of it, anytime.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

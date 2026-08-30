'use client';

/**
 * Resizable, movable workspace pane. The header carries move-left / move-right /
 * hide controls; a drag handle on the right edge resizes it. Layout (order,
 * widths, hidden) is owned by the page and persisted there.
 *
 * @module components/terminal/Pane
 */

import { useCallback, useRef } from 'react';

export const PANE_MIN = 240;
export const PANE_MAX = 680;

export function Pane({
  title,
  icon,
  width,
  headerRight,
  onResize,
  onMoveLeft,
  onMoveRight,
  onHide,
  canMoveLeft,
  canMoveRight,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  width: number;
  headerRight?: React.ReactNode;
  onResize: (w: number) => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onHide: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  children: React.ReactNode;
}) {
  const startX = useRef(0);
  const startW = useRef(0);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      const move = (ev: PointerEvent) => {
        const next = Math.min(PANE_MAX, Math.max(PANE_MIN, startW.current + (ev.clientX - startX.current)));
        onResize(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, onResize],
  );

  return (
    <section
      className="relative flex min-w-0 shrink-0 flex-col border-r border-border bg-bg-raised"
      style={{ width }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-faint">{icon}</span>
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-widest text-dim">{title}</h2>
        <div className="ml-auto flex items-center gap-0.5">
          {headerRight}
          <button
            onClick={onMoveLeft}
            disabled={!canMoveLeft}
            title="Move pane left"
            className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim disabled:opacity-20"
          >
            ◄
          </button>
          <button
            onClick={onMoveRight}
            disabled={!canMoveRight}
            title="Move pane right"
            className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim disabled:opacity-20"
          >
            ►
          </button>
          <button onClick={onHide} title="Hide pane" className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim">
            ✕
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {/* resize handle */}
      <div
        onPointerDown={onDragStart}
        title="Drag to resize"
        className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent-dim/40"
      />
    </section>
  );
}

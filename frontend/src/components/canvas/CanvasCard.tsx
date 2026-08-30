'use client';

/**
 * A card on the infinite canvas. Positioned in canvas-space; dragged by its
 * header, resized by the SE handle. All pointer deltas are divided by the
 * current zoom so movement tracks the cursor 1:1 on screen.
 *
 * @module components/canvas/CanvasCard
 */

import { useCallback, useRef } from 'react';
import type { Box } from './Canvas';

export const CARD_MIN_W = 240;
export const CARD_MIN_H = 160;

export function CanvasCard({
  box,
  zoom,
  title,
  icon,
  variant = 'default',
  headerRight,
  onChange,
  onHide,
  onFocus,
  children,
}: {
  box: Box;
  zoom: number;
  title: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'dark';
  headerRight?: React.ReactNode;
  onChange: (b: Box) => void;
  onHide: () => void;
  onFocus?: () => void;
  children: React.ReactNode;
}) {
  const boxRef = useRef(box);
  boxRef.current = box;

  const startDrag = useCallback(
    (e: React.PointerEvent, mode: 'move' | 'resize') => {
      e.preventDefault();
      e.stopPropagation();
      onFocus?.();
      const start = { x: e.clientX, y: e.clientY };
      const base = { ...boxRef.current };
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / zoom;
        const dy = (ev.clientY - start.y) / zoom;
        if (mode === 'move') {
          onChange({ ...base, x: Math.round(base.x + dx), y: Math.round(base.y + dy) });
        } else {
          onChange({
            ...base,
            w: Math.round(Math.max(CARD_MIN_W, base.w + dx)),
            h: Math.round(Math.max(CARD_MIN_H, base.h + dy)),
          });
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      document.body.style.userSelect = 'none';
    },
    [zoom, onChange, onFocus],
  );

  const dark = variant === 'dark';

  return (
    <div
      data-card
      onPointerDown={() => onFocus?.()}
      className={`absolute flex flex-col overflow-hidden rounded-lg border ${
        dark
          ? 'card-shadow-dark border-night-line bg-night text-night-text'
          : 'card-shadow border-border bg-bg-raised'
      }`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <header
        onPointerDown={(e) => startDrag(e, 'move')}
        className={`flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-3 active:cursor-grabbing ${
          dark ? 'border-night-line' : 'border-border'
        }`}
      >
        <span className="text-faint">{icon}</span>
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-widest text-dim">{title}</h2>
        <div className="ml-auto flex items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          {headerRight}
          <button onClick={onHide} title="Hide card" className="rounded p-1 text-faint hover:bg-bg-inset hover:text-dim">
            ✕
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {/* SE resize handle */}
      <div
        onPointerDown={(e) => startDrag(e, 'resize')}
        title="Drag to resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, var(--border-strong) 50% 60%, transparent 60% 72%, var(--border-strong) 72% 82%, transparent 82%)',
        }}
      />
    </div>
  );
}

'use client';

/**
 * Infinite canvas — a pannable / zoomable stage that hosts the console's cards.
 *
 * - drag empty space to pan; wheel to zoom (toward the cursor)
 * - cards are absolutely positioned in canvas-space; <CanvasCard> handles its
 *   own drag (by the header) and resize (SE handle) and reports back deltas
 *   already divided by zoom
 * - viewport + card boxes persist in localStorage['cailyx.canvas']
 *
 * No external canvas/graph library — ~150 lines of transform maths.
 *
 * @module components/canvas/Canvas
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Viewport {
  x: number;
  y: number;
  z: number;
}

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.5;

export interface CanvasHandle {
  reset: () => void;
  fit: (boxes: Box[]) => void;
  zoomBy: (factor: number) => void;
  viewport: Viewport;
}

export function Canvas({
  viewport,
  onViewport,
  children,
  onBackgroundClick,
  apiRef,
}: {
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  children: React.ReactNode;
  onBackgroundClick?: () => void;
  apiRef?: React.MutableRefObject<CanvasHandle | null>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;
  const [panning, setPanning] = useState(false);

  /* ---- pan ---- */
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // pan on any empty-canvas press — but never when it starts inside a card
      if ((e.target as HTMLElement).closest('[data-card]')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      onBackgroundClick?.();
      setPanning(true);
      document.body.style.userSelect = 'none';
      const start = { x: e.clientX, y: e.clientY };
      const base = { ...vpRef.current };
      const move = (ev: PointerEvent) => {
        onViewport({ ...base, x: base.x + (ev.clientX - start.x), y: base.y + (ev.clientY - start.y) });
      };
      const up = () => {
        setPanning(false);
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onViewport, onBackgroundClick],
  );

  /* ---- zoom (wheel, toward cursor) ---- */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const vp = vpRef.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      const nz = clamp(vp.z * (1 + dir * 0.12), ZOOM_MIN, ZOOM_MAX);
      if (nz === vp.z) return;
      const k = nz / vp.z;
      onViewport({ x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k, z: nz });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [onViewport]);

  /* ---- imperative API ---- */
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      viewport,
      reset: () => onViewport({ x: 80, y: 80, z: 1 }),
      zoomBy: (factor: number) => {
        const stage = stageRef.current;
        const vp = vpRef.current;
        const nz = clamp(vp.z * factor, ZOOM_MIN, ZOOM_MAX);
        const rect = stage?.getBoundingClientRect();
        const cx = (rect?.width ?? 800) / 2;
        const cy = (rect?.height ?? 600) / 2;
        const k = nz / vp.z;
        onViewport({ x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k, z: nz });
      },
      fit: (boxes: Box[]) => {
        const stage = stageRef.current;
        if (!stage || boxes.length === 0) return;
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        const maxY = Math.max(...boxes.map((b) => b.y + b.h));
        const pad = 60;
        const cw = stage.clientWidth;
        const ch = stage.clientHeight;
        const z = clamp(Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2)), ZOOM_MIN, ZOOM_MAX);
        onViewport({
          x: (cw - (maxX - minX) * z) / 2 - minX * z,
          y: (ch - (maxY - minY) * z) / 2 - minY * z,
          z,
        });
      },
    };
  }, [apiRef, onViewport, viewport]);

  const g = 28 * viewport.z;

  return (
    <div
      ref={stageRef}
      onPointerDown={onPointerDown}
      className={`canvas-grid relative h-full w-full overflow-hidden ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={
        {
          '--grid': `${g}px`,
          '--grid-x': `${viewport.x % g}px`,
          '--grid-y': `${viewport.y % g}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.z})` }}
      >
        {children}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

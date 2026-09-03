'use client';

/**
 * GooeyNav — /v2 copy. Connected "liquid pill" control group: pill shapes and a
 * sliding highlight blob live inside an SVG goo filter (blur + alpha-contrast)
 * so the blob stretches and merges with the pills like metaball liquid; the
 * crisp icon/label buttons ride on top. Classes are `v2goo-*` (see v2.css) so
 * this is fully independent of the shared component.
 *
 * @module app/v2/_components/GooeyNav
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface GooeyItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  /** parks the blob under this item while the pointer is elsewhere */
  active?: boolean;
  title?: string;
}

type Box = { left: number; width: number };

export function GooeyNav({ items, className = '' }: { items: GooeyItem[]; className?: string }) {
  const filterId = `v2goo-${useId().replace(/:/g, '')}`;
  const rowRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [hover, setHover] = useState<number | null>(null);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const base = row.getBoundingClientRect().left;
    setBoxes(
      btnRefs.current.map((b) => {
        const r = b?.getBoundingClientRect();
        return r ? { left: r.left - base, width: r.width } : { left: 0, width: 0 };
      }),
    );
  }, []);

  useLayoutEffect(measure, [measure, items.length]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    const row = rowRef.current;
    if (row) ro.observe(row);
    window.addEventListener('resize', measure);
    const t = setTimeout(measure, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      clearTimeout(t);
    };
  }, [measure]);

  const activeIdx = items.findIndex((i) => i.active);
  const target = hover ?? (activeIdx >= 0 ? activeIdx : null);
  const blob = target !== null ? boxes[target] : undefined;

  return (
    <div className={`v2goo-nav ${className}`} onMouseLeave={() => setHover(null)}>
      <svg width="0" height="0" className="v2goo-defs" aria-hidden>
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>

      <div className="v2goo-layer" style={{ filter: `url(#${filterId})` }} aria-hidden>
        {boxes.map((b, i) =>
          b.width > 0 ? (
            <span
              key={i}
              className="v2goo-pill"
              style={{ transform: `translateX(${b.left}px)`, width: b.width }}
            />
          ) : null,
        )}
        {blob && blob.width > 0 && (
          <span
            className="v2goo-blob"
            style={{ transform: `translateX(${blob.left}px)`, width: blob.width }}
          />
        )}
      </div>

      <div className="v2goo-row" ref={rowRef}>
        {items.map((it, i) => (
          <button
            key={it.key}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            title={it.title}
            onClick={it.onClick}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            className={`v2goo-item ${target === i ? 'is-on' : ''}`}
          >
            {it.icon && <span className="v2goo-ic">{it.icon}</span>}
            <span className="v2goo-lb">{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

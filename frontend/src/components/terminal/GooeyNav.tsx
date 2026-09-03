'use client';

/**
 * GooeyNav — a connected "liquid pill" control group. The pill shapes and a
 * highlight blob that slides between them live inside an SVG goo filter (blur +
 * alpha-contrast), so the blob stretches and merges with the pills like metaball
 * liquid as it moves; the crisp icon/label buttons ride on top, outside the
 * filter. Behaviour only — it inherits the app font (Urbanist) and paints purely
 * from the Rothenhall theme tokens.
 *
 * @module components/terminal/GooeyNav
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
  const filterId = `goo-${useId().replace(/:/g, '')}`;
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
    // fonts settling can shift widths after first paint
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
    <div className={`goo-nav ${className}`} onMouseLeave={() => setHover(null)}>
      <svg width="0" height="0" className="goo-defs" aria-hidden>
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

      {/* goo layer: static pills + the sliding blob, merged by the filter */}
      <div className="goo-layer" style={{ filter: `url(#${filterId})` }} aria-hidden>
        {boxes.map((b, i) =>
          b.width > 0 ? (
            <span
              key={i}
              className="goo-pill"
              style={{ transform: `translateX(${b.left}px)`, width: b.width }}
            />
          ) : null,
        )}
        {blob && blob.width > 0 && (
          <span
            className="goo-blob"
            style={{ transform: `translateX(${blob.left}px)`, width: blob.width }}
          />
        )}
      </div>

      {/* crisp layer: the real buttons — define geometry, carry the handlers */}
      <div className="goo-row" ref={rowRef}>
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
            className={`goo-item ${target === i ? 'is-on' : ''}`}
          >
            {it.icon && <span className="goo-ic">{it.icon}</span>}
            <span className="goo-lb">{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

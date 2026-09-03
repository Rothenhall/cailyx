---
name: frosted-glass-panel
description: >-
  Build the frosted-glass floating control the Cailyx canvas uses for its
  bottom-left zoom widget (− 55% + | fit): a translucent raised-surface pill
  with a backdrop blur, hairline border, and faint low-contrast controls that
  lift on hover. Use when asked for a "glass" / "frosted" overlay control,
  toolbar, HUD chip, or hint pill that floats over content without blocking it.
---

# Frosted-glass panel

The look: a small pill/toolbar that sits `absolute` over a busy surface (canvas,
map, editor), reads as glass because the content behind it blurs through, and
keeps its own controls quiet (`text-faint`) until hovered. Source of truth is
the v1 canvas zoom control in `frontend/src/app/page.tsx` (~line 451).

## Recipe

Container:

| purpose            | classes                                              |
| ------------------ | ---------------------------------------------------- |
| float over content | `absolute bottom-4 left-4 z-30`                      |
| the glass          | `bg-bg-raised/90 backdrop-blur`                      |
| edge               | `border border-border`                               |
| shape + density    | `rounded-md px-1 py-0.5 text-xs`                     |
| layout             | `flex items-center gap-1`                            |

Each control (button):

- `rounded px-2 py-1`
- rest: `text-faint`
- hover: `hover:bg-bg-inset hover:text-dim`

Readout (the `55%` label): `w-10 text-center text-faint` — fixed width so the
pill doesn't jump as the number changes.

Divider between groups: `<span className="mx-1 h-4 w-px bg-border" />`

Hint-pill variant (v1's bottom-right helper text): drop the border and buttons —
`absolute bottom-4 right-4 z-30 rounded bg-bg-raised/80 px-2 py-1 text-[10px] text-faint backdrop-blur`.

## Drop-in component

```tsx
interface GlassControlProps {
  zoom: number;                 // 1 = 100%
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

/** Frosted-glass zoom control — floats bottom-left over a zoomable surface. */
export function GlassZoomControl({ zoom, onZoomIn, onZoomOut, onFit }: GlassControlProps) {
  return (
    <div className="absolute bottom-4 left-4 z-30 flex items-center gap-1 rounded-md border border-border bg-bg-raised/90 px-1 py-0.5 text-xs backdrop-blur">
      <button onClick={onZoomOut} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">−</button>
      <span className="w-10 text-center text-faint">{Math.round(zoom * 100)}%</span>
      <button onClick={onZoomIn} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">+</button>
      <span className="mx-1 h-4 w-px bg-border" />
      <button onClick={onFit} className="rounded px-2 py-1 text-faint hover:bg-bg-inset hover:text-dim">fit</button>
    </div>
  );
}
```

## Theme tokens it leans on

Defined in `frontend/src/app/globals.css`, exposed as Tailwind colours:

| token          | light value | utility        | role here                       |
| -------------- | ----------- | -------------- | ------------------------------- |
| `--bg-raised`  | `#fbf9f3`   | `bg-bg-raised` | the glass body (at `/80`–`/90`) |
| `--bg-inset`   | `#f2ecdf`   | `bg-bg-inset`  | button hover fill               |
| `--border`     | `#ddd5c4`   | `border-border`| hairline edge + divider         |
| `--text-dim`   | `#5c5648`   | `text-dim`     | control text on hover           |
| `--text-faint` | `#857d6c`   | `text-faint`   | control text at rest, readout   |

Outside Cailyx, map these to the host theme's equivalents — a near-opaque
raised surface, a one-step-darker inset, a low-contrast hairline, and two
muted text greys.

## Notes

- **The blur must be a Tailwind utility (`backdrop-blur`), not raw CSS.** The
  Next 16 CSS pipeline strips a bare `backdrop-filter` declaration out of
  `.css` files; the utility class (or an inline `style`) survives.
- Keep the surface opacity high (`/80`–`/90`). Lower and the blur alone can't
  carry legibility over a noisy background.
- `backdrop-blur` needs actual content behind it — over a flat background it
  just looks like a slightly translucent box.
- Fixed-width readout (`w-10`) stops layout shift as the value changes.
- Give the container an explicit `z-` above the content layer it floats over.
- The whole pattern is one translucent element + blur + hairline + quiet
  controls; scale it up to a full toolbar or HUD by adding more button groups
  separated by the `w-px bg-border` divider.

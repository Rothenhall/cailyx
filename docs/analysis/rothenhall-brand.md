# Analysis — Rothenhall brand applied to the Cailyx web app

Date: 2026-09-20
Source of truth: `Brand/tokens/brand.css`, Rothenhall Partners Brand Kit **v1.1.0**
(2026-09-17), which mirrors `millbrook/src/styles.css`'s `@theme` block.
Target: `web/` — the deployed client-facing Cailyx app (`cailyx-web`, Vercel, port 3010).

Status: applied. `npx tsc --noEmit` clean, `npm run build` clean, values verified in
a real browser.

---

## 1. Why this was a one-file change

`web/` was already built for this. `web/tailwind.config.ts` maps every colour as
`hsl(var(--token))` and its header states the rule: components never write a raw
hex, "that is what makes a future theme/branding override (G20) possible without
touching component source." The audit confirmed the discipline held:

| Measured | Result |
|---|---|
| Raw hex in `web/src/**/*.ts(x)` (262 files) | **1** — an input placeholder, `admin/settings/page.tsx:432` |
| `rgb()` / `rgba()` / `hsl()` literals | 4, all inside `charts/tokens.ts`, one of them a comment |
| Inline `style={{ color }}` literals | 0 — both chart ones read `tokens.surface` / `tokens.border` |
| SVG `fill` / `stroke` hardcodes | 0 — all five use `tokens.*` |
| Tailwind arbitrary colour classes (`text-[#…]`) | 0 |
| Token-bypassing utilities (`bg-white`, `text-black`, `bg-slate-*`) | 0 |
| `bg-black/80` scrims | 3 — the only real exception, now `bg-night/80` |

Recharts reads the same CSS variables through `charts/tokens.ts`, so charts
re-skin themselves. That is why no component, chart or report needed editing.

## 2. Integration shape, not a paste

The kit's `tokens/tailwind-theme.css` is a **Tailwind v4** `@theme` block. `web/` is
**Tailwind v3.4.17**, and its utility names (`bg-canvas`, `text-ink-60`) differ from
the app's role names (`bg-surface`, `text-muted-foreground`). Pasting it would have
renamed classes used at ~400 call sites. So brand primitives were mapped onto
Cailyx's existing §3.1 role tokens instead: **roles stay `design_plan.md` §3.1's,
values become the kit's.**

Values are stored as HSL triplets to keep Tailwind's alpha channel working, written
to **one decimal place**. Integer rounding is not cosmetic here: `#f7f3ea` at
`42 45% 94%` round-trips to `#f7f2e9`, a different colour. Every token in the file
carries its source hex in a comment and round-trips exactly, so the mapping stays
auditable against the kit.

## 3. The mapping

| Cailyx role | Was | Now | Kit primitive |
|---|---|---|---|
| `--canvas` | `#F5F7FA` | `#f7f3ea` | canvas |
| `--surface` | `#FFFFFF` | `#fbf9f3` | paper |
| `--surface-sunken`, `--muted` | `#EBF0F6` | `#efe9dc` | canvas-2 |
| `--foreground` | `#172033` | `#1a1712` | ink |
| `--muted-foreground` | `#526075` | `#5c5648` | ink-60 |
| `--border` | `#DCE3EC` | `#ddd5c4` | line |
| `--border-strong` | `#B7C1CD` | `#857d6c` | ink-45 *(deviation, §4)* |
| `--primary` | `#2449C7` | `#1a1712` | ink (`.btn-primary`) |
| `--primary-hover` | `#1D3EA9` | `#7c6238` | brass-deep |
| `--primary-foreground` | `#FFFFFF` | `#f7f3ea` | canvas |
| `--danger` | `#AD2838` | `#9d3b2f` | alert |
| `--info` | blue | `#7c6238` | brass-deep |
| `--unmeasured` | cool gray | `#857d6c` | ink-45 |
| `--ring` | `#2449C7` | `#8a4a26` | cognac-deep *(deviation, §4)* |
| `--link` | *(new)* | `#8a4a26` | cognac-deep |
| `--night`, `--night-2`, `--night-line` | *(new)* | `#14120d`, `#201c15`, `#35301f` | night |
| radius input / card / dialog | 8 / 12 / 16 px | **2 / 2 / 4 px** | `--rh-radius-card` |
| buttons | `rounded-md` | `rounded-full` | `--rh-radius-pill` |
| `--font-sans` | system stack | **Instrument Sans** | kit |
| `--font-display` | *(new)* | **Jost**, on `h1`–`h4` | kit |

Type scale keeps §3.1's six names and takes the kit's ramp: `meta` 0.8rem, `table`
0.9rem, `body` 1.02rem, `subsection` 1.12rem, `title` 1.9rem / -0.012em, `kpi`
2.4rem / -0.018em. Both faces load through `next/font` (self-hosted at build, with
sized fallbacks), and `globals.css` resolves them behind a system fallback so the
app still renders if a font fails.

## 4. Three deliberate deviations, each measured

The kit governs a marketing site. Cailyx is a data product, and three of the kit's
literal choices do not survive contact with that. Each is commented at the token.

1. **Focus ring: `cognac-deep`, not the kit's `cognac-soft`.** `cognac-soft` on
   canvas measures **2.97:1**, under the 3:1 non-text floor for a focus indicator.
   `cognac-deep` is the same hue one step deeper at **6.14:1**.
2. **Input boundaries: `ink-45`, not the kit's `line-strong`.** `line-strong` is
   **1.63:1** against canvas. `design_plan.md` §3.1 already asks for "stronger
   contrast for essential input boundaries", and the kit itself labels `line`
   "decorative only, never the sole affordance" — so a control edge takes `ink-45`
   (**3.68:1**). Decorative hairlines keep `line`.
3. **Figures stay lining tabular, not the kit's `onum`.** The kit asks for
   old-style figures in prose. Cailyx renders measurements, dates and deltas where
   digits of varying height are a legibility cost, so `font-variant-numeric:
   tabular-nums` stays global.

**Status colours are kept functional.** The kit specifies only one alert colour and
is silent on success/warning/info/unmeasured. Those four carry verdicts a client
acts on, so they were not derived from the warm palette; `danger` does move to the
kit's `alert`, which was itself chosen to sit in the cognac family. `info` takes
brass-deep so warm-on-warm information stops reading as a link, and its text is
`ink-80`.

## 5. Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean; `next/font` fetched and self-hosted Jost + Instrument Sans.
- Compiled CSS: `--canvas:41.5 44.8% 94.3%`; `bg-night/80` → `hsl(var(--night)/.8)`.
- Chrome via Playwright, computed values: body `rgb(247,243,234)` = `#f7f3ea` exactly,
  body font `Instrument Sans`, headings `Jost`, primary button `rgb(26,23,18)` =
  `#1a1712` at `border-radius: 9999px`, cards `2px`, both faces in `document.fonts`.
- Screenshots of `/sign-in`, `/request-audit`, `/welcome/security` reviewed.
- Contrast: every text pairing measured AA (16.14:1 body text on canvas down to
  5.4:1 warning on its fill); `ink-45` is used only as an indicator or border, never
  as body text, per the kit's own "large type only" restriction.

### A latent bug this exposed

All **25** opacity-modifier classes in `web/src` were compiling to nothing.
`hsl(var(--x))` mappings cannot take a `/30` modifier in Tailwind v3 without the
`<alpha-value>` placeholder, so `border-danger/30`, `border-warning/40`,
`bg-secondary/80` and the rest emitted no rule at all — every tinted status border
and alpha hover state in the app has been silently absent. The old button's
`hover:bg-primary/90` likewise did nothing. Rewriting all 45 mappings as
`hsl(var(--x) / <alpha-value>)` repairs them. The new scrim is what surfaced it:
`bg-night/80` rendered no background at all.

## 6. Identity rule compliance

Kit `app/identity/page.tsx:149`: *"Cailyx never appears without Rothenhall in the
same view, at minimum in the footer."* No signed-in or public surface previously
mentioned Rothenhall. Added:

- `AppShell.tsx` — a `Wordmark` component ("Cailyx" + "A Rothenhall product") in the
  desktop nav, and the same credit in the mobile drawer.
- `PublicShell.tsx` — "Cailyx is built and run by Rothenhall." in the shared/public footer.
- `(auth)/sign-in/page.tsx` — the page owns its own wordmark, so it carries the credit
  in both the form and the Suspense fallback.

Naming follows the kit: *Rothenhall* one word, capitals R and H; *Cailyx* capital C,
no article.

## 7. Left for later

1. **Heading weight.** The base rule sets Jost 400, but ~170 headings carry
   `font-semibold`, and utilities beat the base layer — so headings render at 600.
   Making them 400 means removing `font-semibold` from heading call sites, which is
   a component sweep, not a token change.
2. **No logo or favicon.** `web/` still has no `public/` directory. The kit ships
   `wordmark.png`, both griffin cuts and favicons; `Brand` notes there is **no SVG**
   of any mark yet, so a crisp favicon is blocked on the kit producing one.
3. **Signed-in surfaces unverified visually.** The local database is a freshly
   pushed empty schema, so there is no user to sign in as; `/ops` and `/client`
   renders are untested. The token layer is shared, so the risk is layout, not colour.
4. **`primaryColor` is still inert.** The G20 admin field stores and serves a colour
   but no code applies it to the DOM, so per-organisation theming remains open
   (G20 interim: "fixed application design; no fake editable settings").
5. **Legacy `frontend/` untouched** — `docs/analysis/AGENT-BRIEF.md` marks it and
   `client-portal/` do-not-touch, and `frontend/src/app/globals.css:12-30` already
   carries the same cream/brass/cognac palette.
6. **Kit sync is manual.** The kit states its three token files do not auto-sync.
   Nothing here enforces that Cailyx's triplets keep matching; a check script that
   fails when a hex drifts from `Brand/tokens/brand.css` is the obvious next guard.
7. `PublicShell`'s footer disclaimer ("This page shows a snapshot taken when it was
   published") now reads oddly on `/request-audit`, which is a form, not a snapshot.
   Pre-existing copy, out of scope here.

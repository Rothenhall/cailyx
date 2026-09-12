# UI/UX refinement — making the console show what the backend already knows

> **Status:** ✅ phases 1-4 built 2026-09-12 (phase 5 outstanding)
> **Asked for:** *"a much cleaner, better and more feasible UI… it's about the
> user experience with the content we have as per modules… competitor analysis
> UI is also not there… analyze backend and we need a solid improvements plan"*

---

## 1. The finding, in one number

**39 backend modules. 231 REST endpoints. The frontend makes 75 calls, covering
roughly 40 distinct routes — under a fifth of the surface.**

That is not a styling problem and no amount of visual polish fixes it. The
console is a **launcher** for work whose results are then invisible.

The clearest evidence is the agent feed. There are twelve agent cards. Ten of
them render `RunPanel` — a form and a **Run** button. When the run finishes the
operator gets a one-line toast headline, and the actual output goes into the
database unread. Only two cards (`attribution`, `rivals`) have a panel that
*shows* anything.

| Agent card | Can you run it? | Can you read the result? |
|---|---|---|
| `attribution` | ✅ | ✅ |
| `rivals` | ✅ | ✅ |
| `aeo`, `seo` | ✅ | ⚠️ only via a separate workspace |
| `authority`, `council`, `journeys`, `mentions`, `monitoring`, `personas`, `serp`, `articles` | ✅ | ❌ **nothing** |

Eight modules produce real, structured, expensive output that a delivery lead
cannot see without opening the database.

---

## 2. Why "competitor analysis UI is not there"

It *is* there — I built it — and the complaint is still correct, because it is
unreachable in practice. Today the path is:

```
Agents feed → find the "rivals" card among twelve → click it
            → RivalsPanel → "Full gap analysis →" → workspace
```

Four steps, and the first one requires knowing that "rivals" is where
competitors live. A workspace nobody can find is a workspace that does not
exist. Same story for **tech stack** (buried as the 5th section inside the
Technical audit) and **keyword research** (no UI at all).

**The root cause is that there is no home for a module's output.** The console
has exactly three places anything can live: the Audits card (four disciplines),
the agent feed (run buttons), and full-canvas workspaces (four of them, each
reached from a different unrelated place). Anything that is not one of those four
disciplines has nowhere to go, so it gets wedged behind whatever surface is
nearest.

---

## 3. What the operator actually needs, in order

A delivery lead opening this console has three jobs, and the current layout
serves only the first:

1. **"What do we know about this client?"** — partially served (Presence card,
   Context drawer, Audits card).
2. **"What did the last run find?"** — **not served** for eight of twelve agents.
3. **"What do I show the client?"** — **not served at all.** `reporting` (4
   endpoints, branded HTML report) and `scorecard` (4 endpoints, public
   shareable token) have no UI whatsoever. The thing the business sells is the
   one thing the console cannot produce.

---

## 4. Proposed decisions

### U1 — One result surface, not eleven bespoke ones ✅ *recommended*

The instinct is to build a workspace per module. That is how we got four
workspaces with four different entry points, and doing it eight more times
produces a console nobody can navigate.

Instead: **one `ModuleReport` surface** that takes a module key and renders its
latest run — headline, counted metrics, evidence rows, provenance, and "not
measured" gaps. Every module already returns the same *shape* of thing (a run
with a status, a cost, findings and honest absences), which is why one component
can serve them.

Bespoke workspaces stay only where the data genuinely is not a run-and-findings
shape: AEO (cross-engine × market matrix), Presence (three-state inventory),
Competitors (diff).

**Cost:** one component, then ~15 lines of config per module. **Rejected
alternative:** eight more workspaces — four weeks, and the navigation problem
gets worse, not better.

### U2 — A real left-hand navigation rail ✅ *recommended*

The console currently has no navigation. It has a fixed three-band canvas
(Flywheel / Audits / Agents feed) plus workspaces that take over the screen.
Everything is reached from inside something else.

Add a slim rail with the actual top-level sections:

```
  Overview      the current three-band canvas, unchanged
  Presence      accounts, gaps, footprint
  Audits        technical · SEO · AEO · GEO
  Competitors   gap, profiles          ← fixes "not there"
  Keywords      research               ← fixes "no UI at all"
  Agents        run + read             ← U1 lands here
  Deliverables  reports & scorecards   ← fixes §3 job 3
```

This is the smallest change that makes every module reachable in **one** click
and gives new modules somewhere to land without wedging them behind a card.

### U3 — Collapse the Audits card's dual role ⚠️ *needs your call*

The Audits card currently does two contradictory jobs: it is a *summary* (scores
at a glance) and a *launcher* (click a tile → full workspace). At 320px it does
neither well, and below 1000px viewport it is **hidden entirely** — which means
on a laptop in a client meeting the audit summary silently disappears.

Options:
- **(a)** Keep it as pure summary; launching moves to the rail. *Recommended* —
  one job each.
- **(b)** Keep it as pure launcher, move scores into the Overview band.
- **(c)** Leave as-is and only fix the responsive hiding.

### U4 — Every result view states its provenance ✅ *carry forward*

This is already the rule in `aeo-audit` (counted vs judged), `digital-presence`
(confirmed / unverified / candidate) and `technical-audit` (`not-checked` ≠
`none`). The new surfaces must inherit it rather than reinvent a softer version.
Concretely, every `ModuleReport` gets a **"not measured"** block, because the
most expensive UX failure in this product is a client reading an absence as a
finding.

---

## 5. Phased plan

Ordered so each phase is useful on its own and nothing is thrown away later.

> **Built 2026-09-12.** Phases 1-4 landed in one pass. The open questions in §7
> were answered by taking my own recommendations — phase order as written, Audits
> card becomes pure summary (U3 option **a**), surfaces treated as
> operator-internal with `reporting` the only client artefact. Say if any of
> those was the wrong call.

### Phase 1 — Navigation (U2) · ~1 day
The rail, routing between sections, and moving the four existing workspaces onto
it. **No new content.** This alone fixes "competitor analysis UI is not there",
surfaces tech stack, and gives keyword research a home.

### Phase 2 — `ModuleReport` + the four highest-value modules (U1) · ~2 days
`authority`, `serp`, `mentions`, `monitoring` — the four with the most stored
output and the clearest client value. Proves the shared component before it is
committed to eleven times.

### Phase 3 — Remaining agent reads · ~1–2 days
`council`, `journeys`, `personas`, `articles`. Same component, config only.

### Phase 4 — Deliverables (§3 job 3) · ~2 days
`reporting` + `scorecard`: list, generate, preview, copy public link. This is the
one that changes what the business can *do*, not just what it can see.

### Phase 5 — Responsive + density pass (U3) · ~1 day
Fix the <1000px cliff, settle the Audits card's role, one typography/spacing pass
across the new surfaces.

**Total ≈ 7–8 days.** Phases 1 and 2 deliver most of the perceived improvement.

---

## 6. What I am explicitly not proposing

- **A visual redesign.** The design system (`v2.css`, the type/radius/motion
  ladders, the status ramp) is coherent and not the problem. Restyling would burn
  the budget without making one extra module readable.
- **A component library swap.** Same reason.
- **Charts everywhere.** Most of this data is categorical — diffs, states,
  inventories. A chart would decorate it, not clarify it. Where a rate genuinely
  moves over time (audit scores, mention rate) the trend views already exist.

---

## 7. Open questions

1. **Phase order** — is Deliverables (phase 4) more urgent than the agent reads
   (phases 2–3)? If reports are what you are blocked on commercially, it should
   go second, not fourth.
2. **U3** — which of (a)/(b)/(c) for the Audits card?
3. **Scope of "client-facing"** — should any of these surfaces be designed for a
   client to look at over your shoulder, or are they all operator-internal with
   `reporting` being the only client artefact? This changes the tone of every
   empty state and every honest-absence message.

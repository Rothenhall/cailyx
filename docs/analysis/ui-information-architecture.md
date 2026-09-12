# Information architecture — structuring the console around the work, not the modules

> **Status:** research + proposal, pending approval
> **Supersedes the navigation half of** `docs/analysis/ui-ux-refinement.md`
> **Asked for:** *"it's about frontend arrangement, UI structuring, user
> experience is the main point — you need to do a bit research about this"*

---

## 1. The research finding that matters most

> *"Navigation menus should be structured according to user expectations, not
> internal company logic. Poor navigation is consistently the top reason CRM
> projects fail post-launch — not missing features, but **inaccessible** ones."*
> — [Lollypop, SaaS navigation design](https://lollypop.design/blog/2025/december/saas-navigation-menu-design/)

The literature splits navigation IA into three shapes:

| Shape | Organised around | Fits when |
|---|---|---|
| **Feature-module** | the codebase's own modules | almost never — it is internal logic leaking out |
| **Object-oriented** | the things users work with (clients, projects, campaigns) | users think in nouns |
| **Workflow** | the steps of a process | the work is a sequence with an output |

**The rail I shipped is feature-module**, which the research names as the
anti-pattern:

```
Overview · Presence · Audits · Rivals · Keywords · Agents · Reports
```

`Agents` is the giveaway. It is not a thing a delivery lead thinks about — it is
how *our backend* is organised. `Presence`, `Rivals` and `Keywords` are module
names too. I fixed reachability (a real problem) with a structure that mirrors
the repo directory listing.

---

## 2. What this product actually is

Two facts decide the right shape, and both are already in the repo:

1. **The central object is the client.** Everything hangs off `projectId`. That
   is object-oriented IA, and it is already correct — the project switcher lives
   in the top bar and everything below it is scoped to one client.
2. **The work is a sequence with an output.** The delivery flowchart
   (`Untitled-2026-09-11-1332.excalidraw`) is twelve ordered stages ending in a
   report. That is textbook workflow IA.

So: **object at the top (which client), workflow below it (where are we with
them).** Not a module list.

---

## 3. The proposed structure

The twelve stages collapse cleanly into four phases, because the flowchart
already groups them that way:

| Phase | Flowchart stages | The question it answers |
|---|---|---|
| **Understand** | 1 Discovery · 2 External presence · 3 Tech stack | *Who are they and where do they exist?* |
| **Diagnose** | 4 SEO/Technical · 5 Search & AEO · 6 Market/geo · 7 Competitors | *What is wrong, and how do they compare?* |
| **Decide** | 8 Findings · 9 Strategy · 10 Keywords | *What should they do about it?* |
| **Deliver** | 11 Execution · 12 Final output | *What do we send them?* |

Four top-level items — inside the 5–7 the dashboard literature recommends, and
each one is a sentence a delivery lead would actually say.

Every current surface has a home, and none needs a module name:

```
Understand   Identity · Digital footprint · Technology
Diagnose     Technical · SEO · AEO · Rivals
Decide       Findings · Keywords · Strategy
Deliver      Reports · Scorecards
```

`Agents` disappears as a destination. Running things becomes an **action
available inside the phase it belongs to**, which is where an operator is
already standing when they need it — not a separate place they have to
remember to visit.

---

## 4. The three patterns to apply inside each phase

### P1 — Overview → drill, not tabs-on-tabs

> *"Rather than showing 20+ charts at once, start with 3–5 state signals, a
> worklist, then diagnosis."* — [Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)

Current state is the opposite: `DigitalPresenceWorkspace` opens on five tabs,
`CompetitorsWorkspace` on five, `AeoAuditWorkspace` on six. A tab strip is a
*peer* structure — it says "these five things are equally important", which is
never true. Each phase should open on **a few state signals and a worklist**,
with tabs demoted to drill-downs reached from a signal.

Concretely for Diagnose: open on four scores and "the 6 things to fix first",
not on a tab bar.

### P2 — Progressive disclosure, with the honest-absence rule kept

> *"Show only the most important information first, with deeper details
> available when needed."* — [Cluster](https://clusterdesign.io/information-hierarchy-in-dashboards/)

One caveat specific to this product: our modules deliberately distinguish
`not-checked` from `none`. **Progressive disclosure must never hide a
"not measured" line** — collapsing it is exactly how an absence gets read as a
finding. Unmeasured things stay visible at the top level; it is *detail* that
collapses, not caveats.

### P3 — Breadcrumbs, because this is now multi-level

> *"Breadcrumb navigation keeps users oriented inside a multi-level product."*
> — [GitNexa](https://www.gitnexa.com/blogs/saas-dashboard-ux-patterns)

`Rothenhall › Diagnose › AEO › Markets` tells you where you are and gets you
back one level. Today every workspace has a single back arrow that dumps you to
Overview regardless of how deep you went.

---

## 5. What changes, concretely

| Now | Proposed | Why |
|---|---|---|
| 7 module-named rail items | 4 phase-named items | Matches how the work is described, not how it is coded |
| `Agents` as a place | Runs live inside their phase | "Agents" is our word, not the operator's |
| Workspaces open on tab strips | Open on signals + worklist | Tabs claim equal importance; findings are not equal |
| One back arrow → Overview | Breadcrumb trail | Orientation in a now-multi-level product |
| Audits card hidden < 1000px | Phase content reflows | Losing the summary in a client meeting is not acceptable |

**What does not change:** the visual design system, the project switcher, the
Flywheel/Context canvas as the Overview, and every honest-provenance rule
(`counted` vs `judged`, three-state presence, `not-checked` ≠ `none`).

---

## 6. Cost, and what I would cut

- **Re-label + regroup the rail into 4 phases:** ~half a day. Highest ratio of
  improvement to effort in this document.
- **Phase landing pages (signals + worklist):** ~2 days, the real work.
- **Breadcrumbs:** ~half a day.
- **Folding agent runs into phases:** ~1 day.

If only one thing gets done, do the **rail regroup** — it is mostly renaming and
it removes the anti-pattern. If only two, add **Diagnose's landing page**, since
that is where an operator spends their time.

---

## 7. What I need from you

1. **Do the four phase names land?** *Understand / Diagnose / Decide / Deliver* —
   or do you use different words with clients that should be the labels instead?
2. **Is the operator and the client the same reader?** If a client ever sees this
   screen, the phase names become client-facing copy and I would write them
   differently.
3. **Should Overview survive?** With four phases, the Flywheel canvas may be a
   fifth thing competing with them rather than a home. I lean toward keeping it
   as the landing page and not a rail item.

---

## Sources

- [Lollypop — Designing your SaaS navigation menu](https://lollypop.design/blog/2025/december/saas-navigation-menu-design/)
- [Pencil & Paper — Dashboard design UX patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)
- [Cluster — Information hierarchy in dashboards](https://clusterdesign.io/information-hierarchy-in-dashboards/)
- [GitNexa — SaaS dashboard UX patterns 2026](https://www.gitnexa.com/blogs/saas-dashboard-ux-patterns)
- [UITOP — Dashboard design patterns for data-heavy SaaS](https://uitop.design/blog/best-dashboard-design-patterns-for-data-heavy-saas-platforms/)
- [IxDF — Progressive disclosure](https://ixdf.org/literature/topics/progressive-disclosure)

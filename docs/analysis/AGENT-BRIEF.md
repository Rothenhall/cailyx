# Agent brief — design_plan.md build-out

Read this before touching anything. It is the same for every agent on this build.

## The repo

- `backend/` — NestJS + Prisma (SQLite), served at `http://localhost:3002/api`.
- `web/` — **NEW** Next.js 15 App Router frontend (port 3010). This is the design plan's target app.
- `frontend/`, `client-portal/` — **DO NOT TOUCH.** Legacy apps, explicitly out of scope.
- `design_plan.md` (2,279 lines) — the specification. Appendix A (line 1591+) holds the
  backend contracts; §4 (line 341+) holds the screen inventory.
- `docs/analysis/design-plan-implementation.md` — the build plan and package map.

## Already done for you — do not redo, do not edit

| File | Why it is off-limits |
|---|---|
| `backend/prisma/schema.prisma` | Every G01–G20 model is already added and pushed to the DB. The Prisma client is generated. If you genuinely need a field that is missing, **report it — do not edit the file.** |
| `backend/src/app.module.ts` | All 15 new modules are already imported and registered. |
| `web/package.json`, `web/tailwind.config.ts`, `web/src/app/globals.css` | Tokens and deps are set. Need a package? Report it, do not install. |
| `web/src/components/ui/*` | 30 shadcn/ui primitives, already generated. |

Each new backend module already has a compiling placeholder `*.module.ts`,
`*.controller.ts` and `*.service.ts`. **Replace the controller and service bodies**;
keep the class names and the module registration intact.

## Hard rules

1. **Scope is enforced on the server.** Every handler derives or validates `clientId` /
   `projectId` ownership before it touches a row. A nested id in a URL
   (`/projects/:projectId/reports/:slug`) must be checked *against that projectId*, not
   resolved on its own. Hiding a control in the UI is never the access control.
2. **Never invent data.** No placeholder numbers, no mock arrays, no `Math.random()`, no
   lorem ipsum. If a capability does not exist yet, render the explicit unavailable state
   from design_plan §3.5.
3. **Empty is not zero, and no baseline is not a decline.** A missing measurement renders as
   "Not measured yet" with the prerequisite — never as `0`, never as a failing score.
4. **Units and provenance stay explicit.** Credits are not dollars. Percentage points are not
   relative percentages. "Measured", "model interpretation", "operator supplied" and
   "unmeasured" are visibly different things.
5. **No new dependencies.** Everything you need is installed. If it truly is not, say so in
   your final report and work around it.
6. **TypeScript strict.** No `any`. `npx tsc --noEmit` must pass in the app you touched
   (`backend/` or `web/`) before you finish.
7. **Stay in your lane.** Only touch the files your task names. Another agent is working in
   the next directory over, right now.

## Backend conventions

- Files `kebab-case.ts`; classes `PascalCase`; a module owns its `dto/`, controller, service.
- `PrismaService` is global (`DatabaseModule`) — inject it, do not import the module.
- Access decorators live in `backend/src/common/decorators/auth.decorators.ts`:
  - `@Public()` — opt out of the global JWT guard.
  - `@Roles(...)` — restrict an **operator** route to roles; `admin` always passes.
  - `@ClientPortal()` — mark a route as client-surface. A `type: "client"` user can reach
    **only** routes marked this way; an operator cannot reach them at all. Default-deny.
- `@CurrentUser()` (`common/decorators/current-user.decorator.ts`) gives the JWT payload.
- Every endpoint gets `@ApiTags`, `@ApiOperation`, `@ApiResponse`; every DTO property gets
  `@ApiProperty`. Validate input with `class-validator` DTOs.
- SQLite has no enums and no arrays: status columns are `String` (permitted values in a
  comment), list/object columns are JSON strings. Parse and re-serialize explicitly.
- JSDoc every public method, and say *why* where the reason is not obvious.

## Frontend conventions (`web/`)

Three layers, strictly:

```
web/src/components/ui/        shadcn/ui primitives — GENERATED, do not hand-edit
web/src/components/patterns/  design_plan §3.3 shared components, composed from ui/
web/src/components/layouts/   §3.2 page anatomy shells
web/src/services/             typed API adapters — the ONLY place fetch happens
```

- **Reuse before you write.** Check `ui/`, then `patterns/`, then write. Need a button? Use
  `@/components/ui/button`. A new visual variant belongs in that primitive's CVA config, not
  in a new component file.
- A screen that writes `<div className="rounded-xl border bg-white p-4">` should be using
  `@/components/ui/card`. Screens compose; they do not restyle.
- **Tokens only**, never a raw hex. Available: `canvas`, `surface`/`surface-raised`/
  `surface-sunken`, `foreground`, `muted-foreground`, `border`/`border-strong`, `primary`,
  `success`, `warning`, `danger`, `info`, `unmeasured` — each with a `-subtle` fill and a
  `-foreground` text tone. Type scale: `text-meta|table|body|subsection|title|kpi`.
- All HTTP goes through `@/lib/api` (`api.get/post/put/patch/delete`, `unwrap`, `ApiError`).
  `ApiError.kind` is the thing to switch on: `invalid | unauthenticated | forbidden |
  not-found | conflict | rate-limited | unavailable | network | unknown`.
- Filters and the selected run/tab live in the URL, so a copied link reproduces the view.
- Accessibility is not optional (§3.4): keyboard reachable, visible focus, semantic headings
  and tables, dialogs trap focus and restore it, error summaries link to the bad field,
  required fields stated in text and not by color alone, timezone shown with every timestamp.

## When you finish

1. Run the typecheck for the app you touched and make it pass.
2. Write `README.md` in your module directory: purpose, file tree, endpoints/props,
   dependencies, env vars, PRD-alignment table, and what you actually verified.
3. In your final report, state plainly: what you built, what you could not build and why,
   anything you need from another package, and anything you left as an explicit
   unavailable state. Do not claim a test passed that you did not run.

# Publishing module (G11 — CMS/channel destinations, publications, remote verification)

Purpose: make "we published the approved revision, and it is live" two checkable
facts instead of one hopeful one.

Four rules from the contract shape everything here:

1. **No remote write without an explicit, approved action.** Creating a
   `Publication` requires an `ApprovalRequest` that is `approved` for *that exact
   revision*, passes `ApprovalsService.assertReadyToPublish` (G10's one served
   release gate — this module is currently its only caller; see "Reported
   upstream"), and names the scopes the destination was authorized for. The
   authorizing `approvalId` is stored on the row, and it is re-checked
   immediately before the write — an approval invalidated between scheduling and
   dispatch stops the push.
2. **Publishing and verifying are different outcomes.** `status` is the push;
   `verifiedAt`/`verifyError`/`verifyState` are the follow-up read. Verification
   never changes `status`: a failed fetch does not un-publish anything, and a
   successful one does not prove the push just happened.
3. **Retries never create a second remote post.** Once a row has a `remoteId`,
   retry re-runs verification. A retry that *would* re-post (an interrupted
   dispatch) refuses until an operator confirms there is no remote copy.
4. **Credentials are never persisted on the destination row.** `credentialRef` is
   a short slug naming a secret-store entry; `config` is validated to hold no
   secret-shaped key at any depth; no view ever returns a resolved value.

## File tree

```
publishing/
  publishing.controller.ts            operator surface — providers, destinations, publications
  publishing.service.ts               destinations, the publication state machine, dispatch, verification
  publication-scheduler.service.ts    @Cron dispatcher for due scheduled publications
  publishing.types.ts                 provider catalogue + status vocabularies + views
  lib/provider.types.ts               the adapter contract every provider implements
  lib/custom-webhook.adapter.ts       the one provider that genuinely works end to end
  lib/credentials.util.ts             credentialRef -> secret-store resolution (+ the shape guard)
  lib/timezone.util.ts                scheduledFor resolution in the project/engagement timezone
  dto/destination.dto.ts              destination DTOs (no credential field exists)
  dto/publication.dto.ts              publication DTOs
```

## Endpoints

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/api/publishing/providers` | any operator | the catalogue: kind, scopes, `implemented`, and the reason when not |
| GET | `/api/projects/:projectId/publish-destinations` | any operator | `?provider=&status=`; never a credential value |
| GET | `/api/projects/:projectId/publish-destinations/:id` | any operator | one destination |
| POST | `/api/projects/:projectId/publish-destinations` | admin, delivery-lead | declare it (`unconfigured`) — creating is not connecting |
| PATCH | `/api/projects/:projectId/publish-destinations/:id` | admin, delivery-lead | edit; changing config/credential returns it to `unconfigured` |
| POST | `/api/projects/:projectId/publish-destinations/:id/authorize` | admin, delivery-lead | test the provider, then mark connected. **501** for a provider with no adapter |
| POST | `/api/projects/:projectId/publish-destinations/:id/test` | admin, delivery-lead | reach the provider without changing scopes |
| GET | `/api/projects/:projectId/publish-destinations/:id/resources` | any operator | the selectable remote targets |
| POST | `/api/projects/:projectId/publish-destinations/:id/resource` | admin, delivery-lead | pick one, validated against the adapter's own list |
| POST | `/api/projects/:projectId/publish-destinations/:id/revoke` | admin, delivery-lead | stop future pushes; reports how many were waiting |
| GET | `/api/projects/:projectId/publications` | any operator | `?status=&destinationId=&assetId=&limit=` |
| GET | `/api/projects/:projectId/publications/:id` | any operator | one row with derived state |
| POST | `/api/projects/:projectId/publications` | admin, delivery-lead | create (and dispatch, or schedule) |
| POST | `/api/projects/:projectId/publications/:id/verify` | admin, delivery-lead | confirm the content is live |
| POST | `/api/projects/:projectId/publications/:id/cancel` | admin, delivery-lead | only before anything reached the remote |
| POST | `/api/projects/:projectId/publications/:id/retry` | admin, delivery-lead | safe by construction (see rule 3) |

**Endpoint count: 16.**

Destinations live at `/publish-destinations` rather than under
`/publications/destinations` (where the design plan's wording would put them)
because `publications/:publicationId` already exists: a nested `destinations`
segment would be matched by the id parameter first and would depend on
declaration order to behave. An explicit path is unambitious and correct.

Every handler calls `ScopeValidationService.assertProjectAccess` before it
touches a row, and every destination/publication lookup is scoped by the
`projectId` in the URL — a foreign id 404s (design_plan §11.2 case 15).

## The state machine

```
                    create (approvalId recorded, all gates pass)
                                     │
        scheduledFor ────────────────┴──────────── no scheduledFor
             │                                          │
        pending ──(scheduler, gates re-checked)──► publishing ──► published
             │                                          │            │
          cancel                                    failed      verify ──► verifiedAt
             │                                          │            └──► verifyError
          cancelled                                 retry (no remoteId: re-push)
                                                    retry (remoteId: re-verify only)
```

- A **held** publication stays `pending` with a derived `blockedReason` (the
  destination is not connected, the approval is no longer approved, the client is
  paused, the schedule has not arrived). A hold is not a failure and is not
  stored as one.
- `publishing` for longer than 15 minutes is reported as `stale: true` and is
  **never auto-reset** — a re-push could duplicate a post that actually landed.
  `retry` on a stale row requires `confirmNoRemoteCopy: true`.
- `published` + `verifyState: "unverified"` is the honest state for "the
  provider accepted it and nothing has confirmed it is live".

## Providers: one connection, one provider, named scopes

`PROVIDER_DECLARATIONS` declares seven providers across four disjoint kinds —
`cms` (wordpress, webflow, ghost, contentful), `social` (linkedin, x) and
`webhook` (custom-webhook). A destination is created for exactly one of them, and
its `permissions` must be a subset of that provider's own declared scopes: a
request that names another provider's scope is a `400` with the allowed list, so
a single connect button can never accumulate permissions across providers.

| Provider | Kind | Implemented | Why not |
|---|---|---|---|
| `custom-webhook` | webhook | ✅ | — |
| `wordpress` | cms | ❌ | needs per-site application passwords + REST/editorial-status handling, never exercised against a real site |
| `webflow` | cms | ❌ | needs a site token + a per-collection field mapping that cannot be guessed |
| `ghost` | cms | ❌ | Admin API key + signed JWT per request, unexercised |
| `contentful` | cms | ❌ | CMA token + content-type field mapping, unexercised |
| `linkedin` | social | ❌ | needs an approved developer app and an organisation-scoped grant |
| `x` | social | ❌ | the vendor API tier needed to post on a client's behalf is a commercial decision |

Email and ads providers are **not** declared: no vendor has been chosen through
an approved analysis, and inventing one would be inventing a capability. Every
unavailable action returns **501** with the reason and stop — no OAuth URL is
fabricated for a flow that cannot complete.

## The `custom-webhook` provider

The one integration that works end to end, and the reference implementation of
`lib/provider.types.ts`.

**Push** — `POST <config.endpoint>`:

```json
{
  "cailyx": { "version": 1, "event": "publication", "publicationId": "…", "projectId": "…",
              "mode": "draft", "contentHash": "…", "resourceId": "…" },
  "content": { "assetId": "…", "assetType": "article", "revisionId": "…", "revision": 3,
               "title": "…", "body": "…", "fields": {} }
}
```

signed with `X-Cailyx-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over
`<t>.<raw body>` — the same scheme this platform verifies on its own inbound
webhook, so a receiver's check is a copy, not a puzzle. The receiver must answer
`2xx` with `{"id": "…", "url": "https://…"}`; `id` becomes the retry key and
`url` is what verification fetches. A response without an `id` is recorded as a
failure that says a copy may exist — a retry could not be de-duplicated.

**Verify** — `GET <url>`, requiring `2xx` **and** a marker: the revision's
`contentHash` (conclusive; have the receiver echo it into the page) or, failing
that, its title (recorded as the weaker `markerMatched: "title"`). A `2xx` alone
is not verification — an error page served with a 200 would otherwise pass.
The URL to fetch comes from the receiver's response, so it is refused unless it
is `https` (or `http` on localhost) — otherwise a receiver could point this
server at an internal address.

**Test** — the same POST with `"event": "test"` and no content.

**Resources** — `config.channels` if the receiver declares them, else a single
implicit target (a webhook has one endpoint; a longer list would be fiction).

`config.endpoint` must be `https`, except on localhost for a local receiver:
plain `http` to a public host would put a client's draft on the wire in clear
text, and a "just for now" flag for that is how it stays forever.

## Credentials

```
credentialRef: "acme-webhook"   ->   PUBLISH_CREDENTIAL_ACME_WEBHOOK
```

The reference is a **name**, and its shape is enforced
(`^[a-z0-9][a-z0-9._-]{0,63}$`): a provider key, a JWT or a base64 blob cannot
match a short lowercase slug, so the one place a credential could be persisted on
the row is closed by shape rather than by review. `config` is additionally
rejected at any depth if a key looks like a secret (`secret`, `token`,
`password`, `apiKey`, `privateKey`, `signingKey`, `clientSecret`, `accessKey`,
`bearer`, `authorization`, `credential`). Reads expose `credentialRef` (the name)
and `credentialConfigured` (a boolean) — never a value.

Today the secret store is the process environment. When a dedicated encrypted
store lands, only `lib/credentials.util.ts` changes.

## Scheduling

`scheduledFor` resolves against the project's IANA timezone (inherited from the
engagement), never the server's clock and never the browser's: a bare date means
09:00 local, a local date-time means that wall clock, and a full ISO timestamp is
taken as given. `PublicationSchedulerService` runs every minute, picks up due
`pending` rows and calls the same `dispatch` the API uses — which re-checks every
gate before the write, so a publication whose approval was invalidated while it
waited stays pending and says why. Set `PUBLISHING_SCHEDULER_ENABLED=false` to
stand it down.

## Dependencies

- `PrismaService` — global (`DatabaseModule`).
- `ScopeValidationService` — global (`ScopeValidationModule`).
- `ApprovalsService` (`ApprovalsModule`) — `assertReadyToPublish` for the gate,
  `recordCheckResult` for verification evidence (read back at
  `GET /api/approvals/check-results?subjectType=publication&subjectId=…`).
- `ActivityService` (`ActivityModule`) — destination and publication lifecycle.
- `FetcherService` (`FetcherModule`) — the only outbound HTTP in this module.
- `ScheduleModule.forRoot()` — already registered in `app.module.ts`.

## Env vars

| Name | Required | Purpose |
|---|---|---|
| `PUBLISH_CREDENTIAL_<REF>` | per destination | the credential a `credentialRef` resolves to (e.g. `acme-webhook` → `PUBLISH_CREDENTIAL_ACME_WEBHOOK`). Unset ⇒ the destination reports `credentialConfigured: false` and any push is refused with 503 |
| `PUBLISHING_SCHEDULER_ENABLED` | no (`true`) | `false` stands the dispatch cron down |

Names only — no credential is invented or committed. `.env.example` needs
`PUBLISHING_SCHEDULER_ENABLED` documented (the `PUBLISH_CREDENTIAL_*` family is a
convention whose instances are deployment-specific).

## PRD alignment (design_plan.md Appendix A, G11)

| Requirement | Status |
|---|---|
| Destination authorize / test / revoke / resource selection | ✅ authorize and test run the provider's real reachability check; revoke stops future pushes and reports what was waiting; selection is validated against the adapter's own list |
| Publication create / status / cancel / retry | ✅ |
| Remote verification | ✅ recorded as `verifiedAt`/`verifiedUrl`/`verifyError` **and** as a `CheckResult` evidence row |
| No remote write before an explicit approved action | ✅ approval for the exact revision, `assertReadyToPublish`, recorded `approvalId`, re-checked before dispatch |
| Safe retries | ✅ keyed on `remoteId`; a re-post requires explicit operator confirmation |
| Schedule timezone | ✅ resolved in the project/engagement IANA zone |
| Failed remote publish distinct from failed verification | ✅ separate columns, separate states, `verifyState` derived |
| Persist remote ID, attempt/result, verified live version | ✅ |
| Rollback capability | ⚠ **not implemented** — cancel refuses once a remote write has happened and says rollback is not implemented; a human removes the remote copy and records that separately |
| Social, email, ads and CMS are distinct integrations | ✅ disjoint kinds; scopes validated against one provider |
| Do not choose vendors/CMSs except through approved analysis | ✅ only `custom-webhook` is implemented; the rest are declared and refused with reasons |
| Screens PJ03/CT06/AT03/CP05 | ⚠ API only. CP05 (client connections) is G02's surface; no client-facing publication view is specified in G11's contract, so none is invented |
| Protected log-ingest credentials/webhook management | ➖ out of this contract half — `crawler-monitor` owns log ingest |

## What is deliberately not built

- **No provider adapters beyond `custom-webhook`.** Writing one means having run
  it against the real provider; not doing that is the point of the
  `implemented: false` flag.
- **No rollback/unpublish.** Removing a live post at a provider is a distinct
  operation with its own consent story.
- **No client-portal publishing surface.** G11's contract names no client route;
  CP05 is G02's.
- **`asset.status` is set to `published` only on a *verified* live publication**
  (`mode: 'publish'`), never on a push alone and never for a draft.

## Reported upstream (not editable from this package)

- ~~**`backend/src/modules/reporting/` does not call
  `ApprovalsService.assertReadyToPublish`.**~~ **Resolved 2026-09-16 by G05.**
  `ReportLifecycleService.publish()` now calls the gate before it writes anything
  (`artifactType "report"`, `revisionType "report-revision"`), and
  `reporting.review()` calls `invalidateStaleRequests` — so report release is
  gated exactly as this publishing path is, and this service is no longer the
  gate's only caller. (The original note was correct when written: the reporting
  module had no publish route at all.)
- **`TASK_KINDS` (`jobs/jobs.types.ts`) has no `diagnostic-request` entry**, so
  the jobs API's `?taskKind=` filter rejects that kind even though an unfiltered
  run list shows it. G16's public intake queues exactly that kind.
- **`main.ts` does not set `rawBody: true`**, so inbound webhook signatures are
  verified over a canonical re-serialization when the raw bytes are unavailable
  (G16's module README explains why that is fail-closed, and the response reports
  which mode was used per delivery).

## Verified (2026-09-16, live on :3097 with a local HTTPS receiver)

A throwaway receiver (self-signed TLS, every push and verification counted) ran
against a real server process and the dev database, with the publish path driven
through the real G10 approvals API. `43/43` checks passed in the main run; a
second run covering the dispatcher, revocation, the paused-client hold and the
blocked-reason ordering passed `14/15` — the one failure was a stale expectation
in the test itself (it wanted a `scheduled for …` reason on a publication that
was *also* held by its paused client; the row reported the pause, which is the
correct precedence, and the main run asserts the schedule reason for an active
client). The ordering rule is deliberate: **a permanent block outranks a
temporary one**, so a publication scheduled for tomorrow onto a revoked
destination reads `the destination was revoked`, not "waiting for its slot".

- **Destinations**: created `unconfigured`; a secret-shaped config key refused
  (`secret-shaped-config-key`); another provider's scope refused
  (`unknown-permission`); a literal credential in `credentialRef` refused by
  shape; the response carries `credentialRef` + `credentialConfigured` and no
  value; `authorize` ran a real signed test the receiver validated
  (`lastSignatureOk: true`) and only then marked `connected`; resources listed
  and an unoffered resource id refused; `revoke` reported 1 waiting publication,
  refused a second revoke, and a push to it afterwards returned
  `409 destination-revoked` while the queued publication stayed `pending` with a
  reason rather than being silently cancelled.
- **Unimplemented providers**: `authorize` on WordPress → `501
  provider-not-implemented` with the declaration's reason and no URL in the body.
- **The gate**: publishing with no approval → `409 no-approved-revision`;
  quoting a stale `contentHash` → `409 revision-changed`; a scope the provider
  does not declare → `400 unknown-permission`; a scope the destination was not
  granted → `403 permission-not-granted`; after approval through the API, one
  publication → exactly one remote write, `remoteId`/`remoteUrl` recorded, and
  `approvalId` equal to the approval that authorized it.
- **The publish/verify split**: the first verification matched the content hash
  and the asset became `published`; with the hash hidden the title matched and
  the evidence recorded `markerMatched: "title"` (the weaker signal); with a
  `200` page containing neither marker the verification **failed** — `status`
  stayed `published`, `verifiedAt` was cleared, `verifyError` explained why, and
  a `CheckResult` evidence row was written for each attempt.
- **Retry safety**: retrying a publication that already had a `remoteId`
  re-verified and the receiver's push counter did not move
  (`retried: "verification"`); cancelling it returned `409
  cannot-cancel-after-remote-write`.
- **Scheduling and holds**: a publication scheduled for the future stayed
  `pending` with `scheduled for <iso>`; a publication created while its client
  was paused stayed `pending` with a `blockedReason` naming the pause and wrote
  nothing to the receiver; after the client was resumed, the every-minute
  dispatcher published **both** on its own (two further remote writes, each
  verified, with no API call in between).
- **Scope (§11.2 case 15)**: a destination id and a publication id from another
  project both `404` under the first project; creating a publication inside a
  foreign project URL is refused; reads need a token (`401`); no response
  contained the credential value.

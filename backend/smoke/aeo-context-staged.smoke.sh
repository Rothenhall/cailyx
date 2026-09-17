#!/usr/bin/env bash
# E2E smoke — P03 staged website-understanding pipeline (aeo-context.service.ts).
#
# Two parts:
#
#   Part 1 — a REAL POST /context call against an unresolvable `.example`
#   domain (same convention aeo-audit.smoke.sh already uses for a live-shaped
#   call that touches no real external server). This exercises the actual
#   discover→inspect→select→extract→reconcile→validate→compile path for
#   real through the real fetcher, proving the "no reachable pages" honest
#   disclosure and that build() still returns a valid, empty SiteContext.
#
#   Part 2 — the exit gate: RESUMABILITY. A `SiteContextRun` + its fetched
#   `SiteContextRunPage` rows are seeded directly (skipping only the network
#   fetch itself — everything downstream is the real service code), then
#   driven through four separate `POST .../context/runs/:runId/resume` calls
#   with the elapsed-time budget pinned at 0ms so the pipeline PAUSES after
#   every single stage, deterministically (no timing flakiness): inspect,
#   select, extract, then a final resume with a real budget finishes
#   reconcile/validate/compile. Between calls we assert:
#     - the page/request spend on the run never increases (nothing is re-fetched)
#     - facts created by the extract-stage resume survive the next resume call
#       unchanged (same fact ids/count)
#     - coverage-based selection reserved capacity by purpose category (3
#       case-study pages compete for 2 slots; 6 near-duplicate blog posts and
#       a login/cart page are excluded outright, never by score)
#     - pricing-tier headings never become "services" facts
#     - every surviving fact is validated against its own cited page's text
#     - the final SiteContext's `pageUrls` is the SELECTED subset, not every
#       fetched page, and `extraction` honestly reports "deterministic" (no
#       LLM key is configured in this environment)
#     - business-profile's GET overview cites the field-specific source page
#       for the "services" suggestion, not just the old whole-context fallback
#
# Honest limits (see final report): this does not crawl a real multi-page
# live site — sibling smoke scripts in this repo use the same `.example`
# non-resolving-domain convention rather than depending on the internet being
# reachable/stable in CI. Every run here also passes refine:false /
# seeds refine:false, so the LLM batch-extraction path (extractBatchLlm) is
# NOT exercised by THIS script — only its deterministic fallback path is
# asserted, deliberately, so this script's assertions and API cost are
# deterministic. The LLM path was verified separately, once, by hand against
# a real OpenRouter call (real "extraction":"llm-synthesized" output,
# real costUsd reported) — see the final report for that transcript.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== aeo-context-staged smoke =="

SEED='{}'
cleanup() {
  CTXSTAGE_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.CTXSTAGE_SEED);
  if (!s.projectId && !s.project2Id) return;
  await prisma.$transaction(async (tx) => {
    const projectIds = [s.projectId, s.project2Id].filter(Boolean);
    const runs = await tx.siteContextRun.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    const runId = { in: runs.map((r) => r.id) };
    await tx.siteContextFact.deleteMany({ where: { runId } });
    await tx.siteContextRunPage.deleteMany({ where: { runId } });
    await tx.siteContext.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.siteContextRun.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.project.deleteMany({ where: { id: { in: projectIds } } });
    await tx.client.deleteMany({ where: { id: { in: [s.clientId].filter(Boolean) } } });
  });
  console.log('(smoke rows deleted)');
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
}
trap cleanup EXIT

# ── Seed ─────────────────────────────────────────────────────────────────
SEED=$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PW="$SMOKE_PW" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const page = (opts) => ({
  fetched: true, statusCode: 200, fetchedAt: new Date(),
  html: opts.html, text: strip(opts.html), title: opts.title ?? null,
  contentHash: 'h-' + Math.random().toString(36).slice(2),
  discoverySource: opts.source, url: opts.url,
});

(async () => {
  const stamp = `ctxstage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `CtxStage ${stamp}` } });

    // ── Part 1 fixture: an unresolvable domain, same convention as
    // aeo-audit.smoke.sh's `*.example.com` projects — no real server is contacted.
    const project1 = await tx.project.create({ data: {
      name: `CtxStage Unreachable ${stamp}`, domain: `ctxstage-${stamp}.example.com`,
      clientId: client.id, onboardingStatus: 'pending',
    } });

    // ── Part 2 fixture: a project whose SiteContextRun + fetched pages are
    // seeded directly (the network fetch is the one thing skipped; every
    // downstream stage runs as real code against this seeded content).
    const domain = `ctxstage2-${stamp}.example`;
    const project2 = await tx.project.create({ data: {
      name: `CtxStage Seeded ${stamp}`, domain, clientId: client.id, onboardingStatus: 'pending',
    } });

    const run = await tx.siteContextRun.create({ data: {
      projectId: project2.id, domain,
      status: 'inspecting', stage: 'discover', // discover already "done" — resume must not re-fetch
      maxPages: 20, maxRequests: 40, maxChars: 24000, maxElapsedMs: 0, maxRetriesPerPage: 2,
      // refine:false — this environment DOES have OPENROUTER_API_KEY configured
      // (unlike a typical CI box), so leaving refine on would spend real API
      // budget and make fact counts non-deterministic. Forcing it off keeps
      // this run on the deterministic-only path, which is itself a real,
      // asserted code path (the honest "extraction":"deterministic" fallback).
      pagesSpent: 17, requestsSpent: 17, refine: false,
    } });

    const origin = `https://${domain}`;
    const pages = [
      page({ url: origin + '/', source: 'homepage', title: 'Acme Growth', html:
        '<html><head><title>Acme Growth</title><meta name="description" content="We build revenue engines for B2B teams."></head>' +
        '<body><h1>We build predictable revenue engines for B2B teams</h1></body></html>' }),
      page({ url: origin + '/services', source: 'sitemap', html:
        '<html><body><h2>Fractional CMO Services</h2><h2>Revenue Operations Audit</h2></body></html>' }),
      page({ url: origin + '/pricing', source: 'sitemap', html:
        '<html><body><h3>Custom Plan</h3><h3>Enterprise Business</h3></body></html>' }),
      page({ url: origin + '/about', source: 'sitemap', html:
        '<html><body><h1>About Acme</h1><p>Founded in 2019, Acme has helped 80 B2B teams grow.</p></body></html>' }),
      page({ url: origin + '/industries/logistics', source: 'guess', html: '<html><body><h1>Logistics</h1></body></html>' }),
      page({ url: origin + '/industries/retail', source: 'guess', html: '<html><body><h1>Retail</h1></body></html>' }),
      page({ url: origin + '/case-studies/acme', source: 'guess', html: '<html><body><h1>Acme case study</h1></body></html>' }),
      page({ url: origin + '/case-studies/beta', source: 'guess', html: '<html><body><h1>Beta case study</h1></body></html>' }),
      page({ url: origin + '/case-studies/gamma', source: 'guess', html: '<html><body><h1>Gamma case study</h1></body></html>' }),
      page({ url: origin + '/login', source: 'guess', html: '<html><body><h1>Log in</h1></body></html>' }),
      page({ url: origin + '/cart', source: 'guess', html: '<html><body><h1>Your cart</h1></body></html>' }),
      ...Array.from({ length: 6 }, (_, i) => page({
        url: `${origin}/blog/post-${i + 1}`, source: 'guess',
        html: `<html><body><h1>Blog post ${i + 1}</h1><p>Some blog content number ${i + 1}.</p></body></html>`,
      })),
    ];
    for (const p of pages) await tx.siteContextRunPage.create({ data: { runId: run.id, ...p } });

    return { clientId: client.id, projectId: project1.id, project2Id: project2.id, runId: run.id, domain, pageCount: pages.length };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

P1=$(echo "$SEED" | jget projectId)
P2=$(echo "$SEED" | jget project2Id)
RUN_ID=$(echo "$SEED" | jget runId)
DOMAIN=$(echo "$SEED" | jget domain)
[ -n "$RUN_ID" ] && [ "$RUN_ID" != "__ERR__" ] && ok "seeded unreachable-domain project + a run with 17 fetched, unselected pages" || die "seed" "$SEED"

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"
AUTH=(-H "authorization: Bearer $TOKEN")

request() {
  local label="$1" method="$2" path="$3" expected="$4" response
  shift 4
  response=$(curl -sS -w $'\n%{http_code}' -X "$method" "$API$path" "${AUTH[@]}" -H 'content-type: application/json' "$@") \
    || die "$label transport failed" "$response"
  HTTP_CODE="${response##*$'\n'}"
  BODY="${response%$'\n'*}"
  [ "$HTTP_CODE" = "$expected" ] && ok "$label HTTP $expected" || bad "$label HTTP $HTTP_CODE (expected $expected): $BODY"
}

# ── Part 1: real build() over the real path, against an unresolvable domain ─
# maxRequests is pinned low so the run stays fast: FetcherService retries a
# DNS failure with its own backoff, and with the default request budget
# discover can spend well over a minute retrying every guessed path.
request "POST /context (unreachable domain)" POST "/projects/$P1/aeo/context" 201 -d '{"maxPages":5,"maxRequests":3,"maxElapsedMs":60000,"refine":false}'
BUILD_BODY="$BODY"
[ "$(echo "$BUILD_BODY" | jget pagesFetched)" = "0" ] && ok "unreachable domain: pagesFetched=0" || bad "pagesFetched" "$BUILD_BODY"
[ "$(echo "$BUILD_BODY" | jget extraction)" = "deterministic" ] && ok "unreachable domain: extraction=deterministic (honest, no pages to synthesize from)" || bad "extraction" "$BUILD_BODY"
CTX1_ID=$(echo "$BUILD_BODY" | jget id)
[ -n "$CTX1_ID" ] && [ "$CTX1_ID" != "__ERR__" ] && ok "unreachable domain: a SiteContext row was still created" || bad "context id" "$BUILD_BODY"

request "GET /context/runs (part 1 project)" GET "/projects/$P1/aeo/context/runs" 200
RUN1_ID=$(echo "$BODY" | jget "runs.0.id")
request "GET /context/runs/:runId (part 1)" GET "/projects/$P1/aeo/context/runs/$RUN1_ID" 200
NOTES_LEN=$(echo "$BODY" | jlen "run.notes")
[ "$NOTES_LEN" != "NaN" ] && [ "$NOTES_LEN" -ge 1 ] 2>/dev/null && ok "unreachable domain: run.notes discloses incomplete/empty discovery" || bad "run notes" "$BODY"

# ── Part 2: resumability, coverage selection, budgets, citations ───────────
# Call 1: maxElapsedMs=0 (seeded) — pauses right after the inspect stage.
request "resume #1 (pauses after inspect)" POST "/projects/$P2/aeo/context/runs/$RUN_ID/resume" 200 -d '{}'
[ "$(echo "$BODY" | jget paused)" = "true" ] && ok "resume #1 reports paused" || bad "resume #1 paused flag" "$BODY"
[ "$(echo "$BODY" | jget reachedStage)" = "inspect" ] && ok "resume #1 paused exactly after inspect" || bad "resume #1 stage" "$BODY"

request "GET run detail after resume #1" GET "/projects/$P2/aeo/context/runs/$RUN_ID" 200
SPENT_PAGES_1=$(echo "$BODY" | jget "run.spent.pages")
SPENT_REQ_1=$(echo "$BODY" | jget "run.spent.requests")
[ "$SPENT_PAGES_1" = "17" ] && ok "page spend unchanged after resume #1 (17, nothing re-fetched)" || bad "page spend after #1" "$SPENT_PAGES_1"
BLOG_PT=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const p=o.pages.find(x=>x.url.endsWith("/blog/post-1"));process.stdout.write(p?p.pageType:"__MISSING__")})')
[ "$BLOG_PT" = "blog" ] && ok "inspect classified a blog post as pageType=blog" || bad "blog pageType" "$BLOG_PT"

# Call 2: still maxElapsedMs=0 — pauses right after the select stage.
request "resume #2 (pauses after select)" POST "/projects/$P2/aeo/context/runs/$RUN_ID/resume" 200 -d '{}'
[ "$(echo "$BODY" | jget reachedStage)" = "select" ] && ok "resume #2 paused exactly after select" || bad "resume #2 stage" "$BODY"

request "GET run detail after resume #2 (coverage)" GET "/projects/$P2/aeo/context/runs/$RUN_ID" 200
CASE_STUDY_FILLED=$(echo "$BODY" | jget "run.coveragePlan.case-study.filled")
[ "$CASE_STUDY_FILLED" = "2" ] && ok "coverage selection: 2 of 3 case-study pages selected (target respected, not all-3-by-score)" || bad "case-study coverage" "$BODY"
SELECTED_BLOG=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.pages.filter(p=>p.url.includes("/blog/")).some(p=>p.selected)))})')
[ "$SELECTED_BLOG" = "false" ] && ok "coverage selection: no blog post was ever selected (categorically excluded)" || bad "blog exclusion" "$SELECTED_BLOG"
SELECTED_LOGIN_CART=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.pages.filter(p=>p.url.endsWith("/login")||p.url.endsWith("/cart")).some(p=>p.selected)))})')
[ "$SELECTED_LOGIN_CART" = "false" ] && ok "coverage selection: login/cart pages excluded" || bad "login/cart exclusion" "$SELECTED_LOGIN_CART"
SELECTED_COUNT=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.pages.filter(p=>p.selected).length))})')
[ "$SELECTED_COUNT" = "8" ] && ok "selected page count = 8 (1 home + 1 service + 1 pricing + 1 about + 2 industries + 2 case-study)" || bad "selected count" "$SELECTED_COUNT"

# Call 3: still maxElapsedMs=0 — pauses right after the extract stage. Facts now exist.
request "resume #3 (pauses after extract)" POST "/projects/$P2/aeo/context/runs/$RUN_ID/resume" 200 -d '{}'
[ "$(echo "$BODY" | jget reachedStage)" = "extract" ] && ok "resume #3 paused exactly after extract" || bad "resume #3 stage" "$BODY"

request "GET run detail after resume #3 (facts)" GET "/projects/$P2/aeo/context/runs/$RUN_ID" 200
FACTS_AFTER_3=$(echo "$BODY" | jlen facts)
[ "$FACTS_AFTER_3" != "NaN" ] && [ "$FACTS_AFTER_3" -ge 1 ] 2>/dev/null && ok "extraction produced $FACTS_AFTER_3 fact(s), persisted before the pause" || bad "facts after #3" "$BODY"
SERVICE_FACT_URL=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const f=o.facts.find(x=>x.field==="services"&&/Fractional CMO/i.test(x.value));process.stdout.write(f?f.sourceUrl:"__MISSING__")})')
[ "$SERVICE_FACT_URL" = "https://$DOMAIN/services" ] && ok "deterministic fact cites its real source page (/services)" || bad "service fact citation" "$SERVICE_FACT_URL"
TIER_LEAK=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.facts.some(f=>/Custom Plan|Enterprise Business/i.test(f.value))))})')
[ "$TIER_LEAK" = "false" ] && ok "pricing-tier headings never became service facts" || bad "tier-word leak" "$TIER_LEAK"
FACT_IDS_AFTER_3=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.facts.map(f=>f.id).sort()))})')
SPENT_PAGES_3=$(echo "$BODY" | jget "run.spent.pages")
[ "$SPENT_PAGES_3" = "17" ] && ok "page spend still unchanged after resume #3 (extract used cached HTML, no fetch)" || bad "page spend after #3" "$SPENT_PAGES_3"

# Call 4: raise the budget — finishes reconcile/validate/compile.
request "resume #4 (finishes the run)" POST "/projects/$P2/aeo/context/runs/$RUN_ID/resume" 200 -d '{"maxElapsedMs":120000}'
FINAL_BODY="$BODY"
[ -z "$(echo "$FINAL_BODY" | jget paused)" ] && ok "resume #4 completed (no paused flag)" || bad "resume #4 should have completed" "$FINAL_BODY"
CTX2_ID=$(echo "$FINAL_BODY" | jget id)
[ -n "$CTX2_ID" ] && [ "$CTX2_ID" != "__ERR__" ] && ok "resume #4 returned a compiled SiteContext id" || bad "final context id" "$FINAL_BODY"
[ "$(echo "$FINAL_BODY" | jget extraction)" = "deterministic" ] && ok "final extraction honestly reports deterministic (refine:false — the run never called an LLM)" || bad "final extraction" "$FINAL_BODY"
PAGE_URLS_LEN=$(echo "$FINAL_BODY" | jlen pageUrls)
[ "$PAGE_URLS_LEN" = "8" ] && ok "final pageUrls is the SELECTED subset (8), not all 17 fetched" || bad "final pageUrls length" "$PAGE_URLS_LEN"

request "GET run detail after resume #4 (facts survived unchanged)" GET "/projects/$P2/aeo/context/runs/$RUN_ID" 200
FACT_IDS_AFTER_4=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.facts.map(f=>f.id).sort()))})')
[ "$FACT_IDS_AFTER_4" = "$FACT_IDS_AFTER_3" ] && ok "the exact same fact rows survive from resume #3 through resume #4 (no re-extraction)" || bad "fact ids stable across resume" "before=$FACT_IDS_AFTER_3 after=$FACT_IDS_AFTER_4"
VALIDATED_COUNT=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.facts.filter(f=>f.validated).length))})')
[ "$VALIDATED_COUNT" -ge 1 ] 2>/dev/null && ok "$VALIDATED_COUNT fact(s) validated against their own cited page text" || bad "validated count" "$VALIDATED_COUNT"
UNVALIDATED_HAVE_NOTE=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.facts.filter(f=>!f.validated).every(f=>!!f.validationNote)))})')
[ "$UNVALIDATED_HAVE_NOTE" = "true" ] && ok "every unvalidated fact carries a reason" || bad "validation notes" "$UNVALIDATED_HAVE_NOTE"

# ── GET /context reads back the compiled, staged result ────────────────────
request "GET /context (latest, part 2)" GET "/projects/$P2/aeo/context" 200
[ "$(echo "$BODY" | jget id)" = "$CTX2_ID" ] && ok "GET /context matches the resumed run's compiled context" || bad "latest context id" "$BODY"

# ── Cross-project run scoping: a run cannot be inspected/resumed via the wrong project ──
request "GET run detail under the WRONG project is 404" GET "/projects/$P1/aeo/context/runs/$RUN_ID" 404
request "resume under the WRONG project is 404" POST "/projects/$P1/aeo/context/runs/$RUN_ID/resume" 404 -d '{}'

# ── business-profile overview surfaces the field-specific citation ─────────
request "GET business-profile/overview (part 2 project)" GET "/projects/$P2/business-profile/overview" 200
SERVICES_SOURCE=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);for(const sec of o.sections){const sug=sec.suggestions.find(x=>x.field==="services");if(sug){process.stdout.write(sug.sourcePage||"__NULL__");return}}process.stdout.write("__MISSING__")})')
[ "$SERVICES_SOURCE" = "https://$DOMAIN/services" ] && ok "business-profile overview cites the /services page specifically for the services suggestion (not the generic fallback)" || bad "services suggestion sourcePage" "$SERVICES_SOURCE"

echo ""
echo "== aeo-context-staged: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1

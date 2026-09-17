#!/usr/bin/env bash
# E2E smoke — aeo-audit module (ChatGPT-first answer-engine visibility).
#
# Runs the whole pipeline with ZERO API keys and ZERO spend:
#   context (deterministic) -> matrix (template phrasing) -> measurement (mock
#   surface, n=5) -> verdict. The LLM passes are requested with refine:false and
#   skipStance, so no provider is ever called; the real chatgpt-browser surface
#   is asserted to fail closed. Assertions that depend on whether an LLM provider
#   is configured on the SERVER branch on that, because this script cannot change
#   the server's environment — and the keyed branch is skipped, not exercised,
#   since judging observations costs real money.
#
# Requires: MEASUREMENT_ALLOW_MOCK=1 on the running backend.
# Writes to dev.db and deletes the smoke project at the end.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

echo "== aeo-audit smoke =="

# --- auth (shared smoke operator) ------------------------------------------
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# --- project ----------------------------------------------------------------
# A deliberately unresolvable domain: this smoke asserts the pipeline's plumbing
# and its honest-failure behaviour, not crawl quality, and depending on a real
# third-party site staying still would make the suite flaky.
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"AEO Smoke Co\",\"domain\":\"aeo-smoke-$RANDOM.example.com\",\"category\":\"answer engine optimization\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# Seed competitors so the competitor-alternatives + head-to-head categories
# have something to build from (normally intake supplies these).
curl -s -X PUT "$API/projects/$PID/competitors" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"competitors":[{"name":"Profound","domain":"tryprofound.com"},{"name":"Peec AI","domain":"peec.ai"}]}' >/dev/null

# P04 (plan §10.2) removed the silent ccTLD/HQ-default market fallback:
# resolveDefaultMarket() now requires an explicit geo, a confirmed
# business-profile target country, or usable SiteContext.markets/geo evidence,
# and throws ConflictException otherwise. This fixture's domain is
# deliberately unresolvable (0 pages, no SiteContext evidence), so a confirmed
# target is the only rung left — seed and confirm one so the rest of this
# script's default-market (no markets[]) assertions still resolve.
curl -s -X PUT "$API/projects/$PID/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"targets":[{"country":"US","priority":1,"active":true}]}' >/dev/null
CONFIRM=$(curl -s -X POST "$API/projects/$PID/business-profile/confirm" "${AUTH[@]}")
# The targets live under `profile.data.targets` — `profile.targets` was the
# pre-P04 shape and has been empty since, so this assertion reported a failure
# even when the confirm succeeded (it also left the seeding unverified, which is
# specifically what this fixture depends on).
[ "$(echo "$CONFIRM" | jget profile.data.targets.0.country)" = "US" ] && ok "confirmed a US target market" || bad "target-market confirm: $(echo "$CONFIRM" | head -c 200)"

# --- 1. site context (deterministic path, no key) ---------------------------
# maxPages=1: the smoke domain deliberately does not resolve, so every fetch
# retries to its timeout. One page keeps the suite fast while still proving the
# context row is written honestly (0 pages fetched, competitors carried through).
CTX=$(curl -s -X POST "$API/projects/$PID/aeo/context" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":1,"refine":false}')
CTXID=$(echo "$CTX" | jget id)
[ -n "$CTXID" ] && [ "$CTXID" != "__ERR__" ] && ok "built site context $CTXID" || { bad "context build"; echo "$CTX"; }
[ "$(echo "$CTX" | jget extraction)" = "deterministic" ] && ok "extraction=deterministic (refine:false — provenance recorded honestly)" || bad "extraction = $(echo "$CTX" | jget extraction)"
[ "$(echo "$CTX" | jget costUsd)" = "0" ] && ok "context cost 0 (no LLM call made)" || bad "cost != 0"
[ "$(echo "$CTX" | jlen competitors)" = "2" ] && ok "2 competitors carried from the project" || bad "competitors = $(echo "$CTX" | jlen competitors)"

GET_CTX=$(curl -s "$API/projects/$PID/aeo/context" "${AUTH[@]}")
[ "$(echo "$GET_CTX" | jget id)" = "$CTXID" ] && ok "GET /context returns the latest row" || bad "GET /context mismatch"

# --- 2. prompt matrix (template phrasing, no key) ---------------------------
MTX=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"tier":"scorecard","refine":false,"activate":true}')
# POST /aeo/matrix is throttled to 5 requests per minute, and this suite makes
# four of them. A second run started inside that window answers 429, which then
# reads as ~19 unrelated assertion failures. Name the cause on the spot so a
# throttled run is not mistaken for a code regression.
if echo "$MTX" | grep -q 'ThrottlerException'; then
  bad "THROTTLED: POST /aeo/matrix allows 5/min and this suite needs 4 — the matrix failures below are the rate limit, not the code. Re-run once the minute has passed."
fi
QSID=$(echo "$MTX" | jget querySetId)
[ -n "$QSID" ] && [ "$QSID" != "__ERR__" ] && ok "generated matrix $QSID" || { bad "matrix generate"; echo "$MTX"; }
COUNT=$(echo "$MTX" | jget promptCount)
[ "$COUNT" -ge 10 ] 2>/dev/null && ok "matrix has $COUNT prompts" || bad "promptCount = $COUNT"
[ "$(echo "$MTX" | jget status)" = "active" ] && ok "matrix activated (measurable)" || bad "status = $(echo "$MTX" | jget status)"
[ "$(echo "$MTX" | jget refined)" = "false" ] && ok "refined=false (refine:false — template phrasing kept)" || bad "refined != false"

DIMS=$(echo "$MTX" | jlen byDimension)
[ "$DIMS" -ge 4 ] 2>/dev/null && ok "$DIMS categories represented" || bad "byDimension = $DIMS"

# The two categories the brief called out explicitly must actually have prompts.
# Checked via the ?dimension= filter, not a raw grep: the `skipped` array also
# names dimensions, so grepping the whole payload passes for the wrong reason.
dim_count() { curl -s "$API/projects/$PID/aeo/matrix/$QSID?dimension=$1" "${AUTH[@]}" | jget byDimension.0.count; }
[ "$(dim_count competitor-alternatives)" -ge 1 ] 2>/dev/null && ok "competitor-alternatives has prompts" || bad "competitor-alternatives empty"
[ "$(dim_count head-to-head)" -ge 1 ] 2>/dev/null && ok "head-to-head has prompts" || bad "head-to-head empty"
curl -s "$API/projects/$PID/aeo/matrix/$QSID?dimension=competitor-alternatives" "${AUTH[@]}" \
  | grep -qi 'Profound' && ok "competitor interpolated into prompts" || bad "competitor not interpolated"

# Categorisation must be persisted per prompt, not just grouped in the response.
echo "$MTX" | grep -q '"dimension":"' && ok "each prompt carries its category" || bad "prompt dimension missing"
echo "$MTX" | grep -q '"branding":"unbranded"' && ok "branded/unbranded axis recorded" || bad "branding axis missing"
echo "$MTX" | grep -q '"template":"' && ok "template id recorded (reproducible)" || bad "template id missing"

# Curation view: filter by one category.
FILT=$(curl -s "$API/projects/$PID/aeo/matrix/$QSID?dimension=competitor-alternatives" "${AUTH[@]}")
[ "$(echo "$FILT" | jlen byDimension)" = "1" ] && ok "?dimension= filters to one category" || bad "filter returned $(echo "$FILT" | jlen byDimension)"

# --- 3. determinism: same project + context + tier => same prompts ----------
MTX2=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"tier":"scorecard","refine":false,"activate":false}')
P1=$(echo "$MTX" | jget byDimension.0.prompts.0.prompt)
P2=$(echo "$MTX2" | jget byDimension.0.prompts.0.prompt)
[ -n "$P1" ] && [ "$P1" = "$P2" ] && ok "matrix is deterministic (\"$P1\")" || bad "non-deterministic: '$P1' vs '$P2'"

# --- 3b. trial tiers: scarce budget spent on the heaviest angles -----------
# On a metered measurement surface the free allowance is the binding constraint,
# so `trial` must land on exactly 5 prompts -- never the 10 that a per-dimension
# floor would produce -- and must say which angles it therefore did not cover.
TR=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json'   -d '{"tier":"trial","refine":false,"activate":false}')
[ "$(echo "$TR" | jget promptCount)" = "5" ] && ok "trial tier is exactly 5 prompts" || bad "trial promptCount = $(echo "$TR" | jget promptCount)"
[ "$(echo "$TR" | jlen byDimension)" = "5" ] && ok "trial spreads across 5 distinct categories" || bad "trial byDimension = $(echo "$TR" | jlen byDimension)"
[ "$(echo "$TR" | jlen skipped)" -ge 1 ] 2>/dev/null && ok "uncovered categories reported as skipped" || bad "trial skipped = $(echo "$TR" | jlen skipped)"
# The two categories the brief called out must survive the budget cut.
echo "$TR" | grep -q '"dimension":"competitor-alternatives"' && ok "trial keeps competitor-alternatives" || bad "trial dropped competitor-alternatives"
echo "$TR" | grep -q '"dimension":"head-to-head"' && ok "trial keeps head-to-head" || bad "trial dropped head-to-head"

TRW=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json'   -d '{"tier":"trial-wide","refine":false,"activate":false}')
[ "$(echo "$TRW" | jget promptCount)" = "10" ] && ok "trial-wide tier is exactly 10 prompts" || bad "trial-wide promptCount = $(echo "$TRW" | jget promptCount)"

# --- 4. full audit on the mock surface (n>=5, no spend) ---------------------
# Driven via start + resume, which is exactly what POST /audits/full calls
# internally. /audits/full is throttled to 3 per 5 minutes by design, so using it
# here would make repeat smoke runs fail on the throttle rather than on the code.
START=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"mock","tier":"scorecard","runCount":5}')
AID=$(echo "$START" | jget id)
[ -n "$AID" ] && [ "$AID" != "__ERR__" ] && ok "started audit $AID" || { bad "audit start"; echo "$START" | head -c 400; }
[ "$(echo "$START" | jget status)" = "pending" ] && ok "start is free (pending, no spend)" || bad "start status = $(echo "$START" | jget status)"

AUDIT=$(curl -s -X POST "$API/projects/$PID/aeo/audits/$AID/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
[ "$(echo "$AUDIT" | jget status)" = "completed" ] && ok "audit ran to completion" || { bad "status = $(echo "$AUDIT" | jget status)"; echo "$AUDIT" | head -c 400; }

# The one-call demo route exists and is rate-limited (201 first, 429 once spent).
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/aeo/audits/full" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{"surface":"mock","tier":"scorecard","runCount":5,"reuseContext":true,"skipRefine":true,"skipStance":true}')
case "$SC" in 201|409|429) ok "/audits/full reachable and throttled (got $SC)";; *) bad "/audits/full returned $SC";; esac

OBS=$(echo "$AUDIT" | jget observations)
[ "$OBS" -gt 0 ] 2>/dev/null && ok "$OBS observations recorded" || bad "observations = $OBS"

# --- 5. verdict: counted and judged kept apart ------------------------------
V=$(curl -s "$API/projects/$PID/aeo/audits/$AID/verdict" "${AUTH[@]}")
[ "$(echo "$V" | jget surface)" = "mock" ] && ok "verdict names the surface" || bad "surface = $(echo "$V" | jget surface)"
[ "$(echo "$V" | jget runCount)" = "5" ] && ok "verdict records n=5" || bad "runCount = $(echo "$V" | jget runCount)"
[ -n "$(echo "$V" | jget counted.overall.mentionRate)" ] && ok "counted.overall.mentionRate present" || bad "no counted mention rate"
[ -n "$(echo "$V" | jget counted.unbranded.mentionRate)" ] && ok "counted.unbranded split present (the honest visibility number)" || bad "no unbranded split"
[ "$(echo "$V" | jlen counted.byDimension)" -ge 4 ] 2>/dev/null && ok "per-category counted results present" || bad "byDimension empty"
# The audit above ran with skipStance, so no stance rows exist yet. Whatever the
# provider situation, the judged block must say so rather than show empty counts
# as if they were findings.
[ "$(echo "$V" | jget judged.available)" = "false" ] && ok "judged.available=false before any stance pass (never fabricated)" || bad "judged.available = $(echo "$V" | jget judged.available)"
REASON=$(echo "$V" | jget judged.unavailableReason)
case "$REASON" in
  *"has not been run"*|*"no LLM provider is configured"*) ok "judged block states why it is unavailable ($REASON)";;
  *) bad "unavailable reason unclear: $REASON";;
esac
[ "$(echo "$V" | jlen headlines)" -ge 3 ] 2>/dev/null && ok "headlines generated" || bad "headlines = $(echo "$V" | jlen headlines)"

# --- 6. honest gates --------------------------------------------------------
# The stance judge's gate depends on whether a provider is configured on the
# server, which this script cannot change. Both outcomes are asserted, and the
# keyed path is deliberately NOT exercised: judging 125 observations is real
# spend, and this harness is zero-spend by contract.
if echo "$REASON" | grep -q "no LLM provider is configured"; then
  SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/aeo/audits/$AID/stance" "${AUTH[@]}")
  [ "$SC" = "503" ] && ok "stance pass with no provider configured -> 503" || bad "stance returned $SC"
else
  skip "stance 503 gate — a provider IS configured on this server, and running the pass would spend real money"
fi

# n>=5 is not negotiable.
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{"surface":"mock","runCount":3}')
[ "$SC" = "400" ] && ok "runCount=3 rejected (n>=5, no exceptions)" || bad "runCount=3 returned $SC"

# A completed audit cannot be silently re-run.
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/aeo/audits/$AID/resume" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{}')
[ "$SC" = "409" ] && ok "resuming a completed audit -> 409" || bad "resume returned $SC"

# The real ChatGPT surface must stay off unless explicitly enabled. Driven via
# start+resume rather than /audits/full, which is deliberately throttled to 3
# per 5 minutes and would 429 on this second call.
BAUD=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"chatgpt-browser","tier":"scorecard","runCount":5}')
BAID=$(echo "$BAUD" | jget id)
BROWSER=$(curl -s -X POST "$API/projects/$PID/aeo/audits/$BAID/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
echo "$BROWSER" | grep -qi 'AEO_ALLOW_BROWSER_SURFACE\|no observations' \
  && ok "chatgpt-browser surface fails closed while disabled" \
  || bad "browser surface did not fail closed: $(echo "$BROWSER" | head -c 200)"
[ "$(curl -s "$API/projects/$PID/aeo/audits/$BAID" "${AUTH[@]}" | jget status)" = "failed" ] \
  && ok "blocked surface marks the audit failed (not silently empty)" \
  || bad "audit status after blocked surface = $(curl -s "$API/projects/$PID/aeo/audits/$BAID" "${AUTH[@]}" | jget status)"

# --- 7. multi-surface: one good engine + two gated ones --------------------
# The point of measuring several engines is that one dead engine must not void
# the others, and the report must say which produced nothing.
MS=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json'   -d '{"surfaces":["mock","perplexity-browser","gemini-browser"],"tier":"scorecard","runCount":5}')
MSID=$(echo "$MS" | jget id)
[ -n "$MSID" ] && [ "$MSID" != "__ERR__" ] && ok "started multi-engine audit" || bad "multi-engine start: $(echo "$MS" | head -c 200)"
curl -s -X POST "$API/projects/$PID/aeo/audits/$MSID/resume" "${AUTH[@]}" -H 'content-type: application/json'   -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}' >/dev/null
MSV=$(curl -s "$API/projects/$PID/aeo/audits/$MSID/verdict" "${AUTH[@]}")
[ "$(echo "$MSV" | jlen surfaceRuns)" = "3" ] && ok "3 engines recorded on the audit" || bad "surfaceRuns = $(echo "$MSV" | jlen surfaceRuns)"
[ "$(echo "$MSV" | jlen counted.bySurface)" = "3" ] && ok "per-engine comparison has a row per engine" || bad "bySurface = $(echo "$MSV" | jlen counted.bySurface)"
echo "$MSV" | grep -q '"failureKind":"no-session"' && ok "gated engines report a typed failure reason" || bad "no typed failure reason"
[ "$(echo "$MSV" | jget counted.overall.observations)" -gt 0 ] 2>/dev/null   && ok "a dead engine does not void the working one" || bad "no observations survived"
echo "$MSV" | grep -q 'absent from every number above' && ok "headline names the engines that were not measured" || bad "headline hides the missing engines"

# --- 7b. markets (wave-6 D8): explicit override fans out surface x market ---
# Two markets on one mock surface must produce two AeoSurfaceRun rows and a
# per-market breakdown in the verdict -- never averaged into one number.
MKT=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"mock","tier":"scorecard","runCount":5,"markets":["US","IE"]}')
MKTID=$(echo "$MKT" | jget id)
[ -n "$MKTID" ] && [ "$MKTID" != "__ERR__" ] && ok "started multi-market audit" || bad "multi-market start: $(echo "$MKT" | head -c 200)"
curl -s -X POST "$API/projects/$PID/aeo/audits/$MKTID/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}' >/dev/null
MKTV=$(curl -s "$API/projects/$PID/aeo/audits/$MKTID/verdict" "${AUTH[@]}")
[ "$(echo "$MKTV" | jlen surfaceRuns)" = "2" ] && ok "one surfaceRun per market (2 for mock x [US,IE])" || bad "surfaceRuns = $(echo "$MKTV" | jlen surfaceRuns)"
echo "$MKTV" | grep -q '"market":"US"' && echo "$MKTV" | grep -q '"market":"IE"' && ok "surfaceRuns carry the resolved market" || bad "market not stamped on surfaceRuns: $(echo "$MKTV" | head -c 300)"
[ "$(echo "$MKTV" | jlen counted.byMarket)" = "2" ] && ok "counted.byMarket has one row per measured market" || bad "counted.byMarket = $(echo "$MKTV" | jlen counted.byMarket)"
echo "$MKTV" | grep -q '"market":"US"' && ok "byMarket names US" || bad "byMarket missing US"

# A run with no explicit markets[] still resolves to exactly one (the
# context-derived default), so byMarket never comes back empty either.
[ "$(echo "$V" | jlen counted.byMarket)" = "1" ] && ok "a plain (no markets[]) audit still resolves one default market" || bad "default-market audit byMarket = $(echo "$V" | jlen counted.byMarket)"

# --- 7c. cloro-* surfaces (wave-6 step 1): wiring only, never a real call ---
# Cloro is a metered, real-money API (CLORO_API_KEY may or may not be set on
# this server) -- this harness is zero-spend by contract, so it asserts only
# that the surface is accepted and a row is created (POST /audits is
# scrape-free and spend-free by design), and never calls /resume on it. The
# disabled-without-a-key failure path is exercised by aeo-audit.service.ts's
# own pre-flight budget guard and is not worth risking real credits to re-prove
# here.
CLORO=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surfaces":["cloro-chatgpt"],"tier":"scorecard","runCount":5}')
CLOROID=$(echo "$CLORO" | jget id)
[ -n "$CLOROID" ] && [ "$CLOROID" != "__ERR__" ] && ok "cloro-chatgpt accepted as a surface (row created, nothing run)" || bad "cloro-chatgpt start: $(echo "$CLORO" | head -c 200)"
[ "$(echo "$CLORO" | jget status)" = "pending" ] && ok "cloro-chatgpt start is free (pending, no spend)" || bad "cloro start status = $(echo "$CLORO" | jget status)"

# --- 8. listing -------------------------------------------------------------
LIST=$(curl -s "$API/projects/$PID/aeo/audits" "${AUTH[@]}")
[ "$(echo "$LIST" | jlen audits)" -ge 1 ] 2>/dev/null && ok "audit list returns rows" || bad "audit list empty"

echo
if [ "$SKIP" -gt 0 ]; then
  echo "== aeo-audit: $PASS passed, $FAIL failed, $SKIP skipped =="
else
  echo "== aeo-audit: $PASS passed, $FAIL failed =="
fi
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# E2E smoke — P04 target markets (plan §10). The exit gate the phase exists to
# prove: "India HQ/US buyers fixture measures US; unsupported city disclosed."
#
# Zero API keys, zero spend — same pattern as aeo-audit.smoke.sh: context is
# built deterministically (refine:false, an unresolvable domain so no live
# fetch is needed), the matrix is template-phrased, and measurement runs on
# the `mock` surface (MEASUREMENT_ALLOW_MOCK=1 must be set on the server, same
# requirement as aeo-audit.smoke.sh).
#
# The "India HQ" signal comes from the project's domain ccTLD (`.in`) —
# `aeo-context.service.ts`'s `geoFromDomain()` derives `geo: 'IN'` from the
# domain suffix alone, with no live crawl needed (the domain deliberately does
# not resolve). Without a confirmed target this would previously default the
# whole audit to India (or, if geoFromDomain also failed, to the hardcoded
# 'US' fallback this phase removed). With a confirmed `{country:"US"}` target
# on the business profile, the resolved measurement market must be US.
#
# Requires: MEASUREMENT_ALLOW_MOCK=1 on the running backend (already default
# in backend/.env, same as aeo-audit.smoke.sh).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== target-markets smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# ── 1. India-HQ / US-target project ─────────────────────────────────────────
STAMP=$RANDOM
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Target Markets Smoke Co\",\"domain\":\"target-markets-smoke-$STAMP.example.in\",\"category\":\"answer engine optimization\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created India-ccTLD project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }

# A second project with no ccTLD signal at all and no confirmed target, to
# prove the removed silent-'US'-fallback path now refuses to guess.
PROJ2=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Target Markets Smoke Co (no target)\",\"domain\":\"target-markets-smoke-$STAMP-notarget.example.test\",\"category\":\"answer engine optimization\"}")
PID2=$(echo "$PROJ2" | jget id)
[ -n "$PID2" ] && [ "$PID2" != "__ERR__" ] && ok "created no-signal project $PID2" || { bad "project2 create"; echo "$PROJ2"; exit 1; }

cleanup() {
  curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1
  curl -s -X DELETE "$API/projects/$PID2" "${AUTH[@]}" >/dev/null 2>&1
  echo "(smoke projects deleted)"
}
trap cleanup EXIT

# ── 2. confirm a structured US target on the India-HQ project ──────────────
SAVE=$(curl -s -X PUT "$API/projects/$PID/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"brandName":"Target Markets Smoke Co","description":"Sells project-management software.","services":["Project management software"],"icp":{"segments":["Mid-market operations teams"]},"targets":[{"country":"US","priority":0,"active":true}]}')
[ "$(echo "$SAVE" | jget profile.data.targets.0.country)" = "US" ] && ok "draft carries structured target country=US" || bad "draft target: $(echo "$SAVE" | head -c 300)"

CONFIRM=$(curl -s -X POST "$API/projects/$PID/business-profile/confirm" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$CONFIRM" | jget profile.state)" = "confirmed" ] && ok "confirmed the profile (version $(echo "$CONFIRM" | jget profile.version))" || bad "confirm failed: $(echo "$CONFIRM" | head -c 300)"
[ "$(echo "$CONFIRM" | jget profile.data.targets.0.country)" = "US" ] && ok "confirmed version carries the US target" || bad "confirmed target missing"

# ── 3. target-locations read: real provider support, never fabricated ──────
TL=$(curl -s "$API/projects/$PID/business-profile/target-locations" "${AUTH[@]}")
[ "$(echo "$TL" | jget profileState)" = "confirmed" ] && ok "target-locations reports profileState=confirmed" || bad "profileState = $(echo "$TL" | jget profileState)"
[ "$(echo "$TL" | jlen targets)" = "1" ] && ok "target-locations returns the one confirmed target" || bad "targets = $(echo "$TL" | jlen targets)"
SUPPORT_COUNT=$(echo "$TL" | jlen providerSupport)
[ "$SUPPORT_COUNT" -ge 5 ] 2>/dev/null && ok "provider-support preview covers $SUPPORT_COUNT provider rows" || bad "providerSupport = $SUPPORT_COUNT"
echo "$TL" | grep -q '"provider":"cloro-chatgpt","providerLabel":"ChatGPT (via Cloro)","requestedCountry":"US","requestedCity":null,"effectiveGranularity":"country","mode":"provider-targeted"' \
  && ok "cloro-chatgpt honestly reported as country-level provider-targeted (real payload.country param, read from the adapter)" \
  || { bad "cloro-chatgpt support entry wrong"; echo "$TL" | grep -o '"provider":"cloro-chatgpt"[^}]*}' ; }
echo "$TL" | grep -q '"provider":"claude"[^}]*"mode":"unsupported"' \
  && ok "claude (Anthropic API) honestly reported unsupported — geo is read and discarded in the adapter, never faked as targeted" \
  || bad "claude support entry did not report unsupported"
echo "$TL" | grep -q '"provider":"chatgpt-browser"[^}]*"mode":"unsupported"' \
  && ok "chatgpt-browser honestly reported unsupported — session is not proxied to the requested region" \
  || bad "chatgpt-browser support entry did not report unsupported"

# ── 4. unsupported city target: disclosed, never silently widened ──────────
SAVE_CITY=$(curl -s -X PUT "$API/projects/$PID/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"targets":[{"country":"US","priority":0,"active":true},{"country":"US","city":"Nowhereville","priority":1,"active":true}]}')
[ "$(echo "$SAVE_CITY" | jlen profile.data.targets)" = "2" ] && ok "second (city) target saved to the draft" || bad "city target save failed"
TL2=$(curl -s "$API/projects/$PID/business-profile/target-locations" "${AUTH[@]}")
echo "$TL2" | grep -q '"requestedCity":"Nowhereville".*"provider":"cloro-chatgpt".*"mode":"unsupported"' \
  || echo "$TL2" | grep -qzP '"requestedCity":"Nowhereville"[^}]*"mode":"unsupported"' 2>/dev/null
CITY_UNSUPPORTED=$(echo "$TL2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const rows=o.providerSupport.filter(r=>r.requestedCity==="Nowhereville");const allUnsupported=rows.length>0&&rows.every(r=>r.mode==="unsupported"&&r.supported===false);process.stdout.write(String(allUnsupported))})')
[ "$CITY_UNSUPPORTED" = "true" ] && ok "an unvalidated city target is disclosed unsupported on EVERY provider — never silently widened to country and labelled the city" || bad "unsupported city was not honestly disclosed: $(echo "$TL2" | head -c 500)"
# A validated city (per the small DataForSEO whitelist) must be reported
# genuinely provider-targeted at city grain — the preview is not a blanket
# "everything is unsupported" either.
SAVE_NYC=$(curl -s -X PUT "$API/projects/$PID/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"targets":[{"country":"US","priority":0,"active":true},{"country":"US","city":"New York","priority":1,"active":true}]}')
[ "$(echo "$SAVE_NYC" | jlen profile.data.targets)" = "2" ] && ok "validated-city target saved" || bad "validated city target save failed"
TL3=$(curl -s "$API/projects/$PID/business-profile/target-locations" "${AUTH[@]}")
NYC_DATAFORSEO_CITY=$(echo "$TL3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const r=o.providerSupport.find(x=>x.provider==="dataforseo-serp"&&x.requestedCity==="New York");process.stdout.write(r?`${r.mode}:${r.effectiveGranularity}:${r.supported}`:"NONE")})')
[ "$NYC_DATAFORSEO_CITY" = "provider-targeted:city:true" ] && ok "a validated city (New York on the DataForSEO whitelist) is honestly reported city-level provider-targeted" || bad "validated city support = $NYC_DATAFORSEO_CITY"

# Restore to the single plain US target for the measurement-scope assertions below.
curl -s -X PUT "$API/projects/$PID/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"targets":[{"country":"US","priority":0,"active":true}]}' >/dev/null
curl -s -X POST "$API/projects/$PID/business-profile/confirm" "${AUTH[@]}" -H 'content-type: application/json' -d '{}' >/dev/null

# ── 5. THE EXIT GATE: India HQ + confirmed US target => measured for US ────
CTX=$(curl -s -X POST "$API/projects/$PID/aeo/context" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":1,"refine":false}')
CTXID=$(echo "$CTX" | jget id)
[ -n "$CTXID" ] && [ "$CTXID" != "__ERR__" ] && ok "built site context $CTXID (deterministic, no key)" || { bad "context build"; echo "$CTX" | head -c 300; }
[ "$(echo "$CTX" | jget geo)" = "IN" ] && ok "site context ccTLD-derived geo is IN (the India-HQ signal a silent default would have used)" || bad "context geo = $(echo "$CTX" | jget geo) (expected IN — smoke fixture broken, not the feature under test)"

MTX=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json' -d '{"tier":"trial","refine":false,"activate":true}')
QSID=$(echo "$MTX" | jget querySetId)
[ -n "$QSID" ] && [ "$QSID" != "__ERR__" ] && ok "generated matrix $QSID" || { bad "matrix generate"; echo "$MTX" | head -c 300; }

START=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"mock","tier":"trial","runCount":5}')
AID=$(echo "$START" | jget id)
[ -n "$AID" ] && [ "$AID" != "__ERR__" ] && ok "started audit $AID with NO explicit geo/markets override" || { bad "audit start"; echo "$START" | head -c 300; }

AUDIT=$(curl -s -X POST "$API/projects/$PID/aeo/audits/$AID/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
[ "$(echo "$AUDIT" | jget status)" = "completed" ] && ok "audit ran to completion on the mock surface" || { bad "audit status = $(echo "$AUDIT" | jget status)"; echo "$AUDIT" | head -c 400; }

VERDICT=$(curl -s "$API/projects/$PID/aeo/audits/$AID/verdict" "${AUTH[@]}")
EFFECTIVE_MARKET=$(echo "$VERDICT" | jget counted.byMarket.0.market)
[ "$EFFECTIVE_MARKET" = "US" ] && ok "*** EXIT GATE: effective measurement scope is US, not IN — the confirmed target won over the India-HQ ccTLD signal ***" \
  || bad "*** EXIT GATE FAILED: effective market = '$EFFECTIVE_MARKET', expected US (would mean the silent HQ/ccTLD default is still live) ***"
[ "$(echo "$VERDICT" | jlen counted.byMarket)" = "1" ] && ok "exactly one market measured (no fan-out to India, no extra guessed market)" || bad "byMarket has $(echo "$VERDICT" | jlen counted.byMarket) entries"

AUDIT_ROW=$(curl -s "$API/projects/$PID/aeo/audits/$AID" "${AUTH[@]}")
echo "$AUDIT_ROW" | grep -q '"markets":"\[\\"US\\"\]"' \
  && ok "AeoAudit.markets persisted as [\"US\"]" \
  || bad "AeoAudit.markets not persisted as US: $(echo "$AUDIT_ROW" | jget markets)"

# ── 6. no confirmed target + no ccTLD/site signal => refuses to guess ──────
# This project's domain (.example.test) has no ccTLD in aeo-context.service's
# geoFromDomain() map, the smoke domain deliberately does not resolve (so
# markets[] extraction is empty), and no business-profile target was ever
# confirmed. Previously this fell through to a hardcoded 'US' default; that
# rung no longer exists.
CTX2=$(curl -s -X POST "$API/projects/$PID2/aeo/context" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":1,"refine":false}')
CTXID2=$(echo "$CTX2" | jget id)
[ -n "$CTXID2" ] && [ "$CTXID2" != "__ERR__" ] && ok "built site context for the no-signal project" || bad "context2 build failed"
[ -z "$(echo "$CTX2" | jget geo)" ] && ok "no-signal project's context has no ccTLD-derived geo (fixture is clean)" || bad "no-signal project unexpectedly has geo = $(echo "$CTX2" | jget geo) — smoke fixture broken, pick a domain suffix absent from geoFromDomain()"

MTX2=$(curl -s -X POST "$API/projects/$PID2/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json' -d '{"tier":"trial","refine":false,"activate":true}')
QSID2=$(echo "$MTX2" | jget querySetId)
[ -n "$QSID2" ] && [ "$QSID2" != "__ERR__" ] && ok "generated matrix for the no-signal project" || bad "matrix2 generate failed"

START2=$(curl -s -X POST "$API/projects/$PID2/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"mock","tier":"trial","runCount":5}')
AID2=$(echo "$START2" | jget id)
[ -n "$AID2" ] && [ "$AID2" != "__ERR__" ] && ok "started audit for the no-signal project" || bad "audit2 start failed"

RESUME2_CODE=$(curl -s -o /tmp/target-markets-resume2.json -w '%{http_code}' -X POST "$API/projects/$PID2/aeo/audits/$AID2/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
RESUME2_BODY=$(cat /tmp/target-markets-resume2.json 2>/dev/null || echo '{}')
rm -f /tmp/target-markets-resume2.json
[ "$RESUME2_CODE" = "409" ] && ok "no confirmed target + no site signal -> 409, refuses to silently default (removed ccTLD -> default-US path)" || bad "resume2 returned HTTP $RESUME2_CODE (expected 409): $(echo "$RESUME2_BODY" | head -c 300)"
echo "$RESUME2_BODY" | grep -qi 'Confirm at least one target country' \
  && ok "refusal names the fix (confirm a target location) rather than a bare error" \
  || bad "refusal message unclear: $(echo "$RESUME2_BODY" | head -c 300)"
[ "$(curl -s "$API/projects/$PID2/aeo/audits/$AID2" "${AUTH[@]}" | jget status)" = "failed" ] \
  && ok "the audit row records status=failed (not silently left pending)" \
  || bad "audit2 status = $(curl -s "$API/projects/$PID2/aeo/audits/$AID2" "${AUTH[@]}" | jget status)"

# ── 7. explicit geo override still works (a deliberate provisional run) ────
# `geo` only takes effect in resolveDefaultMarket, which reads it off the
# RESUME call's own input (same precedence the pre-existing code already
# had) — so it must be passed on resume, not just start.
START3=$(curl -s -X POST "$API/projects/$PID2/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"mock","tier":"trial","runCount":5}')
AID3=$(echo "$START3" | jget id)
curl -s -X POST "$API/projects/$PID2/aeo/audits/$AID3/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true,"geo":"GB"}' >/dev/null
V3=$(curl -s "$API/projects/$PID2/aeo/audits/$AID3/verdict" "${AUTH[@]}")
[ "$(echo "$V3" | jget counted.byMarket.0.market)" = "GB" ] && ok "an explicit geo override (staff-approved provisional run) still works even with no confirmed target" || bad "explicit override result = $(echo "$V3" | jget counted.byMarket.0.market)"

echo
echo "target-markets smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

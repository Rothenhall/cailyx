#!/usr/bin/env bash
# E2E smoke — digital-presence module (where the client exists online).
#
# Zero spend, zero keys: discovery is the fetcher against the client's own site.
# The smoke project uses a deliberately unresolvable domain, so the crawl finds
# nothing -- which is the important case, because "found nothing" is exactly when
# the operator has to supply accounts by hand, and that path must work.
#
# The classifier is exercised through the API rather than in isolation: a share
# widget and a post URL must both be REJECTED with a 400, because a false account
# in a client's presence report is worse than a missing one.
#
# Wave-6 step 5 additions (DataForSEO Business Data + Apify social activity):
# DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are genuinely absent here, so the
# business-profile pull is asserted to fail closed with a 503 -- never a live
# call, never a fabricated profile. The social-activity (Apify) pull is a REAL
# account with real spend attached, so this script asserts ONLY the opt-in
# refusal path (missing/false confirmSpend) and NEVER passes confirmSpend:
# true -- that call is not made anywhere in this repository's automation.
#
# Writes to dev.db and deletes the smoke project at the end.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

echo "== digital-presence smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Presence Smoke Co\",\"domain\":\"presence-smoke-$RANDOM.example.com\",\"category\":\"digital presence\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- 1. empty inventory is a real answer, not an error ----------------------
INV=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV" | jget counts.total)" = "0" ] && ok "empty inventory returns 0 accounts (not an error)" || bad "counts.total = $(echo "$INV" | jget counts.total)"
[ "$(echo "$INV" | jget lastRun)" = "" ] && ok "lastRun is null before any scan" || bad "lastRun = $(echo "$INV" | jget lastRun)"
# Gaps must be populated even with no scan: they are what the operator acts on.
[ "$(echo "$INV" | jlen gaps)" -ge 5 ] 2>/dev/null && ok "$(echo "$INV" | jlen gaps) expected platforms reported as gaps" || bad "gaps = $(echo "$INV" | jlen gaps)"
[ "$(echo "$INV" | jlen footprint)" = "5" ] && ok "footprint has all 5 sections" || bad "footprint sections = $(echo "$INV" | jlen footprint)"

# "not-checked" must appear before any module has run. If every unrun module
# reported "none" instead, the operator would read absence of work as absence of
# findings -- the distinction this module exists to preserve.
echo "$INV" | grep -q '"state":"not-checked"' && ok "unrun modules report not-checked (not none)" || bad "no not-checked state present"

# --- 2. discovery on a dead domain fails honestly ---------------------------
# Discovery now queues the crawl/verify on the background pipeline and
# returns immediately (status: crawling) — poll the run by id until it
# reaches a terminal status before asserting on its fields.
QUEUED=$(curl -s -X POST "$API/projects/$PID/presence/discover" "${AUTH[@]}" -H 'content-type: application/json')
RID=$(echo "$QUEUED" | jget id)
[ -n "$RID" ] && [ "$RID" != "__ERR__" ] && ok "discovery queued ($RID)" || { bad "discover did not return a run id"; echo "$QUEUED" | head -c 400; }
RUN=$(poll_until "$API/projects/$PID/presence/discoveries/$RID" status "completed failed" 30 "${AUTH[@]}")
RSTATUS=$(echo "$RUN" | jget status)
[ "$RSTATUS" = "completed" ] && ok "discovery completed on an unreachable domain (no crash)" || bad "status = $RSTATUS"
[ "$(echo "$RUN" | jget found)" = "0" ] && ok "0 accounts found (domain does not resolve)" || bad "found = $(echo "$RUN" | jget found)"
[ "$(echo "$RUN" | jget pagesFetched)" = "0" ] && ok "0 pages fetched, reported honestly" || bad "pagesFetched = $(echo "$RUN" | jget pagesFetched)"

HIST=$(curl -s "$API/projects/$PID/presence/discoveries" "${AUTH[@]}")
[ "$(echo "$HIST" | jlen)" -ge 1 ] 2>/dev/null && ok "discovery run recorded in history" || bad "history = $(echo "$HIST" | jlen)"

# --- 3. the manual path — the whole point when discovery finds nothing ------
add_account() {
  curl -s -o /tmp/pres_add.json -w '%{http_code}' -X POST "$API/projects/$PID/presence/accounts" \
    "${AUTH[@]}" -H 'content-type: application/json' -d "{\"url\":\"$1\"}"
}

SC=$(add_account "https://www.linkedin.com/company/acme-ltd")
[ "$SC" = "201" ] && ok "operator can add a LinkedIn company URL" || { bad "add linkedin -> $SC"; cat /tmp/pres_add.json; }
[ "$(jget platform < /tmp/pres_add.json)" = "linkedin" ] && ok "platform derived from the URL (no dropdown needed)" || bad "platform = $(jget platform < /tmp/pres_add.json)"
[ "$(jget handle < /tmp/pres_add.json)" = "acme-ltd" ] && ok "handle parsed from the path" || bad "handle = $(jget handle < /tmp/pres_add.json)"
[ "$(jget source < /tmp/pres_add.json)" = "manual" ] && ok "source recorded as manual" || bad "source = $(jget source < /tmp/pres_add.json)"

# LinkedIn refuses datacentre IPs, so it must land as unverified WITH a reason --
# never as confirmed (a lie) and never as missing (also a lie).
ST=$(jget state < /tmp/pres_add.json)
[ "$ST" = "unverified" ] && ok "LinkedIn lands as unverified (platform refuses the check)" || bad "state = $ST"
[ -n "$(jget reason < /tmp/pres_add.json)" ] && ok "the reason is stated verbatim: $(jget reason < /tmp/pres_add.json)" || bad "unverified with no reason given"

SC=$(add_account "https://www.instagram.com/acmebrand")
[ "$SC" = "201" ] && ok "operator can add an Instagram URL" || bad "add instagram -> $SC"
AID=$(jget id < /tmp/pres_add.json)

# --- 4. false positives must be refused -------------------------------------
# These are the URLs that appear on ordinary marketing sites and would each be
# reported to a client as their account by a naive host match.
reject() {
  local sc; sc=$(add_account "$1")
  [ "$sc" = "400" ] && ok "rejected $2" || bad "$2 accepted with $sc"
}
reject "https://www.facebook.com/sharer/sharer.php?u=https://acme.io" "Facebook share widget"
reject "https://twitter.com/intent/tweet?text=hi" "X intent link"
reject "https://www.linkedin.com/shareArticle?mini=true" "LinkedIn share widget"
reject "https://www.instagram.com/p/CxYzAbCdEfG/" "an Instagram post (not a profile)"
reject "https://www.youtube.com/watch?v=dQw4w9WgXcQ" "a YouTube video (not a channel)"
reject "https://acme.io/about" "a non-platform URL"

# --- 5. inventory reflects what was added -----------------------------------
INV=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV" | jget counts.total)" = "2" ] && ok "inventory shows both added accounts" || bad "counts.total = $(echo "$INV" | jget counts.total)"
[ "$(echo "$INV" | jget counts.manual)" = "2" ] && ok "both counted as operator-supplied" || bad "counts.manual = $(echo "$INV" | jget counts.manual)"
[ "$(echo "$INV" | jget counts.social)" = "2" ] && ok "both grouped as social" || bad "counts.social = $(echo "$INV" | jget counts.social)"
# linkedin + instagram are now held, so the gap list must have shrunk by exactly 2.
[ "$(echo "$INV" | jlen gaps)" = "3" ] && ok "gaps shrink as accounts are supplied (3 left)" || bad "gaps = $(echo "$INV" | jlen gaps)"
# Scoped to the gaps array on purpose: the accounts array carries the same
# "platform":"linkedin" key, so grepping the whole payload passes/fails for the
# wrong reason.
echo "$INV" | jget gaps | grep -q '"platform":"linkedin"' && bad "linkedin still listed as a gap" || ok "a supplied platform stops being a gap"

# --- 6. a re-scan must not clobber operator input ---------------------------
# This is the rule that matters most: a crawl that finds nothing must never
# demote what the operator typed in.
QUEUED2=$(curl -s -X POST "$API/projects/$PID/presence/discover" "${AUTH[@]}" -H 'content-type: application/json')
RID2=$(echo "$QUEUED2" | jget id)
poll_until "$API/projects/$PID/presence/discoveries/$RID2" status "completed failed" 30 "${AUTH[@]}" >/dev/null
INV2=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV2" | jget counts.total)" = "2" ] && ok "re-scan preserves operator accounts" || bad "after re-scan total = $(echo "$INV2" | jget counts.total)"
[ "$(echo "$INV2" | jget counts.manual)" = "2" ] && ok "re-scan preserves manual provenance" || bad "after re-scan manual = $(echo "$INV2" | jget counts.manual)"

# --- 7. dedupe: the same profile added twice stays one row ------------------
add_account "https://instagram.com/acmebrand?utm_source=footer" >/dev/null
INV3=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV3" | jget counts.total)" = "2" ] && ok "same profile re-added (with tracking params) stays one row" || bad "dedupe failed, total = $(echo "$INV3" | jget counts.total)"

# --- 7b. SERP candidates are NOT accounts -----------------------------------
# The smoke domain does not resolve and its brand name is nonsense, so a sweep
# either finds nothing or finds unrelated rows. Either way the invariants must
# hold: candidates never inflate the account count, and never close a gap.
RUN2=$(curl -s "$API/projects/$PID/presence/discoveries" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.stringify(JSON.parse(s)[0]||{}))}catch(e){process.stdout.write("{}")}})')
SERPQ=$(echo "$RUN2" | jget serpQueries)
# THE zero-spend assertion. Google search is billed per query, so a default
# discovery run must never make one -- otherwise this harness, which is
# zero-spend by contract, quietly burns the operator's allowance every time the
# suite runs. `searchWeb` is opt-in for exactly this reason.
[ "$SERPQ" = "0" ] && ok "default discovery spends no search credits (zero-spend contract holds)" || bad "default run spent $SERPQ search credits"
# ...and the reason must be stated, so an operator can tell "searched, found
# nothing" from "never searched".
[ -n "$(echo "$RUN2" | jget serpSkipped)" ] && ok "and says why it did not search: $(echo "$RUN2" | jget serpSkipped)" || bad "0 queries but no serpSkipped reason"

INVC=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
CAND=$(echo "$INVC" | jget counts.candidates)
[ -n "$CAND" ] && ok "inventory reports a separate candidate count ($CAND)" || bad "counts.candidates missing"
# The invariant that matters: total counts real accounts only.
REALN=$(echo "$INVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.accounts.filter(a=>a.state!=="candidate").length))})')
[ "$(echo "$INVC" | jget counts.total)" = "$REALN" ] && ok "counts.total excludes candidates ($REALN real accounts)" || bad "counts.total=$(echo "$INVC" | jget counts.total) but $REALN non-candidate rows"

# Confirming a non-candidate must be refused, or the endpoint becomes a way to
# silently relabel a crawled account as operator-supplied.
FIRST=$(echo "$INVC" | jget accounts.0.id)
FIRSTSTATE=$(echo "$INVC" | jget accounts.0.state)
if [ -n "$FIRST" ] && [ "$FIRSTSTATE" != "candidate" ]; then
  SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/presence/accounts/$FIRST/confirm" "${AUTH[@]}")
  [ "$SC" = "400" ] && ok "confirming a non-candidate -> 400" || bad "confirm non-candidate -> $SC"
fi
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/presence/accounts/does-not-exist/confirm" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "confirming an unknown id -> 404" || bad "confirm unknown -> $SC"

# --- 7c. a founder is not the company ---------------------------------------
# The audit is about the COMPANY. A personal LinkedIn or Google Scholar page is
# real and worth recording, but counting it as corporate reach answers a question
# nobody asked -- and on rothenhall.com it turned 1 company profile into "3".
SC=$(add_account "https://www.linkedin.com/in/some-founder-person")
[ "$SC" = "201" ] && ok "a personal LinkedIn can still be recorded" || bad "add personal linkedin -> $SC"
[ "$(jget entity < /tmp/pres_add.json)" = "personal" ] && ok "linkedin.com/in/ is classified as personal" || bad "entity = $(jget entity < /tmp/pres_add.json)"
PERSONAL_ID=$(jget id < /tmp/pres_add.json)

INVP=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INVP" | jget counts.personal)" = "1" ] && ok "personal profiles counted separately" || bad "counts.personal = $(echo "$INVP" | jget counts.personal)"
# The invariant: adding a personal profile must not move the company total.
[ "$(echo "$INVP" | jget counts.total)" = "2" ] && ok "company total unchanged by a personal profile" || bad "counts.total = $(echo "$INVP" | jget counts.total) (a personal row leaked into company reach)"
# ...and it must not close the LinkedIn gap either, since the COMPANY still has none.
echo "$INVP" | jget gaps | grep -q '"platform":"linkedin"' && ok "a personal LinkedIn does not satisfy the company LinkedIn gap" || skip "linkedin gap already filled by the company account added earlier"

curl -s -X DELETE "$API/projects/$PID/presence/accounts/$PERSONAL_ID" "${AUTH[@]}" >/dev/null

# --- 7d. the assessment: stage 2's "analyse" column --------------------------
ASS=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$ASS" | jlen assessment.coverage)" = "5" ] && ok "coverage reports all 5 stage-2 categories" || bad "coverage rows = $(echo "$ASS" | jlen assessment.coverage)"
[ "$(echo "$ASS" | jlen assessment.headlines)" -ge 1 ] 2>/dev/null && ok "assessment produces a plain-language read" || bad "no headlines"
# What it did NOT look at must be stated, never implied by silence.
[ "$(echo "$ASS" | jlen assessment.notMeasured)" -ge 3 ] 2>/dev/null && ok "unmeasured capabilities are named, not hidden" || bad "notMeasured = $(echo "$ASS" | jlen assessment.notMeasured)"
[ -n "$(echo "$ASS" | jget assessment.businessProfileLabel)" ] && ok "the expected set states which business type it assumed ($(echo "$ASS" | jget assessment.businessProfileLabel))" || bad "businessProfileLabel missing"

# --- 7e. business-profile (wave-6 D2): DataForSEO not configured -> honest 503
# DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are genuinely absent in this environment
# (only a commented placeholder exists in .env.example) -- the pull must fail
# closed with a typed 503 naming what is missing, never a fake/empty profile.
BP_CODE=$(curl -s -o /tmp/pres_bp.json -w '%{http_code}' -X POST "$API/projects/$PID/presence/business-profile" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$BP_CODE" = "503" ] && ok "business-profile pull -> 503 (DataForSEO not configured)" || { bad "business-profile -> $BP_CODE"; cat /tmp/pres_bp.json; }
grep -qi "SWARM_ALLOW_LIVE\|DATAFORSEO" /tmp/pres_bp.json && ok "503 names the missing DataForSEO config" || bad "503 body does not name what is missing: $(cat /tmp/pres_bp.json)"

# The inventory must still show it as unmeasured (never a fabricated profile).
INV_BP=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV_BP" | jget businessProfile)" = "" ] && ok "businessProfile stays null -- never a fabricated empty profile" || bad "businessProfile = $(echo "$INV_BP" | jget businessProfile)"
[ "$(echo "$INV_BP" | jlen reviews)" = "0" ] && ok "reviews stay empty" || bad "reviews = $(echo "$INV_BP" | jlen reviews)"
echo "$INV_BP" | jget assessment.notMeasured | grep -qi "DataForSEO\|Review ratings" \
  && ok "notMeasured names the review/profile gap honestly" \
  || bad "notMeasured does not mention DataForSEO/reviews: $(echo "$INV_BP" | jget assessment.notMeasured)"
rm -f /tmp/pres_bp.json

# --- 7f. social-activity (wave-6 D7): opt-in gate -- zero-spend contract ----
# APIFY_API_KEY is a REAL key with real spend attached to it in production.
# This module must NEVER call Apify without an explicit confirmSpend: true --
# and this smoke suite must NEVER pass that flag, in any environment, or
# running the test suite itself would spend real account credit. Only the
# refusal path is asserted here, exactly as the header comment promises.
SA_CODE=$(curl -s -o /tmp/pres_sa.json -w '%{http_code}' -X POST "$API/projects/$PID/presence/social-activity" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$SA_CODE" = "400" ] && ok "social-activity with no confirmSpend field -> 400 (nothing run)" || { bad "social-activity (no body) -> $SA_CODE"; cat /tmp/pres_sa.json; }

SA_CODE2=$(curl -s -o /tmp/pres_sa2.json -w '%{http_code}' -X POST "$API/projects/$PID/presence/social-activity" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{"confirmSpend":false}')
[ "$SA_CODE2" = "400" ] && ok "social-activity with confirmSpend:false -> 400 (nothing run)" || { bad "social-activity (false) -> $SA_CODE2"; cat /tmp/pres_sa2.json; }
grep -qi "confirmSpend" /tmp/pres_sa2.json && ok "400 explains the opt-in requirement" || bad "400 body does not mention confirmSpend: $(cat /tmp/pres_sa2.json)"

# `POST /social-activity` is throttled at 2 requests / 60s -- deliberately
# tight, because a call that got through would spend real Apify credit. Two
# have already been spent above, so this third one is guaranteed a 429 unless
# the window is allowed to drain first. Without this wait the assertion below
# failed on every run, which read like a validation regression and was not one.
# The 60s is the throttle's own TTL; shortening it just moves the flake.
sleep 61

SA_CODE3=$(curl -s -o /tmp/pres_sa3.json -w '%{http_code}' -X POST "$API/projects/$PID/presence/social-activity" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{"confirmSpend":true,"platforms":["myspace"]}')
[ "$SA_CODE3" = "400" ] && ok "an unknown platform is rejected by validation -> 400 (nothing run)" || { bad "social-activity (bad platform) -> $SA_CODE3"; cat /tmp/pres_sa3.json; }

# The invariant that matters: no PresencePost rows and no cost recorded,
# regardless of whether APIFY_API_KEY happens to be configured in this
# environment -- none of the calls above passed a genuine confirmSpend: true.
INV_SA=$(curl -s "$API/projects/$PID/presence" "${AUTH[@]}")
[ "$(echo "$INV_SA" | jlen socialActivity)" = "0" ] && ok "zero-spend contract holds: no social-activity rows without confirmSpend" || bad "socialActivity = $(echo "$INV_SA" | jget socialActivity)"
echo "$INV_SA" | jget assessment.notMeasured | grep -qi "Social activity\|Apify" \
  && ok "notMeasured names the social-activity gap honestly" \
  || bad "notMeasured does not mention social activity: $(echo "$INV_SA" | jget assessment.notMeasured)"
rm -f /tmp/pres_sa.json /tmp/pres_sa2.json /tmp/pres_sa3.json

# --- 8. delete -------------------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/projects/$PID/presence/accounts/$AID" "${AUTH[@]}")
[ "$SC" = "200" ] && ok "delete an account -> 200" || bad "delete -> $SC"
SC=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/projects/$PID/presence/accounts/$AID" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "deleting it again -> 404" || bad "second delete -> $SC"

# --- 9. ownership ----------------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/does-not-exist/presence" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC"

rm -f /tmp/pres_add.json
echo ""
echo "== digital-presence: $PASS passed, $FAIL failed, $SKIP skipped =="
[ "$FAIL" = "0" ]

#!/usr/bin/env bash
# E2E smoke — P13 unified AI visibility (platform_improvement_plan.md §8,
# §20.2 exit gate: "Scope/denominator truth preserved; no duplicate prompt
# destination.").
#
# Zero API keys, zero real spend: runs the mock surface at n=5 (same pattern
# as aeo-audit.smoke.sh), then exercises the three composed reads —
# GET .../aeo/visibility/summary, /questions, /history — proving:
#   1. a question-set version change is disclosed as a comparability break in
#      history, never silently averaged with the earlier version;
#   2. a failed/gated surface is named in the denominator disclosure, never
#      quietly dropped to inflate the visible rate;
#   3. a question with zero observations reads "Not checked" — checked:false,
#      attempts:0, appearedCount:0, checkedAt:null — and the whole summary of a
#      measurement that produced nothing still composes (it used to 400) with
#      no fabricated zero-appearance rate (§8.4);
#   4. "appeared" and "recommended" stay separate measures, and nothing here
#      claims an ordered "#1 in AI" position;
#   5. the merged screen's data lives behind ONE prompt destination — no
#      second/competing route, and the retired prompt-library route redirects.
#
# Requires: MEASUREMENT_ALLOW_MOCK=1 on the running backend.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
# Same convention as portal-plan.smoke.sh: run from backend/ so relative paths
# (including the web sources the destination checks read) resolve regardless of
# the caller's cwd.
cd "$(dirname "$0")/.." || exit 1
WEB_ROOT="${WEB_ROOT:-../web}"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== ai-visibility-unified smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"SampleCo\",\"domain\":\"ai-vis-smoke-$RANDOM.example.com\",\"category\":\"answer engine optimization\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }

# A second project carries the zero-observation audit below. It is separate
# because the point of that section is partly what the DEFAULT (no auditId)
# resolution does when a project's only measurement produced nothing — which
# cannot be observed on a project that also has a completed audit.
PROJ2=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"SampleCo\",\"domain\":\"ai-vis-zero-$RANDOM.example.com\",\"category\":\"answer engine optimization\"}")
PID2=$(echo "$PROJ2" | jget id)
[ -n "$PID2" ] && [ "$PID2" != "__ERR__" ] && ok "created second project $PID2 (zero-observation fixture)" || { bad "second project create"; echo "$PROJ2"; exit 1; }

cleanup() {
  curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1
  curl -s -X DELETE "$API/projects/$PID2" "${AUTH[@]}" >/dev/null 2>&1
  echo "(smoke projects deleted)"
}
trap cleanup EXIT

curl -s -X PUT "$API/projects/$PID/competitors" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"competitors":[{"name":"Profound","domain":"tryprofound.com"}]}' >/dev/null

# P04 (plan §10.2): resolveDefaultMarket() needs an explicit geo, a confirmed
# business-profile target country, or usable SiteContext evidence. These
# fixtures' domains do not resolve, so seed+confirm a target market — same
# pattern aeo-audit.smoke.sh already uses.
seed_market() {
  curl -s -X PUT "$API/projects/$1/business-profile" "${AUTH[@]}" -H 'content-type: application/json' \
    -d '{"targets":[{"country":"US","priority":1,"active":true}]}' >/dev/null
  curl -s -X POST "$API/projects/$1/business-profile/confirm" "${AUTH[@]}"
}
CONFIRM=$(seed_market "$PID")
[ "$(echo "$CONFIRM" | jget profile.data.targets.0.country)" = "US" ] && ok "confirmed a US target market" || bad "target-market confirm: $(echo "$CONFIRM" | head -c 200)"

curl -s -X POST "$API/projects/$PID/aeo/context" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":1,"refine":false}' >/dev/null

# --- audit 1: v1 question set, one clean engine + one gated engine --------
START1=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surfaces":["mock","perplexity-browser"],"tier":"scorecard","runCount":5}')
AID1=$(echo "$START1" | jget id)
[ -n "$AID1" ] && [ "$AID1" != "__ERR__" ] && ok "started audit 1 (mock + gated perplexity-browser)" || { bad "audit1 start"; echo "$START1" | head -c 300; exit 1; }
AUDIT1=$(curl -s -X POST "$API/projects/$PID/aeo/audits/$AID1/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
[ "$(echo "$AUDIT1" | jget status)" = "completed" ] && ok "audit 1 ran to completion" || { bad "audit1 status = $(echo "$AUDIT1" | jget status)"; echo "$AUDIT1" | head -c 400; }
QS1=$(echo "$AUDIT1" | jget querySetId)

# --- 1. summary: denominator truth — the gated engine is named, not dropped -
SUMMARY=$(curl -s "$API/projects/$PID/aeo/visibility/summary" "${AUTH[@]}")
[ "$(echo "$SUMMARY" | jget auditId)" = "$AID1" ] && ok "summary reads the latest completed audit by default" || bad "summary.auditId = $(echo "$SUMMARY" | jget auditId) (expected $AID1)"
echo "$SUMMARY" | grep -qi '"surface":"perplexity-browser"' && ok "summary.disclosedFailures names the gated surface" || bad "gated surface not disclosed in summary: $(echo "$SUMMARY" | head -c 400)"
[ "$(echo "$SUMMARY" | jlen disclosedFailures)" -ge 1 ] 2>/dev/null && ok "disclosedFailures is non-empty (never silently dropped)" || bad "disclosedFailures empty"
echo "$SUMMARY" | grep -q '"headline":"Your business appeared in' && ok "honest headline phrasing present" || bad "headline missing/wrong shape: $(echo "$SUMMARY" | jget headline)"
# §8.2: "Include the period and locations." Both, not either.
echo "$SUMMARY" | jget headline | grep -q "in US" && ok "headline carries its location" || bad "headline omits the location: $(echo "$SUMMARY" | jget headline)"
echo "$SUMMARY" | jget headline | grep -qE "checked 20[0-9][0-9]-" && ok "headline carries the date/period it was checked over" || bad "headline omits the period: $(echo "$SUMMARY" | jget headline)"
[ "$(echo "$SUMMARY" | jget methodology.questionSetVersion)" -ge 1 ] 2>/dev/null && ok "methodology records the question-set version" || bad "questionSetVersion missing"
[ "$(echo "$SUMMARY" | jlen methodology.surfaces)" = "2" ] && ok "methodology names every attempted surface (2), not just the successful one" || bad "methodology.surfaces = $(echo "$SUMMARY" | jlen methodology.surfaces)"
# §8.4: the honest words are simpler than the record, never instead of it.
[ "$(echo "$SUMMARY" | jget methodology.samplingConfig.tier)" = "scorecard" ] && ok "methodology records the sampling configuration (tier)" || bad "samplingConfig.tier = $(echo "$SUMMARY" | jget methodology.samplingConfig.tier)"
[ "$(echo "$SUMMARY" | jget methodology.samplingConfig.runCount)" = "5" ] && ok "methodology records the repeat count (n)" || bad "samplingConfig.runCount = $(echo "$SUMMARY" | jget methodology.samplingConfig.runCount)"
[ "$(echo "$SUMMARY" | jget methodology.markets.0)" = "US" ] && ok "methodology records the country measured" || bad "methodology.markets = $(echo "$SUMMARY" | jget methodology.markets)"
echo "$SUMMARY" | grep -q '"accessMode":"browser-automation"' && echo "$SUMMARY" | grep -q '"accessMode":"test-only"' \
  && ok "each surface records its mode of access (api/browser-automation/test-only)" \
  || bad "accessMode not recorded per surface"
echo "$SUMMARY" | grep -q '"failureKind":"no-session"' && ok "the gated surface keeps its typed failure reason in the summary" || bad "failureKind missing from methodology.surfaces"
echo "$SUMMARY" | grep -q '"appeared":' && echo "$SUMMARY" | grep -q '"recommended":' && ok "appeared and recommended are kept as separate keys (never conflated)" || bad "appeared/recommended not both present"

# --- 1b. no ordered claim (§8.2) -------------------------------------------
# "Do not say 'You rank #1 in AI' unless the measurement actually defines and
# supports an ordered position." Nothing in this composition does, so nothing
# in it may claim one.
if echo "$SUMMARY" | grep -qEi '"headline":"[^"]*(rank #?1|#1 in ai|number one in ai|ranked first)'; then
  bad "an ordered position is claimed: $(echo "$SUMMARY" | jget headline)"
else
  ok "no ordered '#1 in AI' claim in the headline"
fi

# --- 2. questions: every question in the set is listed, checked or not -----
Q=$(curl -s "$API/projects/$PID/aeo/visibility/questions?auditId=$AID1&limit=100" "${AUTH[@]}")
[ "$(echo "$Q" | jget querySetVersion)" = "1" ] && ok "questions page stamps the current question-set version (v1)" || bad "questions querySetVersion = $(echo "$Q" | jget querySetVersion)"
TOTAL=$(echo "$Q" | jget pageInfo.total)
[ "$TOTAL" -ge 10 ] 2>/dev/null && ok "questions page reports $TOTAL total questions" || bad "pageInfo.total = $TOTAL"
[ "$(echo "$Q" | jlen items)" = "$TOTAL" ] && ok "the page lists every question in the set ($TOTAL)" || bad "items = $(echo "$Q" | jlen items) vs total $TOTAL"
CHECKED_TRUE=$(echo "$Q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.items.filter(i=>i.checked===true).length))})')
[ "$CHECKED_TRUE" -ge 1 ] 2>/dev/null && ok "$CHECKED_TRUE questions are checked (have stored observations)" || bad "no checked questions found"
# A checked question is a real measurement: it names its attempts and the date
# it was checked, whatever the result was.
echo "$Q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const bad=o.items.some(i=>i.checked===true&&(i.attempts<1||i.checkedAt===null||i.checkedAt===undefined));process.exit(bad?1:0)})' \
  && ok "every checked question states its attempt count and checked date" \
  || bad "a checked question omitted attempts/checkedAt"
# §8.1 question detail: topic, funnel stage, branding and a safe source
# reference are all on the row, and a source is never invented.
echo "$Q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const missing=o.items.some(i=>typeof i.topicLabel!=="string"||typeof i.funnelStage!=="string"||!Object.prototype.hasOwnProperty.call(i,"branding"));process.exit(missing?1:0)})' \
  && ok "every question carries its topic, funnel stage and branding" \
  || bad "a question is missing topic/funnelStage/branding"
SRC=$(echo "$Q" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const results=o.items.flatMap(i=>i.results);if(results.length===0){process.stdout.write("empty");return}const missing=results.some(r=>!Object.prototype.hasOwnProperty.call(r,"sourceUrl"));const invented=results.some(r=>r.cited===false&&r.sourceUrl!==null);process.stdout.write(missing?"missing":(invented?"invented":"ok"))})')
[ "$SRC" = "ok" ] && ok "each observed answer carries a sourceUrl slot, null unless it actually cited something" || bad "source reference shape wrong: $SRC"
# The composed reads must never carry verbatim model output (§8.1's boundary —
# the merged screen does not widen who can read raw answers).
if echo "$Q" | grep -q '"rawAnswer"'; then bad "rawAnswer leaked into the composed question read"; else ok "no rawAnswer in the composed question read"; fi
if echo "$SUMMARY" | grep -q '"rawAnswer"'; then bad "rawAnswer leaked into the composed summary"; else ok "no rawAnswer in the composed summary"; fi
echo "$Q" | grep -q '"topicLabel":"' && ok "questions are grouped by business topic" || bad "topicLabel missing"

# --- 2b. pagination is stable -----------------------------------------------
PAGE1=$(curl -s "$API/projects/$PID/aeo/visibility/questions?auditId=$AID1&limit=5" "${AUTH[@]}")
[ "$(echo "$PAGE1" | jlen items)" = "5" ] && ok "page size respected (5)" || bad "page1 items = $(echo "$PAGE1" | jlen items)"
NEXT=$(echo "$PAGE1" | jget pageInfo.nextCursor)
[ -n "$NEXT" ] && [ "$NEXT" != "__ERR__" ] && ok "nextCursor present for a partial page" || bad "no nextCursor"
PAGE2=$(curl -s "$API/projects/$PID/aeo/visibility/questions?auditId=$AID1&limit=5&cursor=$NEXT" "${AUTH[@]}")
FIRST_ID_P1=$(echo "$PAGE1" | jget items.0.id)
FIRST_ID_P2=$(echo "$PAGE2" | jget items.0.id)
[ "$FIRST_ID_P1" != "$FIRST_ID_P2" ] && ok "cursor pagination advances (no repeated row)" || bad "page 2 repeated page 1's first row"
# Stable: re-reading the same cursor returns the same rows in the same order.
PAGE1_AGAIN=$(curl -s "$API/projects/$PID/aeo/visibility/questions?auditId=$AID1&limit=5" "${AUTH[@]}")
[ "$(echo "$PAGE1_AGAIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.items.map(i=>i.id).join(","))})')" = \
  "$(echo "$PAGE1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.items.map(i=>i.id).join(","))})')" ] \
  && ok "the same cursor returns the same page in the same order (stable pagination)" \
  || bad "pagination is unstable between identical requests"

# --- 2c. topic filter --------------------------------------------------------
TOPIC_FILTERED=$(curl -s "$API/projects/$PID/aeo/visibility/questions?auditId=$AID1&topic=service-discovery" "${AUTH[@]}")
[ "$(echo "$TOPIC_FILTERED" | jget topic)" = "service-discovery" ] && ok "topic filter echoes the requested topic" || bad "topic filter mismatch"
ALL_MATCH=$(echo "$TOPIC_FILTERED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.items.every(i=>i.topic==="service-discovery")))})')
[ "$ALL_MATCH" = "true" ] && ok "every returned question matches the topic filter" || bad "topic filter leaked other topics"

# --- 3. history: no comparability break yet (only one version measured) ----
HIST1=$(curl -s "$API/projects/$PID/aeo/visibility/history" "${AUTH[@]}")
[ "$(echo "$HIST1" | jlen history)" = "1" ] && ok "history has one entry after one audit" || bad "history length = $(echo "$HIST1" | jlen history)"
[ "$(echo "$HIST1" | jget history.0.comparabilityBreak)" = "false" ] && ok "single-entry history has no comparability break" || bad "unexpected comparability break on first entry"
echo "$HIST1" | grep -qi '"surface":"perplexity-browser"' && ok "history entry also discloses the gated surface" || bad "history entry dropped the gated surface"
[ "$(echo "$HIST1" | jget history.0.querySetVersion)" = "1" ] && ok "history entry keeps the question-set version it measured" || bad "history querySetVersion = $(echo "$HIST1" | jget history.0.querySetVersion)"

# --- 4. a NEW question-set version must show as a comparability break ------
# Regenerating the matrix (activate:true) forks a new QuerySet version for the
# same awareness label; a second audit against it must be flagged in history
# as not directly comparable to the first, never silently charted together.
MTX2=$(curl -s -X POST "$API/projects/$PID/aeo/matrix" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"tier":"scorecard","refine":false,"activate":true}')
QS2=$(echo "$MTX2" | jget querySetId)
[ -n "$QS2" ] && [ "$QS2" != "__ERR__" ] && [ "$QS2" != "$QS1" ] && ok "regenerating the matrix produced a new query set ($QS2 != $QS1)" || bad "matrix regen did not fork a new set"

START2=$(curl -s -X POST "$API/projects/$PID/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"surface\":\"mock\",\"tier\":\"scorecard\",\"runCount\":5}")
AID2=$(echo "$START2" | jget id)
AUDIT2=$(curl -s -X POST "$API/projects/$PID/aeo/audits/$AID2/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}')
[ "$(echo "$AUDIT2" | jget status)" = "completed" ] && ok "audit 2 (new question-set version) ran to completion" || bad "audit2 status = $(echo "$AUDIT2" | jget status)"

HIST2=$(curl -s "$API/projects/$PID/aeo/visibility/history" "${AUTH[@]}")
[ "$(echo "$HIST2" | jlen history)" = "2" ] && ok "history now has two entries" || bad "history length after 2nd audit = $(echo "$HIST2" | jlen history)"
[ "$(echo "$HIST2" | jget history.0.auditId)" = "$AID2" ] && ok "history is newest-first (audit 2 on top)" || bad "history ordering wrong"
[ "$(echo "$HIST2" | jget history.0.comparabilityBreak)" = "true" ] && ok "newest history entry (new question-set version) is flagged as a comparability break" || bad "comparability break not flagged: $(echo "$HIST2" | jget history.0.comparabilityBreak)"
echo "$HIST2" | jget history.0.comparabilityNote | grep -qi "not directly comparable" && ok "comparability note states the reason in words" || bad "no stated comparability reason"
# The break must never be applied by editing the historical row: the earlier
# entry keeps its own version and stays unflagged.
[ "$(echo "$HIST2" | jget history.1.comparabilityBreak)" = "false" ] && ok "the earlier (first) entry itself is not flagged (nothing before it to break against)" || bad "first entry wrongly flagged"
[ "$(echo "$HIST2" | jget history.1.querySetVersion)" = "1" ] && ok "the historical entry still reports v1 (no silent rewrite of the past)" || bad "history.1 querySetVersion = $(echo "$HIST2" | jget history.1.querySetVersion)"

# --- 5. a measurement that measured NOTHING still composes honestly --------
# §8.4: "If a question has no observations, show 'Not checked' rather than zero
# appearances." The gated browser surfaces are the one deterministic way to get
# a REAL zero-observation measurement out of this pipeline at zero spend: the
# audit reaches its matrix stage, records the attempt and its typed failure,
# and stores no observations at all.
#
# This is the case that used to break the read: the composed summary called the
# verdict, the verdict refuses to build over no observations, and the summary
# answered 400 — putting an error in front of a client whose honest answer is
# "nothing has been checked". Both reads must now answer 200.
curl -s -X PUT "$API/projects/$PID2/competitors" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"competitors":[{"name":"Profound","domain":"tryprofound.com"}]}' >/dev/null
CONFIRM2=$(seed_market "$PID2")
[ "$(echo "$CONFIRM2" | jget profile.data.targets.0.country)" = "US" ] && ok "second fixture: confirmed a US target market" || bad "second fixture confirm: $(echo "$CONFIRM2" | head -c 200)"
curl -s -X POST "$API/projects/$PID2/aeo/context" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":1,"refine":false}' >/dev/null

ZSTART=$(curl -s -X POST "$API/projects/$PID2/aeo/audits" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"surface":"perplexity-browser","tier":"scorecard","runCount":5}')
ZAID=$(echo "$ZSTART" | jget id)
[ -n "$ZAID" ] && [ "$ZAID" != "__ERR__" ] && ok "started the zero-observation audit (gated engine only)" || { bad "zero-audit start"; echo "$ZSTART" | head -c 300; exit 1; }
# The gated engine produces nothing, so this resume is expected to fail — the
# response body is not asserted, the stored audit row is.
curl -s -X POST "$API/projects/$PID2/aeo/audits/$ZAID/resume" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reuseContext":true,"skipRefine":true,"skipStance":true}' >/dev/null
ZAUDIT=$(curl -s "$API/projects/$PID2/aeo/audits/$ZAID" "${AUTH[@]}")
[ "$(echo "$ZAUDIT" | jget status)" = "failed" ] && ok "a run that produced no answers is stored as failed, not as a silent empty success" || bad "zero-audit status = $(echo "$ZAUDIT" | jget status)"
[ "$(echo "$ZAUDIT" | jget observations)" = "0" ] && ok "the zero-observation fixture really stored 0 observations" || bad "observations = $(echo "$ZAUDIT" | jget observations)"

ZQCODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/$PID2/aeo/visibility/questions?auditId=$ZAID&limit=100" "${AUTH[@]}")
[ "$ZQCODE" = "200" ] && ok "questions read of a zero-observation audit answers 200" || bad "questions read returned HTTP $ZQCODE"
ZQ=$(curl -s "$API/projects/$PID2/aeo/visibility/questions?auditId=$ZAID&limit=100" "${AUTH[@]}")
ZQ_TOTAL=$(echo "$ZQ" | jget pageInfo.total)
[ "$ZQ_TOTAL" -ge 1 ] 2>/dev/null && ok "the question set still lists all $ZQ_TOTAL questions (an unchecked question is listed, never omitted)" || bad "zero-audit pageInfo.total = $ZQ_TOTAL"
[ "$(echo "$ZQ" | jlen items)" = "$ZQ_TOTAL" ] && ok "every one of them is present on the page" || bad "zero-audit items = $(echo "$ZQ" | jlen items)"
# The heart of the case: no fabricated zero. Not-checked questions carry no
# attempts, no appearance count, no recommendation count and no checked date —
# the shape a fabricated "0 appearances out of 5" could not have.
ZQ_SHAPE=$(echo "$ZQ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const notChecked=o.items.filter(i=>i.checked===false);const honest=notChecked.every(i=>i.attempts===0&&i.appearedCount===0&&i.recommendedCount===null&&i.checkedAt===null&&i.results.length===0);const fabricated=o.items.some(i=>i.appearedCount>0);process.stdout.write("total="+o.items.length+" unchecked="+notChecked.length+" honest="+honest+" fabricated="+fabricated)})')
case "$ZQ_SHAPE" in
  *"honest=true"*"fabricated=false"*) ok "every unchecked question reads Not checked (attempts/appearedCount 0, no date, no results) — nothing fabricated: $ZQ_SHAPE";;
  *) bad "unchecked questions not honestly shaped: $ZQ_SHAPE";;
esac
[ "$(echo "$ZQ" | jget items.0.checked)" = "false" ] && ok "a question nothing measured reports checked:false, not a 0-appearance result" || bad "items.0.checked = $(echo "$ZQ" | jget items.0.checked)"

ZSCODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/$PID2/aeo/visibility/summary?auditId=$ZAID" "${AUTH[@]}")
[ "$ZSCODE" = "200" ] && ok "summary of a zero-observation audit answers 200 (it used to 400)" || bad "summary of the zero-observation audit returned HTTP $ZSCODE"
ZS=$(curl -s "$API/projects/$PID2/aeo/visibility/summary?auditId=$ZAID" "${AUTH[@]}")
[ "$(echo "$ZS" | jget questionsChecked)" = "0" ] && ok "summary reports 0 questions checked" || bad "summary.questionsChecked = $(echo "$ZS" | jget questionsChecked)"
[ "$(echo "$ZS" | jget appeared.rateValid)" = "false" ] && ok "the appearance rate is marked invalid, so no 0% is presented as a measurement" || bad "appeared.rateValid = $(echo "$ZS" | jget appeared.rateValid)"
[ "$(echo "$ZS" | jget appeared.of)" = "0" ] && ok "the appearance denominator is 0, not a fabricated sample size" || bad "appeared.of = $(echo "$ZS" | jget appeared.of)"
[ -z "$(echo "$ZS" | jget recommended)" ] && ok "recommended stays absent (never fabricated as 0) when nothing was judged" || bad "recommended = $(echo "$ZS" | jget recommended)"
echo "$ZS" | jget headline | grep -qi "no answers have been checked" && ok "the headline says nothing has been checked rather than quoting a rate" || bad "zero-observation headline: $(echo "$ZS" | jget headline)"
[ "$(echo "$ZS" | jget status)" = "failed" ] && ok "the summary states the measurement's real status (failed)" || bad "summary.status = $(echo "$ZS" | jget status)"
# Denominator truth even when the denominator is empty: the surface that was
# attempted is still named, with its typed failure kind and access mode.
echo "$ZS" | grep -q '"surface":"perplexity-browser"' && ok "the attempted surface is still named in the failure disclosure" || bad "zero-audit disclosedFailures empty"
[ "$(echo "$ZS" | jlen methodology.surfaces)" = "1" ] && ok "methodology still records the attempted surface (nothing dropped for being empty)" || bad "zero-audit methodology.surfaces = $(echo "$ZS" | jlen methodology.surfaces)"
echo "$ZS" | grep -q '"failureKind":"no-session"' && ok "the empty attempt keeps its typed failure reason" || bad "zero-audit failureKind missing"
echo "$ZS" | grep -q '"accessMode":"browser-automation"' && ok "the empty attempt keeps its mode of access on the record" || bad "zero-audit accessMode missing"

# The default (no auditId) read must not hide that failed attempt behind a 404:
# this project has no completed measurement, and the honest answer is the failed
# one — with its engines and locations named — not an empty state.
ZDEFAULT=$(curl -s "$API/projects/$PID2/aeo/visibility/summary" "${AUTH[@]}")
[ "$(echo "$ZDEFAULT" | jget auditId)" = "$ZAID" ] && ok "with nothing completed, the default summary resolves to the failed measurement instead of 404" || bad "default summary.auditId = $(echo "$ZDEFAULT" | jget auditId) (expected $ZAID)"
[ "$(echo "$ZDEFAULT" | jget questionsChecked)" = "0" ] && ok "the default read agrees it checked nothing" || bad "default summary.questionsChecked = $(echo "$ZDEFAULT" | jget questionsChecked)"
ZDQ=$(curl -s "$API/projects/$PID2/aeo/visibility/questions" "${AUTH[@]}")
[ "$(echo "$ZDQ" | jget auditId)" = "$ZAID" ] && ok "the default questions read resolves to the same measurement (one destination, not two)" || bad "default questions.auditId = $(echo "$ZDQ" | jget auditId)"
# History of a never-measured project says so, and sends no 0-of-0 ratio that a
# chart could render as a rate.
ZDHIST=$(curl -s "$API/projects/$PID2/aeo/visibility/history" "${AUTH[@]}")
[ "$(echo "$ZDHIST" | jlen history)" = "1" ] && ok "the failed measurement appears in history" || bad "zero-audit history length = $(echo "$ZDHIST" | jlen history)"
[ "$(echo "$ZDHIST" | jget history.0.questionsChecked)" = "0" ] && ok "history states 0 questions checked" || bad "history.0.questionsChecked = $(echo "$ZDHIST" | jget history.0.questionsChecked)"
[ -z "$(echo "$ZDHIST" | jget history.0.appeared)" ] && ok "history reports no appearance ratio at all for it (null, never 0 of 0)" || bad "history.0.appeared = $(echo "$ZDHIST" | jget history.0.appeared)"
echo "$ZDHIST" | grep -qi '"surface":"perplexity-browser"' && ok "history names the engine that produced nothing" || bad "history dropped the failed surface"

# --- 6. one prompt destination — no duplicate/competing route left live ----
# The merged screen serves summary + customer-questions from the SAME
# prompt-destination pattern (one auditId resolves both), and the retired
# /research/prompts UI route must redirect rather than stay live as a second
# destination.
[ "$(echo "$SUMMARY" | jget auditId)" = "$(echo "$Q" | jget auditId)" ] && ok "summary and questions resolve to the SAME default audit — one prompt destination, not two" || bad "summary/questions disagree on the default audit"

# The web app is not part of this backend harness, so the retired route is
# asserted at the source instead of over HTTP. A probe that SKIPs whenever no
# web dev server happens to be listening on :3000 asserts nothing on most runs;
# this checks the property the exit gate actually names, on every run.
PROMPTS_PAGE="$WEB_ROOT/src/app/(ops)/projects/[projectId]/research/prompts/page.tsx"
if [ -f "$PROMPTS_PAGE" ]; then
  grep -q "redirect(" "$PROMPTS_PAGE" && grep -q "research/ai" "$PROMPTS_PAGE" \
    && ok "the retired /research/prompts route redirects into the merged AI visibility screen" \
    || bad "$PROMPTS_PAGE exists but does not redirect into the merged screen"
else
  bad "the retired prompt-library route no longer exists (a dead deep link, not a redirect)"
fi
# …and the navigation must offer exactly ONE AI-visibility destination, so the
# merge cannot quietly leave a second entry pointing at the retired screen.
NAV="$WEB_ROOT/src/lib/navigation.ts"
if [ -f "$NAV" ]; then
  NAV_AI=$(grep -c "'/research/ai'" "$NAV")
  [ "$NAV_AI" = "1" ] && ok "navigation has exactly one AI-visibility destination ($NAV_AI entry)" || bad "navigation has $NAV_AI entries pointing at /research/ai"
  grep -q "research/ai/sets" "$NAV" && bad "navigation exposes the staff question-set panel as a second destination" || ok "the staff question-set panel is not a second navigation destination"
else
  bad "$NAV not found"
fi

# --- 6b. the merged screen's own affordances (§8.1, §8.2) ------------------
# Copy and wiring are checked at the source because this harness has no browser:
# these are the strings and props the requirements name, not a visual check.
AI_PAGE="$WEB_ROOT/src/app/(ops)/projects/[projectId]/research/ai/page.tsx"
AI_NEW="$WEB_ROOT/src/app/(ops)/projects/[projectId]/research/ai/new/page.tsx"
if [ -f "$AI_PAGE" ]; then
  for view in summary questions history; do
    grep -q "TabsTrigger value=\"$view\"" "$AI_PAGE" && ok "the merged screen has its '$view' view" || bad "merged screen has no '$view' view"
  done
  grep -q "research/competitors" "$AI_PAGE" && grep -q "Compare with competitors" "$AI_PAGE" \
    && ok "one contextual 'Compare with competitors' link carries the topic/market/period into Competitors (§8.3)" \
    || bad "no contextual competitor link on the merged screen"
else
  bad "$AI_PAGE not found"
fi
if [ -f "$AI_NEW" ]; then
  grep -q 'startLabel="Update AI results"' "$AI_NEW" && ok "the staff run button is labelled 'Update AI results' (§8.2)" || bad "run button is not labelled 'Update AI results'"
  grep -q "beforeStart=" "$AI_NEW" && grep -q "ConfirmDialog" "$AI_NEW" \
    && ok "starting a check is confirmed before it spends (§8.2)" \
    || bad "the run is issued without a confirmation step"
  grep -q "Allowance:" "$AI_NEW" && ok "the confirmation states the run's allowed cost, not only its price" || bad "the confirmation omits the allowance"
else
  bad "$AI_NEW not found"
fi

echo
echo "ai-visibility-unified smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

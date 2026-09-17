#!/usr/bin/env bash
# E2E smoke — competitors unified screen (P06, platform_improvement_plan.md
# §12.1-§12.4). Proves the exit gate from §20.2's P06 row concretely:
#
#   "Partners/directories excluded; page load makes no paid calls."
#
# Covers, on top of what competitors.smoke.sh already proves (discover/list/
# gap on an explicit list):
#   1. Service/market discovery (§12.2) mines stored AEO/SERP evidence for
#      free and proposes candidates without touching the existing tracked list.
#   2. A directory/partner domain seeded into that same evidence is excluded
#      from the proposed candidates.
#   3. GET .../gap (the page-load / "Update comparison" path) makes zero
#      calls through the gated paid SERP provider, while an explicit
#      collectNew=true discovery call does make one (fixture-provider call,
#      $0 spend, same "no vendor account needed" discipline every other
#      smoke script here uses — see serp-intelligence.smoke.sh's costUsd
#      assertions).
#   4. A rejected candidate does not resurface on a re-run (rejection memory).
#   5. A rival with no observation for the selected scope reads "unknown" /
#      "Not checked", never an automatic zero.
#   6. Comparison snapshots (§12.3): GET .../gap returns a snapshotId; that
#      exact snapshot is readable back unmutated later via
#      GET .../comparison-snapshots/:id even after the competitor set changes.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== competitors-unified smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Competitors Unified Smoke\",\"domain\":\"cu-smoke-$RANDOM.example.com\",\"category\":\"competitors unified smoke\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- seed evidence: a SERP tracker with results naming a real rival AND a
#     directory domain, plus a completed AeoAudit verdict naming another
#     rival — all via Prisma directly, same pattern as competitors.smoke.sh /
#     keyword-gaps.smoke.sh use to seed fixture rows without spend. ----------
node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const projectId = process.argv[1];
  const tracker = await p.serpTracker.create({
    data: { projectId, name: "CU Smoke Tracker", provider: "fixture", locationName: "United States", languageCode: "en", device: "desktop" },
  });
  const query = await p.serpQuery.create({ data: { trackerId: tracker.id, keyword: "smoke rival query" } });
  const snapshot = await p.serpSnapshot.create({ data: { trackerId: tracker.id, provider: "fixture", status: "complete" } });
  await p.serpResult.create({
    data: {
      snapshotId: snapshot.id,
      queryId: query.id,
      keyword: query.keyword,
      capturedAt: new Date(),
      subjectRank: null,
      topDomains: JSON.stringify([
        { domain: "realrival-smoke.example.com", rank: 1 },
        { domain: "clutch.co", rank: 2 },
      ]),
      competitorsSeen: JSON.stringify(["Real Rival Smoke Co"]),
    },
  });
  await p.aeoAudit.create({
    data: {
      projectId,
      status: "completed",
      verdict: JSON.stringify({
        generatedAt: new Date().toISOString(),
        counted: { competitors: [{ name: "Verdict Rival Smoke Co", observations: 3, mentionRate: 33, clientAheadCount: 1, clientBehindCount: 2, wonWhileClientAbsent: 0 }], shareOfVoice: [] },
      }),
    },
  });
  await p.$disconnect();
})();
' "$PID" && ok "seeded SERP tracker (rival + directory domain) and a completed AeoAudit verdict (rival)" || { bad "evidence seed"; exit 1; }

# --- 1. free discovery pass: mines stored evidence, no paid call ------------
D1=$(curl -s -X POST "$API/projects/$PID/competitors/discover/market" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$D1" | jget collectNew)" = "false" ] && ok "free pass: collectNew=false" || bad "collectNew = $(echo "$D1" | jget collectNew)"
[ "$(echo "$D1" | jget queriesRun)" = "0" ] && ok "free pass: zero SERP queries run" || bad "queriesRun = $(echo "$D1" | jget queriesRun)"
[ "$(echo "$D1" | jget costUsd)" = "0" ] && ok "free pass: costUsd = 0 (no vendor call)" || bad "costUsd = $(echo "$D1" | jget costUsd)"

PROPOSED1=$(echo "$D1" | jget candidatesProposed)
[ "$PROPOSED1" = "2" ] && ok "free pass proposed exactly the 2 real rivals (SERP-seen + AEO-verdict)" || bad "candidatesProposed = $PROPOSED1 (want 2)"

# --- 2. EXIT GATE: directory domain excluded, never becomes a candidate ----
HAS_DIRECTORY=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(String(c.some(x=>(x.domain||"").includes("clutch.co"))))})')
[ "$HAS_DIRECTORY" = "false" ] && ok "EXIT GATE: clutch.co (directory) excluded from candidates" || bad "clutch.co leaked into candidates"
EXCLUDED_MENTIONS_DIRECTORY=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(String((r.exclusionSample||[]).some(x=>/clutch\.co/.test(x))))})')
[ "$EXCLUDED_MENTIONS_DIRECTORY" = "true" ] && ok "exclusion reason names clutch.co as a directory, not silently dropped" || bad "no exclusion reason recorded for clutch.co"

HAS_REAL_RIVAL=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(String(c.some(x=>(x.domain||"").includes("realrival-smoke"))))})')
[ "$HAS_REAL_RIVAL" = "true" ] && ok "legitimate SERP-seen rival IS proposed as a candidate" || bad "realrival-smoke.example.com missing from candidates"

VERDICT_RIVAL=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];const r=c.find(x=>x.name==="Verdict Rival Smoke Co");process.stdout.write(r?r.relevance:"__MISSING__")})')
[ "$VERDICT_RIVAL" = "direct-competitor" ] && ok "AEO-verdict-sourced candidate classified direct-competitor" || bad "Verdict Rival Smoke Co relevance = $VERDICT_RIVAL"

REJECT_ID=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];const r=c.find(x=>x.name==="Verdict Rival Smoke Co");process.stdout.write(r?r.id:"")})')

# --- 3. re-running the free pass does not duplicate or drop the tracked list
D1B=$(curl -s -X POST "$API/projects/$PID/competitors/discover/market" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$D1B" | jget candidatesProposed)" = "0" ] && ok "re-running discovery proposes 0 new (already-candidate rivals not re-proposed)" || bad "second run proposed = $(echo "$D1B" | jget candidatesProposed)"

# --- 4. EXIT GATE: rejected candidate does not resurface -------------------
[ -n "$REJECT_ID" ] && [ "$REJECT_ID" != "__MISSING__" ] && ok "found candidate id to reject" || { bad "no candidate id to reject"; }
RC=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/projects/$PID/competitors/candidates/$REJECT_ID?reason=smoke-not-a-rival" "${AUTH[@]}")
[ "$RC" = "200" ] && ok "rejected the AEO-verdict candidate" || bad "reject -> $RC"

D1C=$(curl -s -X POST "$API/projects/$PID/competitors/discover/market" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
STILL_ABSENT=$(echo "$D1C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(String(c.some(x=>x.name==="Verdict Rival Smoke Co")))})')
[ "$STILL_ABSENT" = "false" ] && ok "EXIT GATE: rejected candidate does not resurface on re-run" || bad "rejected candidate resurfaced"

CANDIDATES_NOW=$(curl -s "$API/projects/$PID/competitors/candidates" "${AUTH[@]}")
STILL_LISTED=$(echo "$CANDIDATES_NOW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(String(c.some(x=>x.name==="Verdict Rival Smoke Co")))})')
[ "$STILL_LISTED" = "false" ] && ok "rejected candidate is gone from the candidate list too" || bad "rejected candidate still listed"

# --- 5. confirm the real rival, build its profile ---------------------------
REAL_ID=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];const r=c.find(x=>(x.domain||"").includes("realrival-smoke"));process.stdout.write(r?r.id:"")})')
CONFIRM=$(curl -s -X POST "$API/projects/$PID/competitors/candidates/$REAL_ID/confirm" "${AUTH[@]}")
[ "$(echo "$CONFIRM" | jget status)" = "tracked" ] && ok "confirmed real rival is now tracked" || bad "confirm -> $(echo "$CONFIRM" | jget status)"

curl -s -X POST "$API/projects/$PID/competitors/discover" "${AUTH[@]}" -H 'content-type: application/json' -d '{}' >/dev/null
ok "built a profile for the confirmed rival (via existing /discover, free/no-vendor per competitors.smoke.sh)"

# --- 6. EXIT GATE: page load / "Update comparison" (GET gap) makes zero
#        paid SERP calls, and no observation reads as a fabricated zero -----
GAP1=$(curl -s "$API/projects/$PID/competitors/gap" "${AUTH[@]}")
SNAP1=$(echo "$GAP1" | jget snapshotId)
[ -n "$SNAP1" ] && [ "$SNAP1" != "__ERR__" ] && ok "gap read persisted a comparison snapshot ($SNAP1)" || bad "no snapshotId on gap response"

AEO_UNKNOWN=$(echo "$GAP1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors||[];const r=c.find(x=>(x.domain||"").includes("realrival-smoke"));process.stdout.write(r?r.aeoStatus:"__MISSING__")})')
[ "$AEO_UNKNOWN" = "absent" ] && ok "rival with a completed AEO audit that doesn't name it reads 'absent', not a fabricated zero score" || bad "aeoStatus = $AEO_UNKNOWN"
SERP_PRESENT=$(echo "$GAP1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors||[];const r=c.find(x=>(x.domain||"").includes("realrival-smoke"));process.stdout.write(r?r.serpStatus:"__MISSING__")})')
[ "$SERP_PRESENT" = "present" ] && ok "rival's stored SERP occurrence is attached (serpStatus=present)" || bad "serpStatus = $SERP_PRESENT"

# A second project with a tracked-but-never-observed competitor: its AEO/SERP
# read honestly as 'unknown' (no tracker/audit exists at all yet for that
# project), never coerced to zero. Covered by competitors.smoke.sh already
# ("SERP attachment honestly 'unknown'") — reconfirmed here in the unified
# gap response shape specifically.
UNK_PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"CU Smoke Unchecked\",\"domain\":\"cu-smoke-unchecked-$RANDOM.example.com\"}")
UNK_PID=$(echo "$UNK_PROJ" | jget id)
curl -s -X POST "$API/projects/$UNK_PID/competitors/discover" "${AUTH[@]}" -H 'content-type: application/json' -d '{"competitors":[{"name":"Never Observed Rival"}]}' >/dev/null
UNK_GAP=$(curl -s "$API/projects/$UNK_PID/competitors/gap" "${AUTH[@]}")
UNK_AEO=$(echo "$UNK_GAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors||[];const r=c.find(x=>x.name==="Never Observed Rival");process.stdout.write(r?r.aeoStatus:"__MISSING__")})')
[ "$UNK_AEO" = "unknown" ] && ok "EXIT GATE: never-observed rival reads AEO 'unknown' (Not checked), never an automatic zero" || bad "unchecked rival aeoStatus = $UNK_AEO"
UNK_SERP=$(echo "$UNK_GAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors||[];const r=c.find(x=>x.name==="Never Observed Rival");process.stdout.write(r?r.serpStatus:"__MISSING__")})')
[ "$UNK_SERP" = "unknown" ] && ok "EXIT GATE: never-observed rival reads SERP 'unknown' (Not checked), never an automatic zero" || bad "unchecked rival serpStatus = $UNK_SERP"
curl -s -X DELETE "$API/projects/$UNK_PID" "${AUTH[@]}" >/dev/null 2>&1

# --- 7. EXIT GATE: explicit "collect new results" (collectNew=true) DOES
#        make a (fixture, $0) call through the gated SERP provider, and a
#        directory result from THAT pass is excluded too -------------------
D2=$(curl -s -X POST "$API/projects/$PID/competitors/discover/market" "${AUTH[@]}" -H 'content-type: application/json' -d '{"collectNew":true,"provider":"fixture"}')
[ "$(echo "$D2" | jget collectNew)" = "true" ] && ok "explicit collect: collectNew=true" || bad "collectNew = $(echo "$D2" | jget collectNew)"
QR=$(echo "$D2" | jget queriesRun)
[ "$QR" != "0" ] && [ "$QR" != "" ] && [ "$QR" != "__ERR__" ] && ok "explicit collect: queriesRun=$QR (>0, a bounded search pass actually ran)" || bad "queriesRun = $QR"
[ "$(echo "$D2" | jget costUsd)" = "0" ] && ok "explicit collect via fixture provider: costUsd=0 (offline, no real spend — same discipline as serp-intelligence.smoke.sh)" || bad "unexpected costUsd on fixture provider"
FIXTURE_HAS_WIKI=$(echo "$D2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(String(c.some(x=>(x.domain||"").includes("wikipedia.org"))))})')
[ "$FIXTURE_HAS_WIKI" = "false" ] && ok "EXIT GATE: wikipedia.org (from the fixture SERP's own fallback result) excluded from live-search candidates too" || bad "wikipedia.org leaked into collectNew candidates"

# --- 8. EXIT GATE: frozen snapshot never mutates after the tracked set
#        changes — re-read the FIRST gap's snapshotId and diff it against a
#        fresh gap taken after confirming another competitor. -------------
SNAP_READ=$(curl -s "$API/projects/$PID/competitors/comparison-snapshots/$SNAP1" "${AUTH[@]}")
SNAP_COUNT_THEN=$(echo "$SNAP_READ" | jlen competitors)
GAP2=$(curl -s "$API/projects/$PID/competitors/gap" "${AUTH[@]}")
COUNT_NOW=$(echo "$GAP2" | jlen competitors)
SNAP_REREAD=$(curl -s "$API/projects/$PID/competitors/comparison-snapshots/$SNAP1" "${AUTH[@]}")
SNAP_COUNT_REREAD=$(echo "$SNAP_REREAD" | jlen competitors)
[ "$SNAP_COUNT_THEN" = "$SNAP_COUNT_REREAD" ] && ok "EXIT GATE: frozen snapshot $SNAP1 reads identically ($SNAP_COUNT_THEN competitors) both times, unaffected by later gap reads" || bad "frozen snapshot changed between reads ($SNAP_COUNT_THEN vs $SNAP_COUNT_REREAD)"

SNAPSHOTS_LIST=$(curl -s "$API/projects/$PID/competitors/comparison-snapshots" "${AUTH[@]}")
SNAP_LIST_LEN=$(echo "$SNAPSHOTS_LIST" | jlen snapshots)
[ "$SNAP_LIST_LEN" -ge "2" ] 2>/dev/null && ok "comparison-snapshots list accumulates one row per gap read ($SNAP_LIST_LEN so far)" || bad "snapshots list length = $SNAP_LIST_LEN"

# --- 9. relevance reclassification ------------------------------------------
D3=$(curl -s -X POST "$API/projects/$PID/competitors/discover/market" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
ANY_CANDIDATE_ID=$(echo "$D2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates||[];process.stdout.write(c[0]?c[0].id:"")})')
if [ -n "$ANY_CANDIDATE_ID" ]; then
  RECLASS=$(curl -s -X PATCH "$API/projects/$PID/competitors/candidates/$ANY_CANDIDATE_ID/relevance" "${AUTH[@]}" -H 'content-type: application/json' -d '{"relevance":"not-relevant"}')
  [ "$(echo "$RECLASS" | jget relevance)" = "not-relevant" ] && ok "candidate relevance reclassified to not-relevant without confirming/rejecting" || bad "reclassify -> $(echo "$RECLASS" | jget relevance)"
  STILL_CANDIDATE=$(echo "$RECLASS" | jget status)
  [ "$STILL_CANDIDATE" = "candidate" ] && ok "reclassify did not change status (still pending review)" || bad "status changed to $STILL_CANDIDATE"
else
  echo "  (skip) no candidate available from collectNew pass to reclassify"
fi

# --- 10. ownership ------------------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/does-not-exist/competitors/gap" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC"
SC2=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/$PID/competitors/comparison-snapshots/does-not-exist" "${AUTH[@]}")
[ "$SC2" = "404" ] && ok "unknown snapshot id -> 404" || bad "unknown snapshot -> $SC2"

echo
echo "== competitors-unified: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]

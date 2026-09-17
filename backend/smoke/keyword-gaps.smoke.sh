#!/usr/bin/env bash
# E2E smoke — P07 keyword-gap engine + canonical Opportunity records
# (platform_improvement_plan.md §12.5-§12.7). No vendor account needed: SERP
# rows, a KeywordSet, and a confirmed Competitor are seeded directly via
# Prisma (the same seed-then-hit-real-HTTP-surface convention
# competitors.smoke.sh and portal-plan.smoke.sh use), then the real
# /opportunities/analyze, /opportunities, /dismiss, /reopen, /convert HTTP
# endpoints are exercised.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== keyword-gaps (P07 opportunities) smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

STAMP="kwgap-$(date +%s)-$RANDOM"

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Keyword Gaps Smoke\",\"domain\":\"$STAMP.example.com\",\"category\":\"keyword-gaps smoke\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || die "project create" "$PROJ"

cleanup() {
  node -e "
const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  await p.growthAsset.deleteMany({where:{projectId:process.argv[1]}});
  await p.opportunity.deleteMany({where:{projectId:process.argv[1]}});
  await p.keyword.deleteMany({where:{set:{projectId:process.argv[1]}}});
  await p.keywordSet.deleteMany({where:{projectId:process.argv[1]}});
  const trackers = await p.serpTracker.findMany({where:{projectId:process.argv[1]},select:{id:true}});
  const trackerIds = trackers.map(t=>t.id);
  const snapshots = await p.serpSnapshot.findMany({where:{trackerId:{in:trackerIds}},select:{id:true}});
  await p.serpResult.deleteMany({where:{snapshotId:{in:snapshots.map(s=>s.id)}}});
  await p.serpSnapshot.deleteMany({where:{trackerId:{in:trackerIds}}});
  await p.serpQuery.deleteMany({where:{trackerId:{in:trackerIds}}});
  await p.serpTracker.deleteMany({where:{projectId:process.argv[1]}});
  await p.competitor.deleteMany({where:{projectId:process.argv[1]}});
})().then(()=>p.\$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
" "$PID"
  curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1
  echo "(smoke project + fixture rows deleted)"
}
trap cleanup EXIT

# ── Seed: one confirmed competitor, one SERP tracker with three queries
#    (absent-gap, below-margin-gap, failed-capture), one KeywordSet/Keyword
#    for the topic-suggestion pass. ------------------------------------------
SEED=$(node -e "
const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  const stamp = process.argv[1];
  const pid = process.argv[2];
  const competitor = await p.competitor.create({data:{
    projectId: pid, name: 'Rival Smoke Co', domain: 'rival-smoke-'+stamp+'.example', source:'manual', status:'tracked',
  }});
  const tracker = await p.serpTracker.create({data:{
    projectId: pid, name: 'Smoke tracker', locationName: 'United States', languageCode: 'en', device: 'desktop', provider: 'fixture', status: 'active',
  }});
  const kwAbsent = 'absent gap keyword ' + stamp;
  const kwBelow = 'below gap keyword ' + stamp;
  const kwUnknown = 'unknown capture keyword ' + stamp;
  const qAbsent = await p.serpQuery.create({data:{trackerId: tracker.id, keyword: kwAbsent}});
  const qBelow = await p.serpQuery.create({data:{trackerId: tracker.id, keyword: kwBelow}});
  const qUnknown = await p.serpQuery.create({data:{trackerId: tracker.id, keyword: kwUnknown}});
  const snapOk = await p.serpSnapshot.create({data:{trackerId: tracker.id, provider:'fixture', status:'complete', queriesRun: 2}});
  const snapFailed = await p.serpSnapshot.create({data:{trackerId: tracker.id, provider:'fixture', status:'failed', queriesRun: 0, error: 'smoke: simulated capture failure'}});
  const topDomains = JSON.stringify([{domain: competitor.domain, rank: 3}]);
  const topDomainsBelow = JSON.stringify([{domain: competitor.domain, rank: 2}]);
  const seen = JSON.stringify(['Rival Smoke Co']);
  await p.serpResult.create({data:{
    snapshotId: snapOk.id, queryId: qAbsent.id, keyword: kwAbsent, subjectRank: null,
    topDomains, competitorsSeen: seen,
  }});
  await p.serpResult.create({data:{
    snapshotId: snapOk.id, queryId: qBelow.id, keyword: kwBelow, subjectRank: 15,
    topDomains: topDomainsBelow, competitorsSeen: seen,
  }});
  await p.serpResult.create({data:{
    snapshotId: snapFailed.id, queryId: qUnknown.id, keyword: kwUnknown, subjectRank: null,
    topDomains: JSON.stringify([{domain: competitor.domain, rank: 4}]), competitorsSeen: seen,
  }});
  const kwTopic = 'topic suggestion keyword ' + stamp;
  const set = await p.keywordSet.create({data:{
    projectId: pid, seedInput: JSON.stringify([kwTopic]), locationName: 'United States', languageCode: 'en',
    status: 'completed', finishedAt: new Date(),
  }});
  await p.keyword.create({data:{
    setId: set.id, keyword: kwTopic, searchVolume: 480, cpc: 1.25, competition: 'LOW', competitionIndex: 20,
  }});
  console.log(JSON.stringify({competitorId: competitor.id, kwAbsent, kwBelow, kwUnknown, kwTopic}));
})().then(()=>p.\$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
" "$STAMP" "$PID") || die "seed failed" "$SEED"

KW_ABSENT=$(echo "$SEED" | jget kwAbsent)
KW_BELOW=$(echo "$SEED" | jget kwBelow)
KW_UNKNOWN=$(echo "$SEED" | jget kwUnknown)
KW_TOPIC=$(echo "$SEED" | jget kwTopic)
[ -n "$KW_ABSENT" ] && ok "seeded competitor, SERP tracker (3 queries), keyword-research set" || die "seed" "$SEED"

# ── 1. Run analysis (first pass) ---------------------------------------------
A1=$(curl -s -X POST "$API/projects/$PID/opportunities/analyze" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$A1" | jget created)" = "4" ] && ok "first analyze: 4 opportunities created (absent/below/unknown/topic-suggestion)" || bad "created = $(echo "$A1" | jget created) — $A1"
[ "$(echo "$A1" | jget serpQueriesConsidered)" = "3" ] && ok "3 tracked SERP queries considered" || bad "serpQueriesConsidered = $(echo "$A1" | jget serpQueriesConsidered)"

LIST=$(curl -s "$API/projects/$PID/opportunities?pageSize=50" "${AUTH[@]}")
[ "$(echo "$LIST" | jget total)" = "4" ] && ok "list shows 4 opportunities total" || bad "list total = $(echo "$LIST" | jget total)"

find_by_topic() {
  echo "$LIST" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const rows=JSON.parse(s).opportunities;
  const row=rows.find(r=>r.topicDisplay===process.argv[1]);
  process.stdout.write(row?JSON.stringify(row):'__MISSING__');
})" "$1"
}

ABSENT=$(find_by_topic "$KW_ABSENT")
[ "$ABSENT" != "__MISSING__" ] && ok "absent-gap opportunity exists" || die "absent-gap opportunity missing" "$LIST"
[ "$(echo "$ABSENT" | jget evidenceSourceFamily)" = "serp-keyword-gap-absent" ] && ok "absent-gap: correct evidenceSourceFamily" || bad "absent-gap family = $(echo "$ABSENT" | jget evidenceSourceFamily)"
[ "$(echo "$ABSENT" | jget clientPositionStatus)" = "not-observed" ] && ok "absent-gap: clientPositionStatus = not-observed (checked, absent)" || bad "clientPositionStatus = $(echo "$ABSENT" | jget clientPositionStatus)"
[ "$(echo "$ABSENT" | jget rivalPosition)" = "3" ] && ok "absent-gap: rivalPosition = 3, preserved" || bad "rivalPosition = $(echo "$ABSENT" | jget rivalPosition)"
[ "$(echo "$ABSENT" | jget demandVolume)" = "" ] && ok "absent-gap: demandVolume unavailable (null), never coerced to 0 (no keyword-research match)" || bad "demandVolume = $(echo "$ABSENT" | jget demandVolume)"
EV_QUERY=$(echo "$ABSENT" | jget evidence.0.query)
[ "$EV_QUERY" = "$KW_ABSENT" ] && ok "absent-gap: evidence preserves exact query" || bad "evidence.0.query = $EV_QUERY"
[ "$(echo "$ABSENT" | jget evidence.0.checkedDepth)" = "1" ] && ok "absent-gap: evidence preserves checked depth" || bad "checkedDepth = $(echo "$ABSENT" | jget evidence.0.checkedDepth)"
[ "$(echo "$ABSENT" | jget evidence.0.device)" = "desktop" ] && ok "absent-gap: evidence preserves device" || bad "device = $(echo "$ABSENT" | jget evidence.0.device)"

BELOW=$(find_by_topic "$KW_BELOW")
[ "$BELOW" != "__MISSING__" ] && ok "below-margin-gap opportunity exists" || die "below-margin opportunity missing" "$LIST"
[ "$(echo "$BELOW" | jget evidenceSourceFamily)" = "serp-keyword-gap-below" ] && ok "below-gap: correct evidenceSourceFamily" || bad "below-gap family = $(echo "$BELOW" | jget evidenceSourceFamily)"
[ "$(echo "$BELOW" | jget clientPositionStatus)" = "ranked" ] && ok "below-gap: clientPositionStatus = ranked" || bad "clientPositionStatus = $(echo "$BELOW" | jget clientPositionStatus)"
[ "$(echo "$BELOW" | jget clientPosition)" = "15" ] && ok "below-gap: clientPosition = 15" || bad "clientPosition = $(echo "$BELOW" | jget clientPosition)"
[ "$(echo "$BELOW" | jget rivalPosition)" = "2" ] && ok "below-gap: rivalPosition = 2" || bad "rivalPosition = $(echo "$BELOW" | jget rivalPosition)"

# Exit gate: a null/failed-capture rank reads `unknown`, never coerced to zero or "not ranking".
UNKNOWN=$(find_by_topic "$KW_UNKNOWN")
[ "$UNKNOWN" != "__MISSING__" ] && ok "failed-capture opportunity exists (surfaced, not silently dropped)" || die "failed-capture opportunity missing" "$LIST"
[ "$(echo "$UNKNOWN" | jget clientPositionStatus)" = "unknown" ] && ok "EXIT GATE: failed capture -> clientPositionStatus = 'unknown', not 'not-observed'/zero" || bad "clientPositionStatus = $(echo "$UNKNOWN" | jget clientPositionStatus)"
[ "$(echo "$UNKNOWN" | jget clientPosition)" = "" ] && ok "EXIT GATE: failed capture -> clientPosition null, never coerced to 0" || bad "clientPosition = $(echo "$UNKNOWN" | jget clientPosition)"
[ "$(echo "$UNKNOWN" | jget evidenceSourceFamily)" = "serp-keyword-gap-unknown" ] && ok "failed-capture: distinct evidenceSourceFamily (never mislabeled as a confirmed gap)" || bad "family = $(echo "$UNKNOWN" | jget evidenceSourceFamily)"

TOPIC=$(find_by_topic "$KW_TOPIC")
[ "$TOPIC" != "__MISSING__" ] && ok "topic-suggestion opportunity exists" || die "topic-suggestion opportunity missing" "$LIST"
[ "$(echo "$TOPIC" | jget evidenceSourceFamily)" = "keyword-research-topic-suggestion" ] && ok "topic-suggestion: labeled as a topic suggestion, not a verified ranking gap" || bad "family = $(echo "$TOPIC" | jget evidenceSourceFamily)"
[ "$(echo "$TOPIC" | jget demandVolume)" = "480" ] && ok "topic-suggestion: real demand volume attached (480)" || bad "demandVolume = $(echo "$TOPIC" | jget demandVolume)"
[ "$(echo "$TOPIC" | jget demandCpc)" = "1.25" ] && ok "topic-suggestion: real CPC attached (1.25)" || bad "demandCpc = $(echo "$TOPIC" | jget demandCpc)"

# ── 2. Re-run analysis with UNCHANGED evidence: same rows update, no duplicates ──
A2=$(curl -s -X POST "$API/projects/$PID/opportunities/analyze" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$A2" | jget created)" = "0" ] && ok "second analyze: 0 created (no duplicates)" || bad "second-run created = $(echo "$A2" | jget created)"
[ "$(echo "$A2" | jget updated)" = "4" ] && ok "second analyze: all 4 existing rows updated in place" || bad "second-run updated = $(echo "$A2" | jget updated)"
LIST2=$(curl -s "$API/projects/$PID/opportunities?pageSize=50" "${AUTH[@]}")
[ "$(echo "$LIST2" | jget total)" = "4" ] && ok "EXIT GATE: repeated analysis does not duplicate ideas (still 4 total)" || bad "list total after re-run = $(echo "$LIST2" | jget total)"
ABSENT2=$(echo "$LIST2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).opportunities.find(x=>x.topicDisplay===process.argv[1]);process.stdout.write(r?JSON.stringify(r):'__MISSING__')})" "$KW_ABSENT")
[ "$(echo "$ABSENT" | jget id)" = "$(echo "$ABSENT2" | jget id)" ] && ok "same opportunity row id across two analysis runs (same identity, updated not recreated)" || bad "row id changed: $(echo "$ABSENT" | jget id) -> $(echo "$ABSENT2" | jget id)"
[ "$(echo "$ABSENT2" | jlen evidence)" = "2" ] && ok "evidence array grew to 2 records (reinforced, not replaced)" || bad "absent-gap evidence length = $(echo "$ABSENT2" | jlen evidence)"

# ── 3. Dismiss with a reason, then re-run analysis with unchanged evidence:
#      must stay dismissed (never silently reopened). -----------------------
BELOW_ID=$(echo "$BELOW" | jget id)
DISMISS=$(curl -s -X PATCH "$API/projects/$PID/opportunities/$BELOW_ID/dismiss" "${AUTH[@]}" -H 'content-type: application/json' -d '{"reason":"Already covered by an existing landing page."}')
[ "$(echo "$DISMISS" | jget status)" = "dismissed" ] && ok "dismiss: status = dismissed" || bad "dismiss status = $(echo "$DISMISS" | jget status)"
[ -n "$(echo "$DISMISS" | jget dismissedReason)" ] && ok "dismiss: reason recorded" || bad "no dismissedReason recorded"

A3=$(curl -s -X POST "$API/projects/$PID/opportunities/analyze" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
BELOW3=$(curl -s "$API/projects/$PID/opportunities/$BELOW_ID" "${AUTH[@]}")
[ "$(echo "$BELOW3" | jget status)" = "dismissed" ] && ok "EXIT GATE: dismissed opportunity stays dismissed after re-analysis with unchanged evidence" || bad "status after re-run = $(echo "$BELOW3" | jget status)"
[ "$(echo "$BELOW3" | jget dismissedReason)" = "Already covered by an existing landing page." ] && ok "dismissal reason preserved across re-run" || bad "dismissedReason = $(echo "$BELOW3" | jget dismissedReason)"

# Reopen requires its own new reason, and is the only thing that can undo a dismissal.
REOPEN=$(curl -s -X PATCH "$API/projects/$PID/opportunities/$BELOW_ID/reopen" "${AUTH[@]}" -H 'content-type: application/json' -d '{"reason":"Landing page was retired; gap is real again."}')
[ "$(echo "$REOPEN" | jget status)" = "new" ] && ok "explicit reopen with a new reason works" || bad "reopen status = $(echo "$REOPEN" | jget status)"

# ── 4. Convert to content — idempotent, never duplicates -------------------
ABSENT_ID=$(echo "$ABSENT" | jget id)
KEY1="smoke-convert-key-$STAMP-1"
C1=$(curl -s -X POST "$API/projects/$PID/opportunities/$ABSENT_ID/convert" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"idempotencyKey\":\"$KEY1\"}")
[ "$(echo "$C1" | jget created)" = "true" ] && ok "convert: first call creates a new asset" || bad "first convert created=$(echo "$C1" | jget created) — $C1"
ASSET_ID_1=$(echo "$C1" | jget asset.id)
[ -n "$ASSET_ID_1" ] && [ "$ASSET_ID_1" != "__ERR__" ] && ok "convert: asset id returned" || bad "no asset id — $C1"
[ "$(echo "$C1" | jget opportunity.status)" = "converted" ] && ok "convert: source opportunity marked converted (preserved, not deleted)" || bad "opportunity.status = $(echo "$C1" | jget opportunity.status)"
[ "$(echo "$C1" | jget opportunity.linkedGrowthAssetId)" = "$ASSET_ID_1" ] && ok "convert: opportunity links to the created asset" || bad "linkedGrowthAssetId mismatch"

# Retry with the SAME idempotency key -> must return the SAME asset, not a new one.
C2=$(curl -s -X POST "$API/projects/$PID/opportunities/$ABSENT_ID/convert" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"idempotencyKey\":\"$KEY1\"}")
ASSET_ID_2=$(echo "$C2" | jget asset.id)
[ "$ASSET_ID_2" = "$ASSET_ID_1" ] && ok "EXIT GATE: retry with same idempotency key returns the SAME asset" || bad "retry returned a different asset: $ASSET_ID_1 vs $ASSET_ID_2"

# Retry with a DIFFERENT idempotency key on an already-linked opportunity -> still the same asset (no duplicate).
KEY2="smoke-convert-key-$STAMP-2"
C3=$(curl -s -X POST "$API/projects/$PID/opportunities/$ABSENT_ID/convert" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"idempotencyKey\":\"$KEY2\"}")
ASSET_ID_3=$(echo "$C3" | jget asset.id)
[ "$ASSET_ID_3" = "$ASSET_ID_1" ] && ok "EXIT GATE: different idempotency key on an already-linked opportunity still returns the existing draft, no duplicate" || bad "third convert created a different asset: $ASSET_ID_3"
[ "$(echo "$C3" | jget created)" = "false" ] && ok "third convert: created=false (existing draft reused)" || bad "third convert created=$(echo "$C3" | jget created)"

ASSET_COUNT=$(node -e "
const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();
p.growthAsset.count({where:{projectId:process.argv[1], sourceOpportunityId:process.argv[2]}}).then(n=>{console.log(n);}).finally(()=>p.\$disconnect());
" "$PID" "$ABSENT_ID")
[ "$ASSET_COUNT" = "1" ] && ok "EXIT GATE: exactly one GrowthAsset row exists for this opportunity across three convert calls" || bad "GrowthAsset count for opportunity = $ASSET_COUNT"

# ── 5. Manual keyword lookup endpoint exists and reuses keyword-research's
#      cost gate (no live vendor access in this environment -> honest 503,
#      never a fabricated result). ------------------------------------------
RT_CODE=$(curl -s -o /tmp/kwgap-research-term.$$ -w '%{http_code}' -X POST "$API/projects/$PID/opportunities/research-term" "${AUTH[@]}" -H 'content-type: application/json' -d '{"keyword":"smoke manual lookup term"}')
if [ "$RT_CODE" = "503" ]; then
  ok "research-term: honest 503 without live DataForSEO credentials (no fabricated result)"
elif [ "$RT_CODE" = "201" ] || [ "$RT_CODE" = "200" ]; then
  ok "research-term: live DataForSEO configured in this environment, call succeeded"
else
  bad "research-term unexpected HTTP $RT_CODE: $(cat /tmp/kwgap-research-term.$$)"
fi
rm -f /tmp/kwgap-research-term.$$

# ── 6. Ownership / not-found -------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/does-not-exist/opportunities" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC"

echo
echo "== keyword-gaps (P07 opportunities): $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

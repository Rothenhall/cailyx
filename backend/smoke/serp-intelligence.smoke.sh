#!/usr/bin/env bash
# E2E smoke — serp-intelligence module (Agent #3). Fixture provider
# (SERP_ALLOW_FIXTURE=1) — canned SERPs, no DataForSEO account, no spend.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== serp-intelligence smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# fixture SERPs reference domain acme-serp.example — match it so subject rank resolves
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"Acme\",\"domain\":\"acme-serp.example\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
if [ -z "$PID" ] || [ "$PID" = "__ERR__" ]; then
  # domain is unique — reuse the existing project for this fixed domain
  PID=$(curl -s "$API/projects?search=acme-serp.example" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0]?a[0].id:"")})')
fi
[ -n "$PID" ] && ok "project $PID (domain acme-serp.example)" || { bad "project"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# seed competitors directly (no API surface for this yet — intake does it from a live crawl)
node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.update({where:{id:process.argv[1]},data:{competitors:JSON.stringify([{name:'Profound',domain:'profound.ai'},{name:'Peec',domain:'peec.ai'}])}}).then(()=>p.\$disconnect())" "$PID" && ok "seeded competitors (Profound, Peec)" || bad "competitor seed failed"

# --- create tracker with fixture keywords ------------------------------
T=$(curl -s -X POST "$API/projects/$PID/serp-trackers" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"AEO keywords","provider":"fixture","keywords":["AI visibility platform","answer engine optimization","how to get cited by chatgpt"]}')
TID=$(echo "$T" | jget id)
[ -n "$TID" ] && [ "$TID" != "__ERR__" ] && ok "created tracker $TID" || { bad "tracker create"; echo "$T"; exit 1; }
[ "$(echo "$T" | jget provider)" = "fixture" ] && ok "provider = fixture" || bad "provider = $(echo "$T" | jget provider)"
[ "$(echo "$T" | jlen queries)" = "3" ] && ok "3 queries attached" || bad "queries = $(echo "$T" | jlen queries)"

# add + dedupe + remove a query
T2=$(curl -s -X POST "$API/projects/$PID/serp-trackers/$TID/queries" "${AUTH[@]}" -H 'content-type: application/json' -d '{"keywords":["AI visibility platform","new keyword one"]}')
[ "$(echo "$T2" | jlen queries)" = "4" ] && ok "add keywords dedupes existing (3 → 4)" || bad "add dedupe wrong: $(echo "$T2" | jlen queries)"
QID=$(echo "$T2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s).queries.find(x=>x.keyword==="new keyword one");process.stdout.write(q?q.id:"")})')
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/projects/$PID/serp-trackers/$TID/queries/$QID" "${AUTH[@]}")" = "200" ] && ok "remove query → 200" || bad "remove query failed"

# --- capture a snapshot (fixture) ------------------------------------
CAP=$(curl -s -X POST "$API/projects/$PID/serp-trackers/$TID/capture" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
SID=$(echo "$CAP" | jget snapshotId)
[ -n "$SID" ] && [ "$SID" != "__ERR__" ] && ok "captured snapshot $SID" || { bad "capture"; echo "$CAP"; exit 1; }
[ "$(echo "$CAP" | jget status)" = "complete" ] && ok "snapshot status = complete" || bad "status = $(echo "$CAP" | jget status)"
[ "$(echo "$CAP" | jget queriesRun)" = "3" ] && ok "3 queries run" || bad "queriesRun = $(echo "$CAP" | jget queriesRun)"
[ "$(echo "$CAP" | jget costUsd)" = "0" ] && ok "fixture cost = 0" || bad "cost = $(echo "$CAP" | jget costUsd)"

SNAP=$(curl -s "$API/projects/$PID/serp-trackers/$TID/snapshots/$SID" "${AUTH[@]}")
[ "$(echo "$SNAP" | jlen results)" = "3" ] && ok "3 per-query results persisted" || bad "results = $(echo "$SNAP" | jlen results)"

# --- metric checks against the canned SERPs -------------------------
# "AI visibility platform": acme-serp.example is organic rank 5; AI overview present; Profound+Peec seen
R1=$(echo "$SNAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).results.find(x=>x.keyword==="ai visibility platform");process.stdout.write(JSON.stringify(r))})')
[ "$(echo "$R1" | jget subjectRank)" = "5" ] && ok "subject organic rank captured (5)" || bad "subjectRank = $(echo "$R1" | jget subjectRank)"
[ "$(echo "$R1" | jget aiOverviewPresent)" = "true" ] && ok "AI Overview presence detected" || bad "aiOverviewPresent = $(echo "$R1" | jget aiOverviewPresent)"
echo "$R1" | grep -q "Profound" && echo "$R1" | grep -q "Peec" && ok "both competitors detected in the SERP" || bad "competitors not detected: $(echo "$R1" | jget competitorsSeen)"
TD=$(echo "$R1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(JSON.parse(s).topDomains);process.stdout.write(JSON.stringify(t.map(x=>x.rank)))})')
[ "$TD" = "[2,3,5,6]" ] && ok "topDomains captured in rank order ($TD)" || bad "topDomains = $TD"
SC=$(echo "$R1" | jget sourceCount); [ "$SC" -ge 4 ] 2>/dev/null && ok "distinct source domains counted ($SC)" || bad "sourceCount = $SC"

# "answer engine optimization": acme rank 9, featured snippet from searchengineland
R2=$(echo "$SNAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).results.find(x=>x.keyword==="answer engine optimization");process.stdout.write(JSON.stringify(r))})')
[ "$(echo "$R2" | jget subjectRank)" = "9" ] && ok "second keyword: subject rank 9" || bad "R2 subjectRank = $(echo "$R2" | jget subjectRank)"
[ "$(echo "$R2" | jget featuredSnippetDomain)" = "searchengineland.com" ] && ok "featured snippet domain captured" || bad "featuredSnippet = $(echo "$R2" | jget featuredSnippetDomain)"

# "how to get cited by chatgpt": acme NOT present → subjectRank null
R3=$(echo "$SNAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).results.find(x=>x.keyword==="how to get cited by chatgpt");process.stdout.write(JSON.stringify(r))})')
[ "$(echo "$R3" | jget subjectRank)" = "" ] && ok "keyword where subject is absent → subjectRank null" || bad "R3 subjectRank = $(echo "$R3" | jget subjectRank)"
[ "$(echo "$R3" | jget aiOverviewMentionsSubject)" = "false" ] && ok "AI Overview does not mention absent subject" || bad "aiOverviewMentionsSubject = $(echo "$R3" | jget aiOverviewMentionsSubject)"

# --- guards -------------------------------------------------------
# live provider blocked without SWARM_ALLOW_LIVE
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/serp-trackers/$TID/capture" "${AUTH[@]}" -H 'content-type: application/json' -d '{"provider":"dataforseo"}')" = "503" ] && ok "dataforseo provider w/ SWARM_ALLOW_LIVE=0 → 503" || bad "live guard not 503"
# empty keywords → 400
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/serp-trackers" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"empty","keywords":[]}')" = "400" ] && ok "empty keywords → 400" || bad "empty keywords not 400"

# --- determinism ----------------------------------------------
CAP2=$(curl -s -X POST "$API/projects/$PID/serp-trackers/$TID/capture" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
SID2=$(echo "$CAP2" | jget snapshotId)
R1B=$(curl -s "$API/projects/$PID/serp-trackers/$TID/snapshots/$SID2" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).results.find(x=>x.keyword==="ai visibility platform");process.stdout.write(String(r.subjectRank))})')
[ "$R1B" = "5" ] && ok "re-capture is deterministic (same subject rank)" || bad "re-capture rank = $R1B"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

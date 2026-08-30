#!/usr/bin/env bash
# E2E smoke — authority module (Agent #6). SERP fixture + citation discovery,
# then promote into mention-tracking. No DataForSEO account, no LLM, no outreach.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== authority smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"Acme\",\"domain\":\"acme-serp.example\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
if [ -z "$PID" ] || [ "$PID" = "__ERR__" ]; then
  PID=$(curl -s "$API/projects?search=acme-serp.example" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0]?a[0].id:"")})')
fi
[ -n "$PID" ] && ok "project $PID" || { bad "project"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.update({where:{id:process.argv[1]},data:{competitors:JSON.stringify([{name:'Profound',domain:'profound.ai'},{name:'Peec',domain:'peec.ai'}])}}).then(()=>p.\$disconnect())" "$PID" && ok "seeded competitors" || bad "competitor seed"

# --- upstream: journeys produce AI-answer citations ---------------------
GEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":2}')
for i in 0 1; do curl -s -X POST "$API/projects/$PID/personas/$(echo "$GEN" | jget personas.$i.id)/activate" "${AUTH[@]}" >/dev/null; done
curl -s -X POST "$API/projects/$PID/journey-campaigns" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"authority upstream","surface":"mock","journeyTarget":2,"maxDepth":2,"maxBranches":2,"budgetUsd":5}' >/dev/null
ok "ran upstream journey campaign (mock citations)"

# --- authority scan: SERP fixture + citations -------------------------
S=$(curl -s -X POST "$API/projects/$PID/authority-scans" "${AUTH[@]}" -H 'content-type: application/json' -d '{"method":"combined","listicleQueries":["AI visibility platform","answer engine optimization","how to get cited by chatgpt"]}')
SID=$(echo "$S" | jget id)
[ -n "$SID" ] && [ "$SID" != "__ERR__" ] && ok "ran authority scan $SID" || { bad "scan"; echo "$S"; exit 1; }
[ "$(echo "$S" | jget status)" = "complete" ] && ok "status = complete" || bad "status = $(echo "$S" | jget status)"
CN=$(echo "$S" | jget candidateCount)
[ "$CN" -ge 3 ] 2>/dev/null && ok "discovered $CN authority candidates" || { bad "candidateCount = $CN"; echo "$S" | head -c 500; }

# boundary: never the client, never a direct competitor
EXCL=$(echo "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates;const bad=c.filter(x=>/acme-serp\.example|profound\.ai|peec\.ai/.test(x.domain));process.stdout.write(String(bad.length))})')
[ "$EXCL" = "0" ] && ok "no candidate is the client or a direct competitor" || bad "$EXCL excluded domains leaked in"

# well-formed candidates
BADC=$(echo "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates;const g=new Set(["listicle","community","podcast","publication","directory","newsletter"]);const bad=c.filter(x=>!(x.domain&&x.url&&x.rationale&&x.discoveredVia&&g.has(x.type)&&x.relevance>=0&&x.relevance<=1));process.stdout.write(String(bad.length))})')
[ "$BADC" = "0" ] && ok "every candidate well-formed (domain/url/type/relevance/rationale/via)" || bad "$BADC malformed candidates"

# classification: reddit → community
RT=$(echo "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).candidates.find(x=>x.domain==="reddit.com");process.stdout.write(c?c.type:"")})')
[ "$RT" = "community" ] && ok "reddit.com classified as community" || bad "reddit type = $RT"
# a searchengineland candidate exists (SERP-discovered publication)
echo "$S" | grep -q 'searchengineland.com' && ok "SERP listicle domain discovered (searchengineland.com)" || bad "searchengineland not discovered"
# a citation-discovered candidate exists
echo "$S" | grep -q 'citation:journey' && ok "citation-discovered candidate present (from journey AI answers)" || bad "no citation:journey candidate"
# sorted by relevance desc
SORTED=$(echo "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).candidates.map(x=>x.relevance);process.stdout.write(String(r.every((v,i)=>i===0||r[i-1]>=v)))})')
[ "$SORTED" = "true" ] && ok "candidates sorted by relevance desc" || bad "not sorted"

# --- promote into mention-tracking ---------------------------------
CID=$(echo "$S" | jget candidates.0.id)
PR=$(curl -s -X POST "$API/projects/$PID/authority-scans/$SID/candidates/$CID/promote" "${AUTH[@]}")
TGT=$(echo "$PR" | jget target.id)
[ -n "$TGT" ] && [ "$TGT" != "__ERR__" ] && ok "promoted candidate → MentionTarget $TGT" || { bad "promote"; echo "$PR"; }
[ "$(echo "$PR" | jget candidate.status)" = "promoted" ] && ok "candidate status = promoted" || bad "candidate status = $(echo "$PR" | jget candidate.status)"
[ "$(echo "$PR" | jget candidate.promotedTargetId)" = "$TGT" ] && ok "candidate links to the MentionTarget" || bad "promotedTargetId mismatch"
# the target shows up in mention-tracking
MT=$(curl -s "$API/projects/$PID/mentions/targets" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);process.stdout.write(String(t.some(x=>x.id===process.argv[1])))})' "$TGT")
[ "$MT" = "true" ] && ok "MentionTarget visible in the mention-tracking ledger" || bad "target not in ledger"
# re-promote → 409
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/authority-scans/$SID/candidates/$CID/promote" "${AUTH[@]}")" = "409" ] && ok "re-promote same candidate → 409" || bad "re-promote not 409"
# dismiss another candidate
CID2=$(echo "$S" | jget candidates.1.id)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PID/authority-scans/$SID/candidates/$CID2" "${AUTH[@]}" -H 'content-type: application/json' -d '{"status":"dismissed"}')" = "200" ] && ok "dismiss candidate → 200" || bad "dismiss failed"

# --- guards -----------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/authority-scans" "${AUTH[@]}" -H 'content-type: application/json' -d '{"method":"llm"}')" = "503" ] && ok "method=llm without ANTHROPIC_API_KEY → 503" || bad "llm method not 503"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/authority-scans" "${AUTH[@]}" -H 'content-type: application/json' -d '{"method":"bogus"}')" = "400" ] && ok "unknown method → 400" || bad "bad method not 400"

# --- determinism ---------------------------------------------
S2=$(curl -s -X POST "$API/projects/$PID/authority-scans" "${AUTH[@]}" -H 'content-type: application/json' -d '{"method":"serp","listicleQueries":["AI visibility platform","answer engine optimization","how to get cited by chatgpt"]}')
[ "$(echo "$S2" | jget candidateCount)" -ge 2 ] 2>/dev/null && ok "serp-only re-run also produces candidates ($(echo "$S2" | jget candidateCount))" || bad "serp-only rerun = $(echo "$S2" | jget candidateCount)"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

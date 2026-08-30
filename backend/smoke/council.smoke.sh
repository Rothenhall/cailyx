#!/usr/bin/env bash
# E2E smoke — council module (Agent #10). Deterministic engine. Builds real
# upstream artefacts (journeys + link graph) then debates over them. No keys.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== council smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"Council Smoke Co\",\"domain\":\"council-smoke-$RANDOM.example\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- empty project: nothing to debate --------------------------------
E=$(curl -s -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$E" | jget status)" = "complete" ] && ok "empty project → session completes" || bad "empty status = $(echo "$E" | jget status)"
[ "$(echo "$E" | jlen rankings)" = "0" ] && ok "empty project → 0 rankings (honest, no invented work)" || bad "empty rankings = $(echo "$E" | jlen rankings)"

# --- build upstream artefacts --------------------------------------
GEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":3}')
for i in 0 1 2; do curl -s -X POST "$API/projects/$PID/personas/$(echo "$GEN" | jget personas.$i.id)/activate" "${AUTH[@]}" >/dev/null; done
CAMP=$(curl -s -X POST "$API/projects/$PID/journey-campaigns" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"Council upstream","surface":"mock","journeyTarget":3,"maxDepth":2,"maxBranches":2,"budgetUsd":5}')
[ "$(echo "$CAMP" | jget status)" = "completed" ] && ok "upstream journey campaign completed" || bad "campaign = $(echo "$CAMP" | jget status)"
G=$(curl -s -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rootUrl":"fixture://demo","maxPages":20,"maxDepth":3}')
[ "$(echo "$G" | jget orphanCount)" = "1" ] && ok "upstream link graph has an orphan" || bad "link graph orphan = $(echo "$G" | jget orphanCount)"

# --- run the council ---------------------------------------------
C=$(curl -s -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
CID=$(echo "$C" | jget id)
[ -n "$CID" ] && [ "$CID" != "__ERR__" ] && ok "ran council session $CID" || { bad "run"; echo "$C"; exit 1; }
[ "$(echo "$C" | jget status)" = "complete" ] && ok "status = complete" || bad "status = $(echo "$C" | jget status)"
[ "$(echo "$C" | jget source)" = "deterministic" ] && ok "source = deterministic" || bad "source wrong"

RANKS=$(echo "$C" | jlen rankings)
[ "$RANKS" -ge 2 ] 2>/dev/null && ok "debate produced $RANKS ranked interventions" || { bad "rankings = $RANKS"; echo "$C" | head -c 500; }
# 6 agents × 1 round = 6 contributions
[ "$(echo "$C" | jlen contributions)" = "6" ] && ok "6 agent contributions (6 roles × 1 round)" || bad "contributions = $(echo "$C" | jlen contributions)"

# rankings well-formed + sorted by rank
BADRANK=$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).rankings;const g=new Set(["low","medium","high"]);const bad=r.filter((x,i)=>!(x.rank===i+1&&x.consensus>=0&&x.consensus<=1&&x.expectedImpact>=0&&x.expectedImpact<=100&&g.has(x.effort)&&g.has(x.confidence)&&x.interventionKey&&x.title));process.stdout.write(String(bad.length))})')
[ "$BADRANK" = "0" ] && ok "every ranking well-formed + rank order correct" || bad "$BADRANK malformed rankings"
# top-ranked has non-empty sourceRefs (traces back to a real artefact)
SR=$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).rankings[0];const refs=JSON.parse(r.sourceRefs||"[]");process.stdout.write(String(refs.length))})')
[ "$SR" -ge 1 ] 2>/dev/null && ok "top intervention cites $SR source artefact(s)" || bad "top intervention has no sourceRefs"
# the internal-link orphan finding made it into the candidate set
echo "$C" | grep -q 'architecture:internal-links' && ok "link-graph orphan surfaced as a candidate intervention" || bad "internal-links candidate missing"
# at least one ranking records a dissent (the skeptic voice)
DIS=$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).rankings;process.stdout.write(String(r.filter(x=>x.dissent&&x.dissent.length>0).length))})')
[ "$DIS" -ge 1 ] 2>/dev/null && ok "minority dissent recorded on $DIS ranking(s)" || bad "no dissent recorded"
# each contribution carries positions covering the candidates
POS=$(echo "$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).contributions;process.stdout.write(String(c.every(x=>{try{return JSON.parse(x.positions).length>0}catch(e){return false}})))})')
[ "$POS" = "true" ] && ok "every agent stated positions on the candidates" || bad "an agent had no positions"

# --- rounds + role subset --------------------------------------
C2=$(curl -s -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rounds":2,"agentRoles":["technical","skeptic","measurement"]}')
[ "$(echo "$C2" | jlen contributions)" = "6" ] && ok "3 roles × 2 rounds = 6 contributions" || bad "subset contributions = $(echo "$C2" | jlen contributions)"
[ "$(echo "$C2" | jget rounds)" = "2" ] && ok "session records rounds = 2" || bad "rounds not 2"

# --- guards ---------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{"useLlm":true}')" = "503" ] && ok "useLlm without ANTHROPIC_API_KEY → 503" || bad "useLlm not 503"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rounds":9}')" = "400" ] && ok "rounds out of range → 400" || bad "rounds not validated"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{"agentRoles":["wizard"]}')" = "400" ] && ok "unknown agent role → 400" || bad "bad role not 400"

# --- determinism -------------------------------------------
TOP1=$(echo "$C" | jget rankings.0.interventionKey)
C3=$(curl -s -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$C3" | jget rankings.0.interventionKey)" = "$TOP1" ] && [ "$(echo "$C3" | jlen rankings)" = "$RANKS" ] && ok "re-run is deterministic (same top intervention '$TOP1', same count)" || bad "re-run differs"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

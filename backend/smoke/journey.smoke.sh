#!/usr/bin/env bash
# E2E smoke — journey module (Agent #2). Mock surface only (MEASUREMENT_ALLOW_MOCK=1).
# No API keys, no live spend. Deletes the smoke project on exit.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== journey smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"Journey Smoke Co\",\"domain\":\"journey-smoke-$RANDOM.example\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- personas: generate 4, activate 3 -------------------------------------
GEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":4}')
[ "$(echo "$GEN" | jlen personas)" = "4" ] && ok "seeded 4 personas" || bad "persona seed"
P0=$(echo "$GEN" | jget personas.0.id)
for i in 0 1 2; do
  pid=$(echo "$GEN" | jget personas.$i.id)
  curl -s -X POST "$API/projects/$PID/personas/$pid/activate" "${AUTH[@]}" >/dev/null
done
ok "activated 3 personas"

# --- plan a deterministic mock journey -----------------------------------
J=$(curl -s -X POST "$API/projects/$PID/journeys/plan" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"personaId\":\"$P0\",\"surface\":\"mock\",\"maxDepth\":3,\"maxBranches\":2}")
JID=$(echo "$J" | jget id)
[ -n "$JID" ] && [ "$JID" != "__ERR__" ] && ok "planned journey $JID" || { bad "plan"; echo "$J"; }
[ "$(echo "$J" | jget status)" = "planned" ] && ok "journey status = planned" || bad "status != planned"
[ "$(echo "$J" | jget planSource)" = "deterministic" ] && ok "planSource = deterministic" || bad "planSource wrong"
SC=$(echo "$J" | jget stepCount)
[ "$SC" -ge 3 ] 2>/dev/null && ok "branching tree: $SC steps" || bad "stepCount = $SC (expected >= 3)"
[ "$(echo "$J" | jlen steps)" = "$SC" ] && ok "steps array matches stepCount" || bad "steps array length mismatch"
# root is the only parentId=null step, at depth 0
ROOTS=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).steps.filter(x=>x.parentId===null).length)))')
[ "$ROOTS" = "1" ] && ok "exactly one root step" || bad "roots = $ROOTS"
MAXD=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(Math.max(...JSON.parse(s).steps.map(x=>x.depth)))))')
[ "$MAXD" -ge 1 ] && [ "$MAXD" -le 3 ] && ok "tree depth within maxDepth ($MAXD)" || bad "depth = $MAXD"
# every non-root parentId resolves to a real step id
ORPHANS=$(echo "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s).steps;const ids=new Set(st.map(x=>x.id));process.stdout.write(String(st.filter(x=>x.parentId!==null&&!ids.has(x.parentId)).length))})')
[ "$ORPHANS" = "0" ] && ok "no orphan steps (parent refs resolve)" || bad "orphans = $ORPHANS"

# --- execute against mock ------------------------------------------------
EX=$(curl -s -X POST "$API/projects/$PID/journeys/$JID/execute" "${AUTH[@]}")
[ "$(echo "$EX" | jget status)" = "completed" ] && ok "execute → completed" || { bad "execute status = $(echo "$EX" | jget status)"; echo "$EX"; }
[ "$(echo "$EX" | jget executedSteps)" = "$SC" ] && ok "all $SC steps executed" || bad "executedSteps = $(echo "$EX" | jget executedSteps)"
[ "$(echo "$EX" | jget costUsd)" = "0" ] && ok "mock cost = 0 (no spend)" || bad "cost = $(echo "$EX" | jget costUsd)"
MENT=$(echo "$EX" | jget mentionedSteps); [ -n "$MENT" ] && [ "$MENT" -ge 0 ] 2>/dev/null && ok "mentionedSteps is an integer ($MENT)" || bad "mentionedSteps = $MENT"
# steps now carry answers
DONE=$(curl -s "$API/projects/$PID/journeys/$JID" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s).steps;process.stdout.write(String(st.filter(x=>x.status==="done"&&x.answerText).length))})')
[ "$DONE" = "$SC" ] && ok "every step stored an answer" || bad "answered steps = $DONE / $SC"
# re-execute rejected
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/journeys/$JID/execute" "${AUTH[@]}")" = "409" ] && ok "re-execute completed journey → 409" || bad "re-execute not 409"

# --- cost governor: fresh journey, cap 0 → stop before any spend ---------
J2=$(curl -s -X POST "$API/projects/$PID/journeys/plan" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"personaId\":\"$P0\",\"surface\":\"mock\",\"maxDepth\":3,\"maxBranches\":2}")
J2ID=$(echo "$J2" | jget id)
EX2=$(curl -s -X POST "$API/projects/$PID/journeys/$J2ID/execute?maxCostUsd=0" "${AUTH[@]}")
[ "$(echo "$EX2" | jget status)" = "partial" ] && ok "cost cap 0 → partial" || bad "cap status = $(echo "$EX2" | jget status)"
[ "$(echo "$EX2" | jget executedSteps)" = "0" ] && ok "cost cap 0 → 0 steps executed" || bad "cap executed = $(echo "$EX2" | jget executedSteps)"
echo "$EX2" | jget note | grep -q "cost cap" && ok "stop reason recorded on journey" || bad "no cost-cap note"
SKIP=$(curl -s "$API/projects/$PID/journeys/$J2ID" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s).steps;process.stdout.write(String(st.filter(x=>x.status==="skipped").length))})')
[ "$SKIP" -ge 1 ] 2>/dev/null && ok "remaining steps marked skipped ($SKIP)" || bad "skipped = $SKIP"

# --- live-surface guard -------------------------------------------------
JC=$(curl -s -X POST "$API/projects/$PID/journeys/plan" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"personaId\":\"$P0\",\"surface\":\"claude\",\"maxDepth\":2,\"maxBranches\":2}")
JCID=$(echo "$JC" | jget id)
[ -n "$JCID" ] && [ "$JCID" != "__ERR__" ] && ok "planning a claude-surface journey is allowed (no spend yet)" || bad "claude plan failed"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/journeys/$JCID/execute" "${AUTH[@]}")" = "503" ] && ok "execute claude surface w/ SWARM_ALLOW_LIVE=0 → 503" || bad "live guard not 503"

# --- LLM planning gated ------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/journeys/plan" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"personaId\":\"$P0\",\"useLlm\":true}")" = "503" ] && ok "useLlm plan without ANTHROPIC_API_KEY → 503" || bad "useLlm plan not 503"

# --- campaign fan-out (mock, budget covers all) ------------------------
CAMP=$(curl -s -X POST "$API/projects/$PID/journey-campaigns" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"Smoke Campaign","surface":"mock","journeyTarget":3,"maxDepth":2,"maxBranches":2,"budgetUsd":5}')
[ "$(echo "$CAMP" | jget status)" = "completed" ] && ok "campaign auto-run → completed" || { bad "campaign status = $(echo "$CAMP" | jget status)"; echo "$CAMP" | head -c 400; }
[ "$(echo "$CAMP" | jget journeysPlanned)" = "3" ] && ok "campaign planned 3 journeys (one per active persona)" || bad "planned = $(echo "$CAMP" | jget journeysPlanned)"
[ "$(echo "$CAMP" | jget journeysExecuted)" = "3" ] && ok "campaign executed 3 journeys" || bad "executed = $(echo "$CAMP" | jget journeysExecuted)"
CDONE=$(echo "$CAMP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).journeys;process.stdout.write(String(j.filter(x=>x.status==="completed"&&x.executedSteps>0).length))})')
[ "$CDONE" = "3" ] && ok "all 3 child journeys completed with steps executed" || bad "completed child journeys = $CDONE"
[ "$(echo "$CAMP" | jget spentUsd)" = "0" ] && ok "campaign spend = 0 (mock)" || bad "spend = $(echo "$CAMP" | jget spentUsd)"
[ "$(echo "$CAMP" | jlen journeys)" = "3" ] && ok "campaign carries its 3 journeys" || bad "journeys attached = $(echo "$CAMP" | jlen journeys)"
# no active personas of a role → 409
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/journey-campaigns" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"Empty","journeyTarget":2,"budgetUsd":1,"personaRoles":["rev-ops"]}')" = "409" ] && ok "campaign with no matching active personas → 409" || bad "empty-campaign not 409"

# --- layered suggestion wheel (Flywheel data) ----------------------
SW=$(curl -s "$API/projects/$PID/journeys/suggestions" "${AUTH[@]}")
[ "$(echo "$SW" | jlen stages)" = "4" ] && ok "wheel has 4 awareness stages" || bad "stages = $(echo "$SW" | jlen stages)"
[ "$(echo "$SW" | jget hub.label)" = "Journey Smoke Co" ] && ok "wheel hub = project name" || bad "hub = $(echo "$SW" | jget hub.label)"
SWT=$(echo "$SW" | jget total)
[ "$SWT" -ge 12 ] 2>/dev/null && ok "wheel produced $SWT layered suggestions" || bad "total = $SWT"
echo "$SW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s);const bad=w.stages.some(st=>!st.themes.length||st.themes.some(th=>th.queries.some(q=>!q.text||!q.painPoint||!q.suggestion||!["template","persona","journey"].includes(q.source))));process.exit(bad?1:0)})' && ok "every leaf has text + painPoint + suggestion + source" || bad "malformed suggestion leaf"
echo "$SW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s);const themed=w.stages.every(st=>st.themes.length>=1);process.exit(themed?0:1)})' && ok "every stage has >=1 theme (layered)" || bad "a stage has no themes"
SW2T=$(curl -s "$API/projects/$PID/journeys/suggestions" "${AUTH[@]}" | jget total)
[ "$SW2T" = "$SWT" ] && ok "wheel is deterministic ($SW2T)" || bad "wheel re-run differs: $SW2T vs $SWT"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

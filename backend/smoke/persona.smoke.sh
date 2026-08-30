#!/usr/bin/env bash
# E2E smoke — persona module (Agent #1). Deterministic path only (no API keys).
# Writes to dev.db and deletes the smoke project at the end.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== persona smoke =="

# --- auth (shared smoke operator) ------------------------------------------
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# --- project ----------------------------------------------------------------
DOM="persona-smoke-$RANDOM.example"
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Persona Smoke Co\",\"domain\":\"$DOM\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- generate 12 deterministic personas ------------------------------------
GEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":12}')
[ "$(echo "$GEN" | jlen personas)" = "12" ] && ok "generated 12 personas" || { bad "expected 12"; echo "$GEN"; }
[ "$(echo "$GEN" | jget llmRefined)" = "0" ] && ok "llmRefined=0 (deterministic)" || bad "llmRefined != 0"
[ "$(echo "$GEN" | jget capped)" = "false" ] && ok "not capped" || bad "capped != false"
[ "$(echo "$GEN" | jget personas.0.role)" = "founder" ] && ok "slot 0 role = founder" || bad "slot 0 role = $(echo "$GEN" | jget personas.0.role)"
[ "$(echo "$GEN" | jget personas.10.role)" = "founder" ] && ok "slot 10 wraps to founder (10-role round-robin)" || bad "slot 10 role wrong"

SEED0=$(echo "$GEN" | jget personas.0.seed)
[ "$SEED0" = "$PID:0:founder" ] && ok "deterministic seed = $SEED0" || bad "seed = $SEED0"
[ "$(echo "$GEN" | jlen personas.0.vocabulary)" -ge 1 ] 2>/dev/null && ok "vocabulary populated" || bad "vocabulary empty"
AW0=$(echo "$GEN" | jget personas.0.awareness)
case "$AW0" in problem-aware|solution-aware|product-aware|most-aware) ok "awareness in union ($AW0)";; *) bad "awareness = $AW0";; esac
[ "$(echo "$GEN" | jget personas.0.status)" = "draft" ] && ok "new persona is draft" || bad "status not draft"
echo "$GEN" | grep -q "AI visibility diagnostics" && ok "project category interpolated into copy" || bad "category not in copy"
P0_LABEL=$(echo "$GEN" | jget personas.0.label)

# --- regenerate: fills new slots, no collision ----------------------------
GEN2=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":3}')
# slot 12 → 12 % 10 → index 2 in the role catalogue → head-of-growth
[ "$(echo "$GEN2" | jget personas.0.seed)" = "$PID:12:head-of-growth" ] && ok "regenerate continues at slot 12 (round-robin)" || bad "slot 12 seed = $(echo "$GEN2" | jget personas.0.seed)"
[ "$(curl -s "$API/projects/$PID/personas" "${AUTH[@]}" | jlen)" = "15" ] && ok "15 personas total after regenerate" || bad "total != 15"

# --- LLM path gated (no ANTHROPIC_API_KEY) — capability check precedes cap ---
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":1,"useLlm":true}')" = "503" ] && ok "useLlm without key → 503 (honest gate, not a placeholder)" || bad "useLlm not 503"

# --- fan-out cap (PERSONA_MAX_PER_PROJECT=100; DTO caps count at 100) --------
GEN3=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":100}')
[ "$(echo "$GEN3" | jget capped)" = "true" ] && [ "$(echo "$GEN3" | jlen personas)" = "85" ] && ok "count=100 with 15 used → capped to 85 (project limit)" || bad "cap: capped=$(echo "$GEN3" | jget capped) made=$(echo "$GEN3" | jlen personas)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":5}')" = "409" ] && ok "generate at cap → 409" || bad "at-cap generate not 409"

# --- input validation -----------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":0}')" = "400" ] && ok "count=0 → 400 (DTO @Min)" || bad "count=0 not 400"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/personas" "${AUTH[@]}" -H 'content-type: application/json' -d '{"label":"x","role":"astronaut","primaryGoal":"g","researchObjective":"o"}')" = "400" ] && ok "unknown role → 400 (DTO whitelist)" || bad "bad role not 400"

# --- lifecycle + immutability ------------------------------------------------
FID=$(curl -s "$API/projects/$PID/personas" "${AUTH[@]}" | jget 0.id)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PID/personas/$FID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"primaryGoal":"Edited goal for the smoke test run"}')" = "200" ] && ok "patch draft persona → 200" || bad "patch draft not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/personas/$FID/activate" "${AUTH[@]}")" = "200" ] && ok "activate → 200" || bad "activate not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PID/personas/$FID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"primaryGoal":"should be rejected now"}')" = "409" ] && ok "patch active persona → 409 (immutable)" || bad "patch active not 409"

# --- determinism: wipe all, regenerate founder slot 0 → byte-identical ------
for id in $(curl -s "$API/projects/$PID/personas" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).forEach(p=>console.log(p.id)))'); do
  curl -s -X DELETE "$API/projects/$PID/personas/$id" "${AUTH[@]}" >/dev/null
done
[ "$(curl -s "$API/projects/$PID/personas" "${AUTH[@]}" | jlen)" = "0" ] && ok "all personas deleted (slots reclaimed)" || bad "delete-all left rows"
REGEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":1,"roles":["founder"]}')
if [ "$(echo "$REGEN" | jget personas.0.label)" = "$P0_LABEL" ]; then
  ok "regenerated slot 0 byte-identical (deterministic)"
else
  bad "determinism: '$(echo "$REGEN" | jget personas.0.label)' != '$P0_LABEL'"; echo "    REGEN=$REGEN"
fi

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

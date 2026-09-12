#!/usr/bin/env bash
# E2E smoke — keyword-research module. DataForSEO Keywords Data (wave-6 D5).
#
# DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD (and SWARM_ALLOW_LIVE) are NOT set in
# this environment, so a real vendor call is not attempted here. What this
# asserts is the honest fail-closed path: a request with valid input but no
# credentials must return 503 naming exactly what to set — never a silent
# empty/fake keyword list. Same discipline as serp-intelligence's own
# missing-credential path.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== keyword-research smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Keyword Research Smoke Co\",\"domain\":\"kwresearch-smoke-$RANDOM.example.com\",\"category\":\"keyword research\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- 1. no research yet -> empty list, not an error -------------------------
LIST0=$(curl -s "$API/projects/$PID/keyword-research" "${AUTH[@]}")
[ "$(echo "$LIST0" | jlen sets)" = "0" ] && ok "no research yet -> { sets: [] } (not an error)" || bad "expected sets=[], got: $LIST0"

# --- 2. honest 503 without DATAFORSEO credentials ----------------------------
SC=$(curl -s -o /tmp/kwr_body.json -w '%{http_code}' -X POST "$API/projects/$PID/keyword-research" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{"keywords":["ai visibility platform"]}')
BODY=$(cat /tmp/kwr_body.json 2>/dev/null)
[ "$SC" = "503" ] && ok "missing DATAFORSEO credentials -> 503 (fail closed, no fake data)" || { bad "expected 503, got $SC"; echo "$BODY"; }
REASON=$(echo "$BODY" | jget message)
{ echo "$REASON" | grep -qi 'SWARM_ALLOW_LIVE\|DATAFORSEO'; } && ok "503 reason names the missing config: $REASON" || bad "503 body did not name the missing env var(s): $BODY"

# --- 3. the 503 path writes nothing -- list is still empty -------------------
LIST1=$(curl -s "$API/projects/$PID/keyword-research" "${AUTH[@]}")
[ "$(echo "$LIST1" | jlen sets)" = "0" ] && ok "no KeywordSet row was written on the 503 path" || bad "expected sets still [], got: $LIST1"

# --- 4. input validation: empty keywords array -> 400 ------------------------
SC2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/keyword-research" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{"keywords":[]}')
[ "$SC2" = "400" ] && ok "empty keywords array -> 400" || bad "empty keywords array -> $SC2"

# --- 5. ownership -------------------------------------------------------------
SC3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/does-not-exist/keyword-research" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{"keywords":["x"]}')
[ "$SC3" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC3"

rm -f /tmp/kwr_body.json
echo
echo "== keyword-research: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

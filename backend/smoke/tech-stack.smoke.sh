#!/usr/bin/env bash
# E2E smoke — tech-stack module. Deterministic in-repo signature matching,
# no vendor account, no API key.
#
# Two live fetches, deliberately chosen for stability:
#   1. A domain that does not resolve -- the honest-failure path (status:
#      failed, never a 500), same convention as digital-presence.smoke.sh.
#   2. cloudflare.com itself -- a CDN vendor fronting its own homepage with
#      its own product is about the most stable real-world signature there is
#      (infra-level response header, not app-level markup that reshuffles on
#      a redesign).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== tech-stack smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Tech Stack Smoke Co\",\"domain\":\"techstack-smoke-$RANDOM.example.com\",\"category\":\"tech stack\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- 1. no scan yet -> latest is null, not an error -------------------------
LATEST0=$(curl -s "$API/projects/$PID/tech-stack" "${AUTH[@]}")
[ "$(echo "$LATEST0" | jget scan)" = "" ] && ok "no scan yet -> { scan: null } (not an error)" || bad "expected scan=null, got: $LATEST0"

# --- 2. the project's own (unresolvable) domain fails honestly --------------
S1=$(curl -s -X POST "$API/projects/$PID/tech-stack/scan" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$S1" | jget status)" = "failed" ] && ok "scan of an unresolvable domain -> status failed (no crash)" || { bad "status = $(echo "$S1" | jget status)"; echo "$S1"; }
[ -n "$(echo "$S1" | jget error)" ] && ok "failure reason stated: $(echo "$S1" | jget error)" || bad "failed scan has no error message"
[ "$(echo "$S1" | jlen findings)" = "0" ] && ok "no findings on a failed fetch" || bad "findings = $(echo "$S1" | jlen findings)"

# --- 3. domain override scans any domain, not just the project's own --------
S2=$(curl -s -X POST "$API/projects/$PID/tech-stack/scan" "${AUTH[@]}" -H 'content-type: application/json' -d '{"domain":"cloudflare.com"}')
[ "$(echo "$S2" | jget status)" = "completed" ] && ok "override domain scan completes" || { bad "status = $(echo "$S2" | jget status)"; echo "$S2" | head -c 400; }
[ "$(echo "$S2" | jget domain)" = "cloudflare.com" ] && ok "scan recorded against the override domain" || bad "domain = $(echo "$S2" | jget domain)"
CDN_HIT=$(echo "$S2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).findings||[];process.stdout.write(String(f.some(x=>x.category==="cdn"&&/cloudflare/i.test(x.name))))})')
[ "$CDN_HIT" = "true" ] && ok "detected Cloudflare fronting its own homepage" || bad "no Cloudflare CDN finding (site markup or infra may have changed)"

# --- 4. GET latest returns the most recent scan for that domain -------------
LATEST=$(curl -s "$API/projects/$PID/tech-stack?domain=cloudflare.com" "${AUTH[@]}")
[ "$(echo "$LATEST" | jget scan.id)" = "$(echo "$S2" | jget id)" ] && ok "GET latest returns the just-run scan" || bad "latest id mismatch"

# --- 5. ownership ------------------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/does-not-exist/tech-stack/scan" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$SC" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC"

echo
echo "== tech-stack: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

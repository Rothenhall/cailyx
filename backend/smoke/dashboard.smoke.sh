#!/usr/bin/env bash
# E2E smoke — dashboard aggregation (integrations + agents feed). Also seeds a
# demo project with artefacts so the Okara Terminal has something to render.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== dashboard smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# --- integrations roster ---------------------------------------------
IG=$(curl -s "$API/integrations" "${AUTH[@]}")
N=$(echo "$IG" | jlen integrations)
[ "$N" -ge 8 ] 2>/dev/null && ok "integrations roster returned ($N entries)" || { bad "integrations = $N"; echo "$IG" | head -c 300; }
echo "$IG" | grep -q '"key":"google-analytics"' && ok "Google Analytics connector present" || bad "GA connector missing"
echo "$IG" | grep -q '"key":"google-search-console"' && ok "Google Search Console connector present" || bad "GSC connector missing"
GA_CONN=$(echo "$IG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).integrations.find(x=>x.key==="google-analytics");process.stdout.write(String(i.connected))})')
[ "$GA_CONN" = "false" ] && ok "GA reports not-connected (OAuth not wired)" || bad "GA connected=$GA_CONN"
echo "$IG" | grep -q '"key":"dataforseo"' && ok "DataForSEO connector present" || bad "DataForSEO missing"
echo "$IG" | grep -q '"key":"anthropic"' && ok "Anthropic connector present" || bad "Anthropic missing"
# no secret values leak
echo "$IG" | grep -qiE '(sk-|api_key"?:"[a-z0-9]{12}|password":"[^"]{3,})' && bad "possible secret in payload" || ok "no secret values in integrations payload"
SUMC=$(echo "$IG" | jget summary.connected); SUMT=$(echo "$IG" | jget summary.total)
[ -n "$SUMC" ] && [ -n "$SUMT" ] && ok "summary present ($SUMC/$SUMT connected)" || bad "summary missing"

# --- demo project + artefacts --------------------------------------
DOM="rothenhall-demo-$RANDOM.example"
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Rothenhall Partners\",\"domain\":\"$DOM\",\"category\":\"AI visibility & GTM\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created demo project $PID" || { bad "project"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(demo project deleted)"; }
trap cleanup EXIT

curl -s -X PATCH "$API/projects/$PID" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"notes":"Rothenhall Partners embeds one accountable operator to own AI visibility (AEO/GEO), GTM, and revenue operations as one engine."}' >/dev/null
GEN=$(curl -s -X POST "$API/projects/$PID/personas/generate" "${AUTH[@]}" -H 'content-type: application/json' -d '{"count":3}')
for i in 0 1 2; do curl -s -X POST "$API/projects/$PID/personas/$(echo "$GEN" | jget personas.$i.id)/activate" "${AUTH[@]}" >/dev/null; done
curl -s -X POST "$API/projects/$PID/journey-campaigns" "${AUTH[@]}" -H 'content-type: application/json' -d '{"name":"demo","surface":"mock","journeyTarget":3,"maxDepth":2,"maxBranches":2,"budgetUsd":5}' >/dev/null
curl -s -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rootUrl":"fixture://demo","maxPages":20,"maxDepth":3}' >/dev/null
curl -s -X POST "$API/projects/$PID/authority-scans" "${AUTH[@]}" -H 'content-type: application/json' -d '{"method":"citations"}' >/dev/null
curl -s -X POST "$API/projects/$PID/council" "${AUTH[@]}" -H 'content-type: application/json' -d '{}' >/dev/null
ok "seeded personas + journeys + link graph + authority + council"

# --- agents feed --------------------------------------------------
AG=$(curl -s "$API/projects/$PID/agents" "${AUTH[@]}")
AN=$(echo "$AG" | jlen agents)
[ "$AN" -ge 8 ] 2>/dev/null && ok "agents feed returned $AN cards" || { bad "agents = $AN"; echo "$AG" | head -c 400; }
for key in seo geo articles authority journeys personas council mentions serp monitoring; do
  echo "$AG" | grep -q "\"key\":\"$key\"" && ok "agent card: $key" || bad "missing agent: $key"
done
# every card well-formed
BADCARD=$(echo "$AG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents;const g=new Set(["ready","attention","idle","running","blocked"]);const bad=a.filter(x=>!(x.name&&x.headline&&g.has(x.status)&&Array.isArray(x.activity)&&x.activity.length>=1&&x.cta));process.stdout.write(String(bad.length))})')
[ "$BADCARD" = "0" ] && ok "every agent card well-formed (name/headline/status/activity/cta)" || bad "$BADCARD malformed agent cards"
# personas agent should be 'ready' with 3 active after seeding
PA=$(echo "$AG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents.find(x=>x.key==="personas");process.stdout.write(a.headline)})')
echo "$PA" | grep -qE "3 personas active" && ok "personas agent reflects the 3 activated personas" || bad "personas headline: $PA"
# journeys agent reflects the campaign
JA=$(echo "$AG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents.find(x=>x.key==="journeys");process.stdout.write(a.headline+" | "+(a.metric||""))})')
echo "$JA" | grep -qiE "journey" && ok "journey agent reflects the campaign ($JA)" || bad "journey headline: $JA"
# council agent reflects the session
echo "$AG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents.find(x=>x.key==="council");process.exit(/ranked|prioritise/.test(a.headline)?0:1)})' && ok "council agent reflects the debate" || bad "council headline wrong"
# summary counts add up
ST=$(echo "$AG" | jget summary.total)
[ "$ST" = "$AN" ] && ok "summary.total matches card count" || bad "summary.total=$ST vs $AN"
# 404 on unknown project
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/does-not-exist/agents" "${AUTH[@]}")" = "404" ] && ok "unknown project → 404" || bad "unknown project not 404"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

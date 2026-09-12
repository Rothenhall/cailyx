#!/usr/bin/env bash
# E2E smoke — competitors module (wave-6 step 6, D4). Promotes
# Project.competitors (JSON) into Competitor rows, profiles each one
# (tech-stack scan + schema read + attached SERP/AEO presence, all of which
# already exist for free / are honestly absent), then checks the gap diff.
# No vendor account, no API key — same discipline as tech-stack.smoke.sh.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== competitors smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no access token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# Project's own domain is deliberately unresolvable — this exercises the
# honest client-side-scan-failure path inside GET /gap and guarantees every
# competitor tech/schema signature falls under "competitorsOnly".
PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Competitors Smoke Co\",\"domain\":\"competitors-smoke-$RANDOM.example.com\",\"category\":\"competitors smoke\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.update({where:{id:process.argv[1]},data:{competitors:JSON.stringify([{name:'Cloudflare',domain:'cloudflare.com'},{name:'Stripe',domain:'stripe.com'}])}}).then(()=>p.\$disconnect())" "$PID" \
  && ok "seeded Project.competitors JSON (Cloudflare, Stripe)" || { bad "competitor seed"; exit 1; }

# --- 1. no competitors yet -> empty list, not an error ----------------------
LIST0=$(curl -s "$API/projects/$PID/competitors/profiles" "${AUTH[@]}")
[ "$(echo "$LIST0" | jlen competitors)" = "0" ] && ok "no competitors promoted yet -> []" || bad "expected [], got: $LIST0"

# --- 2. discover promotes the JSON list and profiles each ------------------
D1=$(curl -s -X POST "$API/projects/$PID/competitors/discover" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
[ "$(echo "$D1" | jget totalCompetitors)" = "2" ] && ok "promoted both JSON competitors" || { bad "totalCompetitors = $(echo "$D1" | jget totalCompetitors)"; echo "$D1" | head -c 600; }
[ "$(echo "$D1" | jget promoted)" = "2" ] && ok "promoted count = 2 (both new)" || bad "promoted = $(echo "$D1" | jget promoted)"

CF_STATUS=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors.find(x=>x.name==="Cloudflare");process.stdout.write(c?c.latestProfile.status:"__MISSING__")})')
[ "$CF_STATUS" = "completed" ] && ok "Cloudflare profile completed" || bad "Cloudflare profile status = $CF_STATUS"

CF_TECH_SCAN=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors.find(x=>x.name==="Cloudflare");process.stdout.write(String(!!c.latestProfile.techScanId))})')
[ "$CF_TECH_SCAN" = "true" ] && ok "Cloudflare profile references a TechStackScan" || bad "no techScanId on Cloudflare profile"

CF_AEO=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors.find(x=>x.name==="Cloudflare");process.stdout.write(c.latestProfile.aeoStatus)})')
[ "$CF_AEO" = "unknown" ] && ok "AEO attachment honestly 'unknown' (no AeoAudit exists for this project)" || bad "aeoStatus = $CF_AEO"

CF_SERP=$(echo "$D1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors.find(x=>x.name==="Cloudflare");process.stdout.write(c.latestProfile.serpStatus)})')
[ "$CF_SERP" = "unknown" ] && ok "SERP attachment honestly 'unknown' (no SerpTracker exists for this project)" || bad "serpStatus = $CF_SERP"

# --- 3. a second discover call merges in a manual, domain-less competitor --
D2=$(curl -s -X POST "$API/projects/$PID/competitors/discover" "${AUTH[@]}" -H 'content-type: application/json' -d '{"competitors":[{"name":"NameOnly Co"}]}')
[ "$(echo "$D2" | jget totalCompetitors)" = "3" ] && ok "third competitor merged in" || bad "totalCompetitors = $(echo "$D2" | jget totalCompetitors)"
[ "$(echo "$D2" | jget promoted)" = "1" ] && ok "promoted count = 1 (only the new one)" || bad "promoted = $(echo "$D2" | jget promoted)"

NO_STATUS=$(echo "$D2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors.find(x=>x.name==="NameOnly Co");process.stdout.write(c?c.latestProfile.status:"__MISSING__")})')
[ "$NO_STATUS" = "skipped" ] && ok "domain-less competitor -> profile status 'skipped' (no crash)" || bad "NameOnly Co status = $NO_STATUS"

# --- 4. GET list reflects all three, each with a latest profile ------------
LIST=$(curl -s "$API/projects/$PID/competitors/profiles" "${AUTH[@]}")
[ "$(echo "$LIST" | jlen competitors)" = "3" ] && ok "list returns all 3 competitors" || bad "list length = $(echo "$LIST" | jlen competitors)"
ALL_HAVE_PROFILE=$(echo "$LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).competitors;process.stdout.write(String(c.every(x=>x.latestProfile!==null)))})')
[ "$ALL_HAVE_PROFILE" = "true" ] && ok "every competitor has a latest profile" || bad "some competitor has no profile"

# --- 5. GET gap: client's own (unresolvable) domain fails honestly, so every
#        competitor tech signature should land under competitorsOnly --------
GAP=$(curl -s "$API/projects/$PID/competitors/gap" "${AUTH[@]}")
[ "$(echo "$GAP" | jlen tech.client)" = "0" ] && ok "client tech is empty (its own domain doesn't resolve)" || bad "client tech = $(echo "$GAP" | jget tech.client)"
CF_IN_GAP=$(echo "$GAP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const lines=JSON.parse(s).tech.competitorsOnly;process.stdout.write(String(lines.some(l=>/cdn/i.test(l.key)&&l.competitors.includes("Cloudflare"))))})')
[ "$CF_IN_GAP" = "true" ] && ok "Cloudflare's CDN signature shows up under competitorsOnly" || bad "no Cloudflare CDN entry in competitorsOnly (site markup or infra may have changed)"
[ "$(echo "$GAP" | jlen competitors)" = "3" ] && ok "gap lists all 3 competitors' attached SERP/AEO status" || bad "gap competitors length = $(echo "$GAP" | jlen competitors)"
[ -n "$(echo "$GAP" | jget note)" ] && ok "gap carries an honesty note (not a scored verdict)" || bad "no note on gap response"

# --- 6. ownership ------------------------------------------------------------
SC=$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/does-not-exist/competitors/gap" "${AUTH[@]}")
[ "$SC" = "404" ] && ok "unknown project -> 404" || bad "unknown project -> $SC"

echo
echo "== competitors: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

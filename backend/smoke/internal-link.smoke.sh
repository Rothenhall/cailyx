#!/usr/bin/env bash
# E2E smoke — internal-link module (Agent #8). Offline fixture site
# (INTERNAL_LINK_ALLOW_FIXTURE=1). No network, no API keys.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "== internal-link smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got access token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

PROJ=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"name\":\"Acme AI Visibility\",\"domain\":\"acme-link-smoke-$RANDOM.example\",\"category\":\"AI visibility diagnostics\"}")
PID=$(echo "$PROJ" | jget id)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "created project $PID" || { bad "project create"; echo "$PROJ"; exit 1; }
cleanup() { curl -s -X DELETE "$API/projects/$PID" "${AUTH[@]}" >/dev/null 2>&1; echo "(smoke project deleted)"; }
trap cleanup EXIT

# --- analyze the fixture site -------------------------------------------
G=$(curl -s -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rootUrl":"fixture://demo","maxPages":20,"maxDepth":3}')
GID=$(echo "$G" | jget id)
[ -n "$GID" ] && [ "$GID" != "__ERR__" ] && ok "ran link-graph analysis $GID" || { bad "analyze"; echo "$G"; exit 1; }
[ "$(echo "$G" | jget status)" = "complete" ] && ok "status = complete" || bad "status = $(echo "$G" | jget status)"
[ "$(echo "$G" | jget source)" = "fixture" ] && ok "source = fixture" || bad "source wrong"

PAGES=$(echo "$G" | jget pagesCrawled)
[ "$PAGES" = "6" ] && ok "crawled all 6 fixture pages (incl. sitemap-seeded orphan)" || bad "pagesCrawled = $PAGES (expected 6)"
[ "$(echo "$G" | jlen nodes)" = "6" ] && ok "6 nodes persisted" || bad "nodes=$(echo "$G" | jlen nodes)"
EDGES=$(echo "$G" | jget edgeCount)
[ "$EDGES" -ge 6 ] 2>/dev/null && ok "internal edges captured ($EDGES)" || bad "edgeCount = $EDGES"

# --- orphan detection: /blog/2026-ai-search-study has no inbound links --
ORPHANS=$(echo "$G" | jget orphanCount)
[ "$ORPHANS" = "1" ] && ok "exactly 1 orphan detected" || bad "orphanCount = $ORPHANS (expected 1)"
ORPHAN_PATH=$(echo "$G" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).nodes.find(x=>x.isOrphan);process.stdout.write(n?n.path:"")})')
[ "$ORPHAN_PATH" = "/blog/2026-ai-search-study" ] && ok "orphan is the blog study page" || bad "orphan = $ORPHAN_PATH"

# --- node metrics: keywords + inbound counts --------------------------
KW=$(echo "$G" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).nodes.find(x=>x.path==="/guides/ai-visibility");process.stdout.write(JSON.parse(n.topicKeywords).join(","))})')
echo "$KW" | grep -q "visibility" && ok "topic keywords extracted (/guides/ai-visibility → $KW)" || bad "keywords missing 'visibility': $KW"
HOME_OUT=$(echo "$G" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).nodes.find(x=>x.path==="/");process.stdout.write(String(n.outboundCount))})')
[ "$HOME_OUT" -ge 4 ] 2>/dev/null && ok "home page outbound count = $HOME_OUT" || bad "home outbound = $HOME_OUT"

# --- recommendations: orphan + under-linked pages get suggested links --
RECS=$(curl -s "$API/projects/$PID/link-graph/$GID/recommendations" "${AUTH[@]}")
RN=$(echo "$RECS" | jlen)
[ "$RN" -ge 1 ] 2>/dev/null && ok "generated $RN link recommendation(s)" || { bad "no recommendations"; echo "$RECS"; }
# the orphan must be a recommendation target
echo "$RECS" | grep -q '/blog/2026-ai-search-study' && ok "orphan page is a recommendation target" || bad "orphan not recommended"
# every rec: overlap >= threshold, has anchor + reason, priority int
BADREC=$(echo "$RECS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const bad=r.filter(x=>!(x.topicOverlap>=0.12&&x.suggestedAnchor&&x.reason&&Number.isInteger(x.priority)&&x.fromPath!==x.toPath));process.stdout.write(String(bad.length))})')
[ "$BADREC" = "0" ] && ok "every recommendation is well-formed (overlap, anchor, reason, priority)" || bad "$BADREC malformed recs"
# recs sorted by priority desc
SORTED=$(echo "$RECS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).map(x=>x.priority);process.stdout.write(String(p.every((v,i)=>i===0||p[i-1]>=v)))})')
[ "$SORTED" = "true" ] && ok "recommendations sorted by priority desc" || bad "recs not sorted"
# no rec duplicates an existing edge
DUP=$(echo "$G" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const g=JSON.parse(s);const E=new Set(g.edges.map(e=>e.fromPath+" "+e.toPath));const d=g.recommendations.filter(r=>E.has(r.fromPath+" "+r.toPath));process.stdout.write(String(d.length))})')
[ "$DUP" = "0" ] && ok "no recommendation duplicates an existing link" || bad "$DUP recs duplicate edges"

# --- recommendation lifecycle ---------------------------------------
RID=$(echo "$RECS" | jget 0.id)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PID/link-graph/$GID/recommendations/$RID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"status":"applied"}')" = "200" ] && ok "PATCH recommendation → applied" || bad "patch rec failed"
[ "$(curl -s "$API/projects/$PID/link-graph/$GID/recommendations?status=applied" "${AUTH[@]}" | jlen)" = "1" ] && ok "status filter returns the applied rec" || bad "status filter wrong"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PID/link-graph/$GID/recommendations/$RID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"status":"bogus"}')" = "400" ] && ok "invalid status → 400" || bad "bad status not 400"

# --- guards ---------------------------------------------------------
# fixture root requires the flag: we can't unset it here, so assert the happy path only,
# and assert useLlm without key → 503
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rootUrl":"fixture://demo","useLlm":true}')" = "503" ] && ok "useLlm without ANTHROPIC_API_KEY → 503" || bad "useLlm not 503"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"maxPages":9999}')" = "400" ] && ok "maxPages out of range → 400" || bad "maxPages not validated"

# --- determinism: re-run → identical graph shape --------------------
G2=$(curl -s -X POST "$API/projects/$PID/link-graph" "${AUTH[@]}" -H 'content-type: application/json' -d '{"rootUrl":"fixture://demo","maxPages":20,"maxDepth":3}')
[ "$(echo "$G2" | jget pagesCrawled)" = "$PAGES" ] && [ "$(echo "$G2" | jget orphanCount)" = "$ORPHANS" ] && [ "$(echo "$G2" | jget recommendationCount)" = "$RN" ] && ok "re-run is deterministic (same pages/orphans/recs)" || bad "re-run differs"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

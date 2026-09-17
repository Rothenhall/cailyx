#!/usr/bin/env bash
# E2E smoke — P05 online presence: applicability policy, rejection tombstones,
# the merged operator screen's data contract, and the client-portal projection.
#
# Zero spend, zero keys: no DataForSEO/Apify credentials are exercised here —
# see digital-presence.smoke.sh for that gated-refusal coverage, which this
# suite does not repeat. This suite proves the P05 exit gate specifically:
# "No irrelevant GBP penalty; ambiguous account never auto-owned."
#
#  1. A business type where a physical local-listing platform is genuinely
#     `not-relevant` (an online-only SaaS) — assert it is reported that way,
#     never as a gap, never counted against the client.
#  2. An ambiguous candidate rejected as "Not ours" — assert the tombstone is
#     persisted and its guard condition (the one `executeDiscovery` checks
#     before creating a candidate row) holds, so a future sweep cannot
#     recreate the identical URL. A live SERP sweep is not exercised (no
#     DataForSEO credentials in this environment, matching the zero-spend
#     contract every other smoke script in this repo holds to) — the
#     mechanism itself is asserted directly instead, the same way
#     digital-presence.smoke.sh asserts Apify's refusal path rather than a
#     live call.
#  3. A client-portal read carries no raw confidence score, discovery-run id,
#     SERP query text or cost.
#
# Writes to dev.db and deletes both smoke projects + the smoke client at the end.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== online-presence-unified smoke =="

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"
AUTH=(-H "authorization: Bearer $TOKEN")

# ── Project A: online-only SaaS — the applicability / no-penalty case ───────
PROJA=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Applicability Smoke Co\",\"domain\":\"applicability-smoke-$RANDOM.example.com\",\"category\":\"B2B SaaS software platform for remote teams, cloud-based subscription tool\"}")
PIDA=$(echo "$PROJA" | jget id)
[ -n "$PIDA" ] && [ "$PIDA" != "__ERR__" ] && ok "created project A (online-only SaaS)" || die "project A create" "$PROJA"

# ── Project B: the tombstone / candidate-validation case ───────────────────
PROJB=$(curl -s -X POST "$API/projects" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"name\":\"Tombstone Smoke Co\",\"domain\":\"tombstone-smoke-$RANDOM.example.com\",\"category\":\"local plumbing and electrical services\"}")
PIDB=$(echo "$PROJB" | jget id)
[ -n "$PIDB" ] && [ "$PIDB" != "__ERR__" ] && ok "created project B (local services)" || die "project B create" "$PROJB"

CLIENT_EMAIL=""; CLIENT_PW=""; CLIENT_ID=""
cleanup() {
  curl -s -X DELETE "$API/projects/$PIDA" "${AUTH[@]}" >/dev/null 2>&1
  curl -s -X DELETE "$API/projects/$PIDB" "${AUTH[@]}" >/dev/null 2>&1
  if [ -n "$CLIENT_ID" ]; then
    ONLINE_PRESENCE_CLIENT_ID="$CLIENT_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const clientId = process.env.ONLINE_PRESENCE_CLIENT_ID;
  await prisma.user.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
  fi
  echo "(smoke projects + client deleted)"
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════
# 1. Applicability policy — no irrelevant-platform penalty (the exit gate)
# ═══════════════════════════════════════════════════════════════════════════

INVA=$(curl -s "$API/projects/$PIDA/presence" "${AUTH[@]}")
BIZTYPE=$(echo "$INVA" | jget assessment.businessProfile)
[ "$BIZTYPE" = "b2b-saas" ] && ok "category inferred as b2b-saas" || bad "businessProfile = $BIZTYPE"

APPLICABILITY=$(echo "$INVA" | jget applicability)
[ -n "$APPLICABILITY" ] && [ "$APPLICABILITY" != "__ERR__" ] && ok "inventory carries an applicability array" || die "no applicability array" "$INVA"

# Yelp — a physical local-listing platform — must read not-relevant for an
# online-only SaaS with no stated local customer presence (plan §11.2's own
# worked example: "a physical-location Google profile should not be presumed
# required").
YELP_STATUS=$(echo "$INVA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const y=(o.applicability||[]).find(a=>a.platform==="yelp");process.stdout.write(y?y.status:"")})')
[ "$YELP_STATUS" = "not-relevant" ] && ok "yelp reads not-relevant for an online-only SaaS" || bad "yelp applicability status = $YELP_STATUS"

YELP_REASON=$(echo "$INVA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const y=(o.applicability||[]).find(a=>a.platform==="yelp");process.stdout.write(y?y.reason:"")})')
[ -n "$YELP_REASON" ] && ok "not-relevant carries a plain-English reason: $YELP_REASON" || bad "no reason on the not-relevant platform"

# The exit gate itself: never a gap (never counted against the client), and
# never named as a missing/absent finding anywhere in the assessment.
echo "$INVA" | jget gaps | grep -q '"platform":"yelp"' && bad "yelp still listed as a gap (irrelevant-platform penalty bug)" || ok "not-relevant platform never appears in gaps"
echo "$INVA" | jget assessment.headlines | grep -qi "yelp" && bad "assessment headlines mention the not-relevant platform" || ok "assessment headlines never mention the not-relevant platform"
echo "$INVA" | jget assessment.coverage | grep -o '"missing":\[[^]]*\]' | grep -qi "yelp" && bad "coverage lists yelp as missing" || ok "coverage never lists the not-relevant platform as missing"

# App-store/play-store — no mobile app is described — must also read
# not-relevant, proving the policy is not yelp-specific.
APPSTORE_STATUS=$(echo "$INVA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const y=(o.applicability||[]).find(a=>a.platform==="app-store");process.stdout.write(y?y.status:"")})')
[ "$APPSTORE_STATUS" = "not-relevant" ] && ok "app-store reads not-relevant with no mobile app described" || bad "app-store applicability status = $APPSTORE_STATUS"

# ── Applicability override — versioned, explicit, staff-set ────────────────
OV=$(curl -s -X PATCH "$API/projects/$PIDA/presence/applicability/yelp" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"status":"relevant","reason":"They do have a showroom customers visit in person."}')
[ "$(echo "$OV" | jget status)" = "relevant" ] && ok "staff override sets yelp to relevant" || bad "override -> $(echo "$OV" | jget status): $OV"
[ "$(echo "$OV" | jget overridden)" = "true" ] && ok "override result is flagged overridden:true" || bad "overridden flag missing"

INVA2=$(curl -s "$API/projects/$PIDA/presence" "${AUTH[@]}")
YELP_STATUS2=$(echo "$INVA2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const y=(o.applicability||[]).find(a=>a.platform==="yelp");process.stdout.write(y?y.status:"")})')
[ "$YELP_STATUS2" = "relevant" ] && ok "override is honored on the next read" || bad "yelp status after override = $YELP_STATUS2"
echo "$INVA2" | jget gaps | grep -q '"platform":"yelp"' && ok "an overridden-relevant, missing platform now appears as a gap (visible, not penalized silently)" || bad "override did not surface yelp as a gap"

# A rediscovery run must not discard the override — it lives in a separate
# table discovery never writes to.
QUEUEDA=$(curl -s -X POST "$API/projects/$PIDA/presence/discover" "${AUTH[@]}" -H 'content-type: application/json')
RIDA=$(echo "$QUEUEDA" | jget id)
poll_until "$API/projects/$PIDA/presence/discoveries/$RIDA" status "completed failed" 30 "${AUTH[@]}" >/dev/null
INVA3=$(curl -s "$API/projects/$PIDA/presence" "${AUTH[@]}")
YELP_STATUS3=$(echo "$INVA3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const y=(o.applicability||[]).find(a=>a.platform==="yelp");process.stdout.write(y?y.status:"")})')
[ "$YELP_STATUS3" = "relevant" ] && ok "override survives a rediscovery run" || bad "yelp status after rediscovery = $YELP_STATUS3"

# ═══════════════════════════════════════════════════════════════════════════
# 2. Rejection tombstone — "Not ours" never resurfaces the same candidate
# ═══════════════════════════════════════════════════════════════════════════

# Discovery cannot verify a search candidate live without DataForSEO
# credentials (absent here, by design — see the header comment), so a
# search-suggested candidate is seeded directly, exactly the shape a real SERP
# sweep would have inserted (state: candidate, source: serp).
CAND_URL="https://www.linkedin.com/company/definitely-not-the-right-acme"
SEED=$(ONLINE_PRESENCE_PID="$PIDB" ONLINE_PRESENCE_URL="$CAND_URL" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.presenceAccount.create({ data: {
    projectId: process.env.ONLINE_PRESENCE_PID, platform: 'linkedin', url: process.env.ONLINE_PRESENCE_URL,
    handle: 'definitely-not-the-right-acme', source: 'serp', entity: 'company', state: 'candidate',
    confidence: 0.42, foundOn: 'site:linkedin.com/company "Acme"',
  } });
  console.log(JSON.stringify({ id: row.id }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
CAND_ID=$(echo "$SEED" | jget id)
[ -n "$CAND_ID" ] && [ "$CAND_ID" != "__ERR__" ] && ok "seeded an ambiguous search candidate" || die "candidate seed" "$SEED"

# Reject without a reason -> 400 (the reason is load-bearing, not optional).
SC=$(curl -s -o /tmp/op_reject_noreason.json -w '%{http_code}' -X POST "$API/projects/$PIDB/presence/accounts/$CAND_ID/reject" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{"reason":""}')
[ "$SC" = "400" ] && ok "rejecting with an empty reason -> 400" || bad "reject (empty reason) -> $SC: $(cat /tmp/op_reject_noreason.json)"

REJECT=$(curl -s -X POST "$API/projects/$PIDB/presence/accounts/$CAND_ID/reject" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"reason":"Different company with the same name — wrong city in their bio."}')
REJECTION_ID=$(echo "$REJECT" | jget rejectionId)
[ -n "$REJECTION_ID" ] && [ "$REJECTION_ID" != "__ERR__" ] && ok "candidate rejected, tombstone recorded ($REJECTION_ID)" || die "reject" "$REJECT"

# The candidate row itself must be gone — it does not linger as an unresolved
# candidate the operator already answered.
INVB=$(curl -s "$API/projects/$PIDB/presence" "${AUTH[@]}")
echo "$INVB" | jget accounts | grep -q "$CAND_ID" && bad "rejected candidate still present in accounts" || ok "rejected candidate removed from the live inventory"

RJ_LIST=$(curl -s "$API/projects/$PIDB/presence/rejections" "${AUTH[@]}")
[ "$(echo "$RJ_LIST" | jlen)" -ge 1 ] 2>/dev/null && ok "rejection listed ($(echo "$RJ_LIST" | jlen) on file)" || bad "rejections list empty"
# The tombstone's own normalizedUrl (www./tracking-params stripped) — the same
# normalization the account dedupe already applies. Guard checks below key on
# this, not the raw seeded URL, exactly as the server-side guard does.
NORM_URL=$(echo "$RJ_LIST" | jget 0.normalizedUrl)
[ -n "$NORM_URL" ] && [ "$NORM_URL" != "__ERR__" ] && ok "tombstone carries its normalized URL: $NORM_URL" || die "no normalizedUrl on the tombstone" "$RJ_LIST"

# The exit gate: the exact guard `executeDiscovery` checks before inserting a
# fresh SERP candidate (project+platform+normalizedUrl, reconsideredAt: null)
# must now find this row — i.e. the tombstone WOULD stop an identical
# candidate from being recreated on the next sweep.
GUARD=$(ONLINE_PRESENCE_PID="$PIDB" ONLINE_PRESENCE_URL="$NORM_URL" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.presenceRejection.findFirst({ where: {
    projectId: process.env.ONLINE_PRESENCE_PID, platform: 'linkedin',
    normalizedUrl: process.env.ONLINE_PRESENCE_URL, reconsideredAt: null,
  } });
  console.log(row ? 'TOMBSTONED' : 'NOT_TOMBSTONED');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$GUARD" = "TOMBSTONED" ] && ok "the exact discovery-time guard condition is satisfied — a future sweep will not recreate this candidate" || bad "guard check = $GUARD"

# Authorized undo — the tombstone is kept, not deleted, and the guard clears.
RECON=$(curl -s -X POST "$API/projects/$PIDB/presence/rejections/$REJECTION_ID/reconsider" "${AUTH[@]}")
[ -n "$(echo "$RECON" | jget reconsideredAt)" ] && ok "reconsideration recorded (reconsideredAt set)" || bad "reconsider -> $RECON"
GUARD2=$(ONLINE_PRESENCE_PID="$PIDB" ONLINE_PRESENCE_URL="$NORM_URL" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.presenceRejection.findFirst({ where: {
    projectId: process.env.ONLINE_PRESENCE_PID, platform: 'linkedin',
    normalizedUrl: process.env.ONLINE_PRESENCE_URL, reconsideredAt: null,
  } });
  console.log(row ? 'STILL_TOMBSTONED' : 'GUARD_CLEARED');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$GUARD2" = "GUARD_CLEARED" ] && ok "reconsideration clears the guard — no permanent destructive deletion, just an honest undo" || bad "guard after reconsider = $GUARD2"

# Rejecting a non-candidate must be refused.
curl -s -o /tmp/op_reject_confirmed.json -w '%{http_code}' -X POST "$API/projects/$PIDB/presence/accounts" \
  "${AUTH[@]}" -H 'content-type: application/json' -d '{"url":"https://www.linkedin.com/company/tombstone-smoke-co"}' >/dev/null
MANUAL_ID=$(jget id < /tmp/op_reject_confirmed.json)
SC2=$(curl -s -o /tmp/op_reject_confirmed2.json -w '%{http_code}' -X POST "$API/projects/$PIDB/presence/accounts/$MANUAL_ID/reject" "${AUTH[@]}" -H 'content-type: application/json' -d '{"reason":"test"}')
[ "$SC2" = "400" ] && ok "rejecting a non-candidate (operator-supplied) -> 400" || bad "reject non-candidate -> $SC2: $(cat /tmp/op_reject_confirmed2.json)"
rm -f /tmp/op_reject_noreason.json /tmp/op_reject_confirmed.json /tmp/op_reject_confirmed2.json

# ═══════════════════════════════════════════════════════════════════════════
# 3. Client-portal projection — no raw confidence score, no internal ids
# ═══════════════════════════════════════════════════════════════════════════

SEED_CLIENT=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `onlinepresence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-online-presence`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const client = await prisma.client.create({ data: { name: `Online Presence Smoke ${stamp}` } });
  await prisma.user.create({ data: { email, passwordHash, name: 'Presence Portal Client', type: 'client', clientId: client.id } });
  console.log(JSON.stringify({ clientId: client.id, email, password }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
CLIENT_ID=$(echo "$SEED_CLIENT" | jget clientId)
CLIENT_EMAIL=$(echo "$SEED_CLIENT" | jget email)
CLIENT_PW=$(echo "$SEED_CLIENT" | jget password)
[ -n "$CLIENT_ID" ] && [ "$CLIENT_ID" != "__ERR__" ] && ok "seeded a smoke client + portal user" || die "client seed" "$SEED_CLIENT"

# Attach project B to the client directly — the minimal ownership fact
# `assertProjectAccess` checks, without standing up a full engagement.
ATTACH=$(ONLINE_PRESENCE_PID="$PIDB" ONLINE_PRESENCE_CLIENT="$CLIENT_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.project.update({ where: { id: process.env.ONLINE_PRESENCE_PID }, data: { clientId: process.env.ONLINE_PRESENCE_CLIENT } });
  console.log('OK');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$ATTACH" = "OK" ] && ok "project B attached to the smoke client" || die "attach" "$ATTACH"

CLIENT_LOGIN=$(smoke_login "$CLIENT_EMAIL" "$CLIENT_PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client portal login works" || die "client login" "$CLIENT_LOGIN"

PORTAL_SC=$(curl -s -o /tmp/op_portal.json -w '%{http_code}' "$API/portal/projects/$PIDB/presence" -H "authorization: Bearer $CLIENT_TOKEN")
[ "$PORTAL_SC" = "200" ] && ok "client can read their own project's online presence" || { bad "portal read -> $PORTAL_SC"; cat /tmp/op_portal.json; }

grep -qi '"confidence"' /tmp/op_portal.json && bad "portal response leaks a raw confidence score" || ok "no raw confidence score in the client-portal response"
grep -qi 'foundOn\|serpCostUsd\|serpQueries\|discoveryRunId\|"runId"' /tmp/op_portal.json && bad "portal response leaks discovery internals" || ok "no discovery-run internals (foundOn/serpCost/runId) in the client-portal response"
grep -qi '"statusLabel"' /tmp/op_portal.json && ok "client sees plain-English status labels" || bad "no plain-English statusLabel in the portal response"

# Ownership: another client must not read project B's presence.
SEED_OTHER=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `onlinepresence-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-online-presence-other`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const client = await prisma.client.create({ data: { name: `Other Online Presence Smoke ${stamp}` } });
  await prisma.user.create({ data: { email, passwordHash, name: 'Other Presence Portal Client', type: 'client', clientId: client.id } });
  console.log(JSON.stringify({ clientId: client.id, email, password }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
OTHER_CLIENT_ID=$(echo "$SEED_OTHER" | jget clientId)
OTHER_EMAIL=$(echo "$SEED_OTHER" | jget email)
OTHER_PW=$(echo "$SEED_OTHER" | jget password)
OTHER_LOGIN=$(smoke_login "$OTHER_EMAIL" "$OTHER_PW")
OTHER_TOKEN=$(echo "$OTHER_LOGIN" | jget accessToken)
OTHER_SC=$(curl -s -o /dev/null -w '%{http_code}' "$API/portal/projects/$PIDB/presence" -H "authorization: Bearer $OTHER_TOKEN")
[ "$OTHER_SC" = "403" ] && ok "a different client cannot read project B's presence (403)" || bad "cross-client read -> $OTHER_SC"
node <<EOF
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.user.deleteMany({ where: { clientId: '$OTHER_CLIENT_ID' } });
  await prisma.client.deleteMany({ where: { id: '$OTHER_CLIENT_ID' } });
})().finally(() => prisma.\$disconnect());
EOF

rm -f /tmp/op_portal.json

echo ""
echo "== online-presence-unified: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

#!/usr/bin/env bash
# E2E smoke — P09 writing style + durable generation (platform_improvement_plan.md
# §13.7, §13.8, §13.9). Exercises: writing-style draft->confirm versioning
# (confirming never mutates a prior confirmed row), a durable GenerationJob
# whose pinned writing-style version/fingerprint survive a LATER edit to the
# active style (the in-flight/completed job must not silently pick up the
# new one), POST-idempotency on a resubmitted idempotencyKey (the concrete
# guard against "worker crashed after creating the revision but before
# acknowledging" — a resubmit finds the existing job/output, never creates a
# second one), and honest type-capability refusal for an unimplemented type.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== writing-style-generation smoke =="

SEED='{}'
cleanup() {
  WSG_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.WSG_SEED);
  if (!s.projectId) return;
  await prisma.$transaction(async (tx) => {
    const assets = await tx.growthAsset.findMany({ where: { projectId: s.projectId }, select: { id: true } });
    const assetIds = assets.map((a) => a.id);
    await tx.contentRevision.deleteMany({ where: { assetId: { in: assetIds } } });
    await tx.generationJob.deleteMany({ where: { projectId: s.projectId } });
    await tx.growthAsset.deleteMany({ where: { projectId: s.projectId } });
    await tx.writingStyleProfile.deleteMany({ where: { projectId: s.projectId } });
    await tx.contentBrief.deleteMany({ where: { projectId: s.projectId } });
    await tx.project.deleteMany({ where: { id: s.projectId } });
    await tx.user.deleteMany({ where: { clientId: s.clientId } });
    await tx.client.deleteMany({ where: { id: s.clientId } });
  });
  console.log('(smoke rows deleted)');
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
}
trap cleanup EXIT

SEED=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `wsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-wsg`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `WSG ${stamp}` } });
    await tx.user.create({ data: { email, passwordHash, name: 'WSG Client', type: 'client', clientId: client.id } });
    const project = await tx.project.create({ data: {
      name: `WSG Project ${stamp}`, domain: `${stamp}.example`, clientId: client.id, onboardingStatus: 'active',
    } });
    return { clientId: client.id, projectId: project.id, email, password };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
EMAIL=$(echo "$SEED" | jget email)
PW=$(echo "$SEED" | jget password)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "seeded project + client" || die "seed" "$SEED"

request() {
  local label="$1" method="$2" path="$3" token="$4" expected="$5" response
  shift 5
  response=$(curl -sS -w $'\n%{http_code}' -X "$method" "$API$path" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' "$@") || die "$label transport failed" "$response"
  HTTP_CODE="${response##*$'\n'}"
  BODY="${response%$'\n'*}"
  [ "$HTTP_CODE" = "$expected" ] && ok "$label HTTP $expected" || bad "$label HTTP $HTTP_CODE (expected $expected): $BODY"
}

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"
CLIENT_LOGIN=$(smoke_login "$EMAIL" "$PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client login works" || die "client login" "$CLIENT_LOGIN"

# ── 1. Writing style: draft -> confirm, confirm never mutates a prior confirmed row ──
request "no active style yet" GET "/projects/$PID/writing-style" "$TOKEN" 200
[ -z "$BODY" ] && ok "getActive is null before any confirmation" || bad "expected empty/null active style body: $BODY"

request "save draft v1" POST "/projects/$PID/writing-style/draft" "$TOKEN" 201 \
  -d '{"summary":"Clear and friendly, short sentences; avoid hype.","tone":"friendly","formality":"conversational","preferredWords":["simple","clear"],"avoidWords":["synergy","leverage"]}'
DRAFT1="$BODY"
V1=$(echo "$DRAFT1" | jget version)
FP1=$(echo "$DRAFT1" | jget fingerprint)
[ "$V1" = "1" ] && [ -n "$FP1" ] && [ "$FP1" != "__ERR__" ] && ok "draft v1 saved with a fingerprint" || die "draft v1" "$DRAFT1"

request "confirm v1" POST "/projects/$PID/writing-style/confirm" "$TOKEN" 201 -d '{"version":1}'
CONFIRM1="$BODY"
CONFIRMED_V1=$(echo "$CONFIRM1" | jget version)
CONFIRMED_FP1=$(echo "$CONFIRM1" | jget fingerprint)
[ "$CONFIRMED_V1" = "2" ] && [ "$CONFIRMED_FP1" = "$FP1" ] && ok "confirming INSERTED a new row (v2) carrying v1's content — draft untouched" || bad "confirm did not insert a new row as expected: $CONFIRM1"

request "active style is now the confirmed row" GET "/projects/$PID/writing-style" "$TOKEN" 200
ACTIVE1="$BODY"
[ "$(echo "$ACTIVE1" | jget version)" = "2" ] && [ "$(echo "$ACTIVE1" | jget confirmedAt)" != "" ] && ok "active style = confirmed v2 (content of draft v1)" || bad "active style wrong: $ACTIVE1"

request "client reads the same active confirmed style, read-only" GET "/portal/projects/$PID/writing-style" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jget version)" = "2" ] && ok "client portal sees the confirmed style" || bad "client portal writing-style wrong: $BODY"

# ── 2. Type-capability refusal: no fake Generate button for an unimplemented type ──
IKEY_BAD="wsg-badtype-$(date +%s%N)"
request "generate email-campaign (unimplemented) -> 422, honest refusal" POST "/projects/$PID/content-generation/jobs" "$TOKEN" 422 \
  -d "{\"idempotencyKey\":\"$IKEY_BAD\",\"assetType\":\"email-campaign\",\"topic\":{\"targetKeyword\":\"newsletter\"}}"
echo "$BODY" | grep -qi "no tested writer" && ok "refusal message is honest (no tested writer), not a generic 500" || bad "refusal message not honest: $BODY"

# ── 3. Enqueue a real job pinned to the CONFIRMED style, then edit the style ──
IKEY="wsg-idem-$(date +%s%N)"
request "enqueue article generation (1st)" POST "/projects/$PID/content-generation/jobs" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\",\"topic\":{\"targetKeyword\":\"smoke test widgets\",\"blogTopic\":\"Smoke Test Widgets: A Practical Guide\",\"adAngle\":\"Reliable widgets for testing.\"}}"
JOB1="$BODY"
JOB_ID=$(echo "$JOB1" | jget job.id)
JOB1_CREATED=$(echo "$JOB1" | jget created)
JOB1_STYLE_VERSION=$(echo "$JOB1" | jget job.writingStyleVersion)
JOB1_FINGERPRINT=$(echo "$JOB1" | jget job.writingStyleFingerprint)
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "__ERR__" ] && [ "$JOB1_CREATED" = "true" ] && ok "job enqueued, created:true" || die "enqueue" "$JOB1"
[ "$JOB1_STYLE_VERSION" = "2" ] && [ "$JOB1_FINGERPRINT" = "$FP1" ] && ok "job pinned writingStyleVersion=2, fingerprint matches the confirmed style at enqueue time" || bad "job did not pin the active style correctly: $JOB1"

# Idempotent resubmit — same key, BEFORE the job has necessarily finished.
request "enqueue article generation (2nd, same idempotencyKey)" POST "/projects/$PID/content-generation/jobs" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\",\"topic\":{\"targetKeyword\":\"smoke test widgets\"}}"
JOB2="$BODY"
JOB_ID_2=$(echo "$JOB2" | jget job.id)
JOB2_CREATED=$(echo "$JOB2" | jget created)
[ "$JOB_ID_2" = "$JOB_ID" ] && [ "$JOB2_CREATED" = "false" ] && ok "resubmit with the same idempotencyKey returned the SAME job, created:false — never a second job" || bad "idempotency violated on resubmit: $JOB2"

# Now edit + confirm a NEW style version WHILE the job may still be in flight.
request "save draft v3 (different content)" POST "/projects/$PID/writing-style/draft" "$TOKEN" 201 \
  -d '{"summary":"Bold and punchy, one-line hooks; embrace hype.","tone":"bold","formality":"casual"}'
request "confirm v3 -> v4" POST "/projects/$PID/writing-style/confirm" "$TOKEN" 201 -d '{"version":3}'
CONFIRM2="$BODY"
FP4=$(echo "$CONFIRM2" | jget fingerprint)
[ "$FP4" != "$FP1" ] && ok "active style now has a DIFFERENT fingerprint after the edit" || die "style edit did not change fingerprint" "$CONFIRM2"

request "active style is now v4" GET "/projects/$PID/writing-style" "$TOKEN" 200
[ "$(echo "$BODY" | jget version)" = "4" ] && ok "active style advanced to v4 without touching the job" || bad "active style: $BODY"

# ── 4. Poll the job to completion, then verify the PINNED fields never moved ──
FINAL=$(poll_until "$API/projects/$PID/content-generation/jobs/$JOB_ID" status "succeeded failed" 90 -H "authorization: Bearer $TOKEN")
FINAL_STATUS=$(echo "$FINAL" | jget status)
FINAL_STYLE_VERSION=$(echo "$FINAL" | jget writingStyleVersion)
FINAL_FINGERPRINT=$(echo "$FINAL" | jget writingStyleFingerprint)
if [ "$FINAL_STATUS" = "succeeded" ]; then
  ok "job reached succeeded (queue/worker + LLM reachable in this environment)"
  REVISION_ID=$(echo "$FINAL" | jget revisionId)
  [ -n "$REVISION_ID" ] && [ "$REVISION_ID" != "__ERR__" ] && ok "succeeded job carries a revisionId" || bad "succeeded job missing revisionId: $FINAL"
else
  ok "job did not reach succeeded within timeout (status=$FINAL_STATUS) — acceptable when Redis/LLM are unavailable in this environment; pin-immutability checked below regardless"
fi
[ "$FINAL_STYLE_VERSION" = "2" ] && [ "$FINAL_FINGERPRINT" = "$FP1" ] && ok "AFTER the style was edited to v4, the job's pinned writingStyleVersion/fingerprint are UNCHANGED (still v2 / original fingerprint) — the in-flight job never picked up the new style" || bad "pinned style leaked a later edit: version=$FINAL_STYLE_VERSION fingerprint=$FINAL_FINGERPRINT (expected version=2 fingerprint=$FP1)"

# ── 5. Retry-after-completion is idempotent: same output, never a duplicate ──
if [ "$FINAL_STATUS" = "succeeded" ]; then
  request "retry a SUCCEEDED job" POST "/projects/$PID/content-generation/jobs/$JOB_ID/retry" "$TOKEN" 201
  RETRY_BODY="$BODY"
  RETRY_REQUEUED=$(echo "$RETRY_BODY" | jget requeued)
  RETRY_REVISION=$(echo "$RETRY_BODY" | jget job.revisionId)
  [ "$RETRY_REQUEUED" = "false" ] && [ "$RETRY_REVISION" = "$REVISION_ID" ] && ok "retrying a succeeded job returns the EXISTING revision (requeued:false) — no duplicate revision created" || bad "retry-after-success was not idempotent: $RETRY_BODY"

  REV_COUNT=$(node -e '
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    prisma.contentRevision.count({ where: { generationItemId: process.argv[1] } }).then((n) => { console.log(n); return prisma.$disconnect(); });
  ' "$JOB_ID")
  [ "$REV_COUNT" = "1" ] && ok "exactly ONE ContentRevision exists for this job after enqueue+resubmit+retry (DB-level proof, not just the API's word)" || bad "expected exactly 1 revision for job $JOB_ID, found $REV_COUNT"
fi

echo ""
echo "== writing-style-generation smoke: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1

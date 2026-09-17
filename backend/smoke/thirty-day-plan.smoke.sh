#!/usr/bin/env bash
# E2E smoke — P11 Commitment (30-day plan) and the needs-your-action queue.
#
# Seeded via Prisma (client/project/engagement/cycle/work items/approval/
# onboarding request/check-result), driven through the real HTTP surface
# (staff + two distinct client accounts), following portal-plan.smoke.sh's
# conventions but kept in its own file/project per the brief.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== thirty-day-plan smoke =="

SEED='{}'
cleanup() {
  P11_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.P11_SEED);
  if (!s.clientId) return;
  await prisma.$transaction(async (tx) => {
    await tx.commitment.deleteMany({ where: { projectId: s.projectId } });
    await tx.checkResult.deleteMany({ where: { projectId: s.projectId } });
    await tx.approvalDecision.deleteMany({ where: { approvalRequestId: { in: s.approvalIds ?? [] } } });
    await tx.approvalRequest.deleteMany({ where: { projectId: s.projectId } });
    await tx.onboardingRequest.deleteMany({ where: { projectId: s.projectId } });
    const items = await tx.workItem.findMany({ where: { projectId: s.projectId }, select: { id: true } });
    const workItemId = { in: items.map((w) => w.id) };
    await tx.acceptanceCheck.deleteMany({ where: { workItemId } });
    await tx.verification.deleteMany({ where: { workItemId } });
    await tx.workItem.deleteMany({ where: { projectId: s.projectId } });
    await tx.cycle.deleteMany({ where: { projectId: s.projectId } });
    await tx.project.deleteMany({ where: { id: s.projectId } });
    const clientId = { in: [s.clientId, s.otherClientId] };
    await tx.engagement.deleteMany({ where: { clientId } });
    await tx.user.deleteMany({ where: { clientId } });
    await tx.client.deleteMany({ where: { id: clientId } });
  });
  console.log('(smoke rows deleted)');
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
}
trap cleanup EXIT

SEED=$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PW="$SMOKE_PW" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `p11-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const otherEmail = `other-${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-p11`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const operator = await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `P11 ${stamp}` } });
    const otherClient = await tx.client.create({ data: { name: `Other P11 ${stamp}` } });
    const user = await tx.user.create({ data: {
      email, passwordHash, name: 'P11 Client', type: 'client', clientId: client.id,
    } });
    await tx.user.create({ data: {
      email: otherEmail, passwordHash, name: 'Other P11 Client', type: 'client', clientId: otherClient.id,
    } });
    const startsOn = new Date('2026-09-01T00:00:00.000Z');
    const endsOn = new Date('2026-09-30T23:59:59.000Z');
    const engagement = await tx.engagement.create({ data: {
      clientId: client.id, name: `P11 engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'UTC', deliveryLead: operator.id,
    } });
    const project = await tx.project.create({ data: {
      name: `P11 Project ${stamp}`, domain: `${stamp}.example`,
      clientId: client.id, engagementId: engagement.id, onboardingStatus: 'pending',
    } });
    const cycle = await tx.cycle.create({ data: {
      projectId: project.id, engagementId: engagement.id, name: 'September commitment',
      startsOn, endsOn, status: 'active', goal: 'P11 cycle',
      committedAt: startsOn, committedBy: operator.id, committedCount: 12,
    } });
    // 10 work items for the countable commitment — only 3 verified.
    const countableIds = [];
    for (let i = 0; i < 10; i++) {
      const w = await tx.workItem.create({ data: {
        projectId: project.id, cycleId: cycle.id, title: `Article ${i + 1}`,
        category: 'build', discipline: 'content', status: i < 3 ? 'verified' : 'active',
        assigneeId: operator.id, createdBy: operator.id, clientVisible: true,
      } });
      countableIds.push(w.id);
    }
    // 2 work items for the outcome commitment — both verified, to prove
    // completion still requires its own metric.
    const outcomeIds = [];
    for (let i = 0; i < 2; i++) {
      const w = await tx.workItem.create({ data: {
        projectId: project.id, cycleId: cycle.id, title: `Outcome task ${i + 1}`,
        category: 'influence', discipline: 'content', status: 'verified',
        assigneeId: operator.id, createdBy: operator.id, clientVisible: true,
      } });
      outcomeIds.push(w.id);
    }
    // A review-task and a delivery-blocker assigned to the operator, for the staff queue.
    const reviewItem = await tx.workItem.create({ data: {
      projectId: project.id, cycleId: cycle.id, title: 'Needs staff review',
      category: 'fix', discipline: 'technical', status: 'review', reviewerId: operator.id,
      assigneeId: operator.id, createdBy: operator.id, clientVisible: false,
    } });
    const blockedItem = await tx.workItem.create({ data: {
      projectId: project.id, cycleId: cycle.id, title: 'Blocked internally',
      category: 'fix', discipline: 'technical', status: 'blocked', reviewerId: operator.id,
      assigneeId: operator.id, createdBy: operator.id, clientVisible: false,
      blockedOn: 'dependency', blockedReason: 'Waiting on another team',
    } });
    // An onboarding request — an eligible client action.
    const onboarding = await tx.onboardingRequest.create({ data: {
      projectId: project.id, kind: 'gsc-access', title: 'Connect Search Console',
      detail: 'Grant access so we can measure visibility.', requestedBy: operator.id, status: 'open',
    } });
    // An audit-finding-style record — must NEVER appear in the action queue.
    await tx.checkResult.create({ data: {
      subjectType: 'page', subjectId: 'P11_AUDIT_FINDING_MARKER', checkKind: 'schema',
      status: 'failed', detail: 'P11_AUDIT_FINDING_MARKER 17 pages have missing descriptions',
      payload: '{}', projectId: project.id, clientId: client.id,
    } });
    return {
      clientId: client.id, otherClientId: otherClient.id, projectId: project.id,
      cycleId: cycle.id, countableIds, outcomeIds, reviewItemId: reviewItem.id,
      blockedItemId: blockedItem.id, onboardingId: onboarding.id, operatorId: operator.id,
      userId: user.id, email, otherEmail, password,
    };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
CYCLE_ID=$(echo "$SEED" | jget cycleId)
OPERATOR_ID=$(echo "$SEED" | jget operatorId)
ONBOARDING_ID=$(echo "$SEED" | jget onboardingId)
EMAIL=$(echo "$SEED" | jget email)
OTHER_EMAIL=$(echo "$SEED" | jget otherEmail)
PW=$(echo "$SEED" | jget password)
COUNTABLE_JSON=$(echo "$SEED" | jget countableIds)
OUTCOME_JSON=$(echo "$SEED" | jget outcomeIds)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "seeded project/cycle/12 work items/onboarding request/audit finding" || die "seed" "$SEED"

request() {
  local label="$1" method="$2" path="$3" token="$4" expected="$5" response
  shift 5
  response=$(curl -sS -w $'\n%{http_code}' -X "$method" "$API$path" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' "$@") || die "$label transport failed" "$response"
  HTTP_CODE="${response##*$'\n'}"
  BODY="${response%$'\n'*}"
  [ "$HTTP_CODE" = "$expected" ] && ok "$label HTTP $expected" || bad "$label HTTP $HTTP_CODE (expected $expected): $BODY"
}
login() {
  # `smoke_login` retries through the /auth/login rate limit. A suite signs in
  # several accounts in quick succession, so one 429 here used to abort the
  # whole run at "client login" — a failure that says nothing about the module
  # under test.
  smoke_login "$1" "$2"
}
CLIENT_LOGIN=$(login "$EMAIL" "$PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client login works" || die "client login" "$CLIENT_LOGIN"
OTHER_LOGIN=$(login "$OTHER_EMAIL" "$PW")
OTHER_TOKEN=$(echo "$OTHER_LOGIN" | jget accessToken)
[ -n "$OTHER_TOKEN" ] && [ "$OTHER_TOKEN" != "__ERR__" ] && ok "other client login works" || die "other client login" "$OTHER_LOGIN"
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"

# ── 1. Countable commitment: verified progress, never a fabricated % ──────
request "create countable commitment" POST "/projects/$PID/commitments" "$TOKEN" 201 \
  -d "{\"cycleId\":\"$CYCLE_ID\",\"title\":\"Publish ten useful articles\",\"reason\":\"Grow organic reach\",\"workstream\":\"content\",\"targetCount\":10,\"targetUnit\":\"articles\",\"linkedWorkItemIds\":$COUNTABLE_JSON}"
COMMIT_A=$(echo "$BODY" | jget id)
[ -n "$COMMIT_A" ] && [ "$COMMIT_A" != "__ERR__" ] && ok "countable commitment created (draft)" || die "create commitment A" "$BODY"
[ "$(echo "$BODY" | jget progress.label)" = "3 of 10 articles" ] && ok "progress reports '3 of 10 articles' from verified work items" || bad "progress label wrong: $(echo "$BODY" | jget progress.label)"
[ "$(echo "$BODY" | jget progress.verifiedCount)" = "3" ] && [ "$(echo "$BODY" | jget progress.targetCount)" = "10" ] && ok "progress carries raw verified/target counts, not a percentage field" || bad "progress counts wrong"

# "agreed" cannot be reached through a bare status PATCH.
request "PATCH status to agreed is refused" PATCH "/projects/$PID/commitments/$COMMIT_A/status" "$TOKEN" 409 -d '{"status":"agreed"}'
# An operator save is not agreement: confirm:false is refused too.
request "propose commitment" PATCH "/projects/$PID/commitments/$COMMIT_A/status" "$TOKEN" 200 -d '{"status":"proposed"}'
request "agree without confirm is refused" POST "/projects/$PID/commitments/$COMMIT_A/agree" "$TOKEN" 409 -d '{"confirm":false}'
request "agree with confirm succeeds" POST "/projects/$PID/commitments/$COMMIT_A/agree" "$TOKEN" 200 -d '{"confirm":true,"note":"Client verbally agreed on the call"}'
[ "$(echo "$BODY" | jget status)" = "agreed" ] && [ "$(echo "$BODY" | jget agreedBy)" = "$OPERATOR_ID" ] && ok "agreement records status+agreedBy — an operator save alone never does this" || bad "agree did not record confirmation"
request "activate commitment" PATCH "/projects/$PID/commitments/$COMMIT_A/status" "$TOKEN" 200 -d '{"status":"active"}'

# Completing while under target is refused; force+reason is auditable.
request "complete under target is refused" POST "/projects/$PID/commitments/$COMMIT_A/complete" "$TOKEN" 409 -d '{}'
request "complete under target without forceReason is refused" POST "/projects/$PID/commitments/$COMMIT_A/complete" "$TOKEN" 409 -d '{"force":true}'
request "force-complete records why" POST "/projects/$PID/commitments/$COMMIT_A/complete" "$TOKEN" 200 -d '{"force":true,"forceReason":"Client accepted 3/10 for this period"}'
[ "$(echo "$BODY" | jget status)" = "completed" ] && ok "force-completed commitment is completed" || bad "force-complete did not set completed"

# Scope change: previous/new target+date, reason, reconfirmation flag.
request "create scope-change commitment" POST "/projects/$PID/commitments" "$TOKEN" 201 \
  -d "{\"cycleId\":\"$CYCLE_ID\",\"title\":\"Fix important website problems\",\"workstream\":\"website\",\"targetCount\":5,\"targetUnit\":\"issues\"}"
COMMIT_C=$(echo "$BODY" | jget id)
request "agree scope-change commitment" POST "/projects/$PID/commitments/$COMMIT_C/agree" "$TOKEN" 200 -d '{"confirm":true}'
request "record scope change requiring reconfirmation" POST "/projects/$PID/commitments/$COMMIT_C/scope-change" "$TOKEN" 200 \
  -d '{"reason":"Client asked us to widen scope to cover the checkout flow too","newTarget":8,"requiresReconfirmation":true}'
[ "$(echo "$BODY" | jget status)" = "needs-attention" ] && ok "a reconfirmation-required scope change moves 'agreed' to 'needs-attention' (stays client-visible)" || bad "status did not move to needs-attention: $(echo "$BODY" | jget status)"
[ "$(echo "$BODY" | jget scopeChanges.0.previousTarget)" = "5" ] && [ "$(echo "$BODY" | jget scopeChanges.0.newTarget)" = "8" ] && ok "scope change records previous/new target" || bad "scope change targets wrong"

# ── 2. Outcome commitment: never auto-completes from closed tasks ─────────
request "create outcome commitment" POST "/projects/$PID/commitments" "$TOKEN" 201 \
  -d "{\"cycleId\":\"$CYCLE_ID\",\"title\":\"Increase qualified visits\",\"workstream\":\"website\",\"outcomeMetricLabel\":\"Qualified visits\",\"outcomeMetricUnit\":\"visits\",\"outcomeMetricTarget\":500,\"linkedWorkItemIds\":$OUTCOME_JSON}"
COMMIT_B=$(echo "$BODY" | jget id)
request "agree outcome commitment" POST "/projects/$PID/commitments/$COMMIT_B/agree" "$TOKEN" 200 -d '{"confirm":true}'
request "activate outcome commitment" PATCH "/projects/$PID/commitments/$COMMIT_B/status" "$TOKEN" 200 -d '{"status":"active"}'
request "outcome commitment before completion" GET "/projects/$PID/commitments/$COMMIT_B" "$TOKEN" 200
[ "$(echo "$BODY" | jget status)" = "active" ] && ok "both linked tasks verified, but the outcome commitment is still 'active' — no auto-flip" || bad "outcome commitment auto-completed: $(echo "$BODY" | jget status)"
request "complete outcome commitment without its own metric is refused" POST "/projects/$PID/commitments/$COMMIT_B/complete" "$TOKEN" 409 -d '{}'
request "complete outcome commitment with its own metric succeeds" POST "/projects/$PID/commitments/$COMMIT_B/complete" "$TOKEN" 200 -d '{"outcomeMetricCurrent":540}'
[ "$(echo "$BODY" | jget status)" = "completed" ] && [ "$(echo "$BODY" | jget outcomeMetricCurrent)" = "540" ] && ok "outcome commitment completes only once its own metric is recorded" || bad "outcome completion did not record metric"

# ── 3. Client-safe commitment view: no actor ids in scope history ─────────
request "client commitments" GET "/portal/projects/$PID/plan/commitments" "$CLIENT_TOKEN" 200
PORTAL_COMMITMENTS="$BODY"
echo "$PORTAL_COMMITMENTS" | grep -Eq '"(by|agreedBy|createdBy|accountableLead)"[[:space:]]*:[[:space:]]*"'"$OPERATOR_ID"'"' \
  && bad "portal commitments leaked an operator id" || ok "portal commitments never expose the operator's raw id"
echo "$PORTAL_COMMITMENTS" | grep -Fq "$COMMIT_C" \
  && [ "$(echo "$PORTAL_COMMITMENTS" | jget commitments)" != "__ERR__" ] \
  && SCOPE_ENTRY=$(node -e 'const d=JSON.parse(process.argv[1]);const c=d.commitments.find(x=>x.title==="Fix important website problems");console.log(c?JSON.stringify(c.scopeChanges[0]):"")' "$PORTAL_COMMITMENTS") \
  || SCOPE_ENTRY=""
if [ -n "$SCOPE_ENTRY" ]; then
  echo "$SCOPE_ENTRY" | grep -q '"reason"' && echo "$SCOPE_ENTRY" | grep -q '"previousTarget"' && echo "$SCOPE_ENTRY" | grep -q '"newTarget"' && ok "client scope-change entry shows reason and previous/new target" || bad "client scope-change entry missing fields: $SCOPE_ENTRY"
  echo "$SCOPE_ENTRY" | grep -Eq '"(by|actor|actorId)"' && bad "client scope-change entry leaked an actor field" || ok "client scope-change entry has no actor field"
else
  bad "could not locate the scope-changed commitment in the portal view"
fi
echo "$PORTAL_COMMITMENTS" | grep -Fq "$OPERATOR_ID" && bad "portal commitments response leaked the operator's raw id somewhere" || ok "portal commitments response has no operator id anywhere"

# ── 4. Needs-your-action queue ─────────────────────────────────────────────
request "create client-facing approval request" POST "/projects/$PID/approvals" "$TOKEN" 201 \
  -d "{\"artifactType\":\"content\",\"artifactId\":\"asset-1\",\"artifactRevision\":1,\"title\":\"Review the homepage rewrite\",\"reviewerType\":\"client\",\"clientId\":\"$(echo "$SEED" | jget clientId)\"}"
APPROVAL_ID=$(echo "$BODY" | jget id)
[ -n "$APPROVAL_ID" ] && [ "$APPROVAL_ID" != "__ERR__" ] && ok "client approval request created" || die "create approval" "$BODY"

request "client actions queue" GET "/portal/projects/$PID/actions" "$CLIENT_TOKEN" 200
ACTIONS="$BODY"
[ "$(echo "$ACTIONS" | jget total)" = "2" ] && ok "client sees exactly 2 eligible actions (approval + onboarding request)" || bad "client action total wrong: $(echo "$ACTIONS" | jget total)"
echo "$ACTIONS" | grep -Fq "$APPROVAL_ID" && ok "approval request appears in the client's queue" || bad "approval request missing from client queue"
echo "$ACTIONS" | grep -Fq "$ONBOARDING_ID" && ok "onboarding request appears in the client's queue" || bad "onboarding request missing from client queue"
echo "$ACTIONS" | grep -q 'P11_AUDIT_FINDING_MARKER' && bad "an audit finding leaked into the client action queue" || ok "audit finding never appears in the client action queue"

request "client actions overview capped at 1" GET "/portal/projects/$PID/actions/overview?limit=1" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jlen items)" = "1" ] && [ "$(echo "$BODY" | jget total)" = "2" ] && ok "overview caps displayed cards while keeping the true total" || bad "overview cap/total wrong"

# Cross-client: another client must never see this project's actions.
request "other client cannot read this project's actions" GET "/portal/projects/$PID/actions" "$OTHER_TOKEN" 404
echo "$BODY" | grep -Eq "($APPROVAL_ID|$ONBOARDING_ID)" && bad "other client's 404 still disclosed action ids" || ok "other client's 404 discloses nothing"

# Resolving the source removes the item — not merely reading it.
request "staff resolves the onboarding request" PATCH "/projects/$PID/onboarding-requests/$ONBOARDING_ID" "$TOKEN" 200 -d '{"status":"done"}'
request "client actions after resolution" GET "/portal/projects/$PID/actions" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jget total)" = "1" ] && ok "resolving the source drops it from the queue (not just marking it read)" || bad "resolved request still in queue: $(echo "$BODY" | jget total)"
echo "$BODY" | grep -Fq "$ONBOARDING_ID" && bad "resolved onboarding request still present" || ok "resolved onboarding request is gone"

# ── 5. Staff queue: their own review task + blocker + operator approval ───
request "staff actions queue" GET "/projects/$PID/actions" "$TOKEN" 200
STAFF_ACTIONS="$BODY"
echo "$STAFF_ACTIONS" | grep -Fq "$(echo "$SEED" | jget reviewItemId)" && ok "staff queue includes their assigned review task" || bad "staff review task missing"
echo "$STAFF_ACTIONS" | grep -Fq "$(echo "$SEED" | jget blockedItemId)" && ok "staff queue includes their assigned delivery blocker" || bad "staff delivery blocker missing"
echo "$STAFF_ACTIONS" | grep -q 'P11_AUDIT_FINDING_MARKER' && bad "audit finding leaked into staff queue" || ok "audit finding never appears in the staff queue either"

echo
echo "thirty-day-plan smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

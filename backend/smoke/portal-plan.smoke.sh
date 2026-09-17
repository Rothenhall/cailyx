#!/usr/bin/env bash
# E2E smoke — P01a client-safe delivery-plan projections (G06).
#
# Seed via Prisma, not project HTTP creation (which starts paid/background
# onboarding jobs). Exercise the real auth/portal/staff HTTP surfaces. Every
# object is checked against an explicit recursive JSON key allowlist; a future
# Prisma column leaking through a spread must fail even when its value is null.
# Delivery-plan storage is Engagement/Cycle/WorkItem, not a DeliveryPlan model;
# sourceId/dependsOn/assigneeId are the actual source/dependency/owner columns.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== portal-plan smoke =="

# A transaction rolls back a partial seed. Install cleanup before authenticating
# or making assertions so early HTTP/auth failures still remove all fixture rows.
SEED='{}'
cleanup() {
  PORTAL_PLAN_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.PORTAL_PLAN_SEED);
  if (!s.clientId) return;
  await prisma.$transaction(async (tx) => {
    const items = await tx.workItem.findMany({ where: { projectId: s.projectId }, select: { id: true } });
    const workItemId = { in: items.map((w) => w.id) };
    await tx.acceptanceCheck.deleteMany({ where: { workItemId } });
    await tx.verification.deleteMany({ where: { workItemId } });
    await tx.capacityAllocation.deleteMany({ where: { projectId: s.projectId } });
    await tx.workItem.deleteMany({ where: { projectId: s.projectId } });
    await tx.milestone.deleteMany({ where: { projectId: s.projectId } });
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
  const stamp = `portalplan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const otherEmail = `other-${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-portal-plan`;
  const passwordHash = await bcryptjs.hash(password, 10);
  // _common.sh rule 1: upsert with an EMPTY update. Never alter the shared
  // smoke operator's role, password, type, or any other existing field.
  const operator = await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `PortalPlan ${stamp}` } });
    const otherClient = await tx.client.create({ data: { name: `Other PortalPlan ${stamp}` } });
    const user = await tx.user.create({ data: {
      email, passwordHash, name: 'Portal Plan Client', type: 'client', clientId: client.id,
    } });
    await tx.user.create({ data: {
      email: otherEmail, passwordHash, name: 'Other Portal Plan Client', type: 'client', clientId: otherClient.id,
    } });
    const startsOn = new Date('2026-09-01T00:00:00.000Z');
    const endsOn = new Date('2026-09-30T23:59:59.000Z');
    const engagement = await tx.engagement.create({ data: {
      clientId: client.id, name: `Portal engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'UTC', deliveryLead: operator.id,
      hoursPerCycle: 144, notes: 'PORTAL_PLAN_PRIVATE_ENGAGEMENT',
    } });
    const project = await tx.project.create({ data: {
      name: `Portal Plan Project ${stamp}`, domain: `${stamp}.example`,
      clientId: client.id, engagementId: engagement.id, onboardingStatus: 'pending',
    } });
    const cycle = await tx.cycle.create({ data: {
      projectId: project.id, engagementId: engagement.id, name: 'September commitment',
      startsOn, endsOn, status: 'committed', goal: 'Client-facing cycle goal',
      committedAt: startsOn, committedBy: operator.id, committedCount: 5,
    } });
    const common = {
      projectId: project.id, cycleId: cycle.id, category: 'fix', discipline: 'technical',
      priority: 'high', reviewerId: operator.id, createdBy: operator.id,
      estimateHours: 17.5, actualHours: 9.25, sourceType: 'finding',
      sourceId: 'PORTAL_PLAN_PRIVATE_SOURCE', internalNotes: 'PORTAL_PLAN_PRIVATE_NOTES',
      dueAt: endsOn,
    };
    const hidden = await tx.workItem.create({ data: {
      ...common, title: 'PORTAL_PLAN_PRIVATE_WORK', description: 'PORTAL_PLAN_PRIVATE_DESCRIPTION',
      status: 'verified', clientVisible: false, assigneeId: operator.id,
    } });
    const visible = { ...common, clientVisible: true, assigneeId: operator.id,
      dependsOn: JSON.stringify([hidden.id]) };
    const committed = await tx.workItem.create({ data: {
      ...visible, title: 'Committed client deliverable', status: 'committed',
      description: `Legacy evidence\n\n[Submitted ${startsOn.toISOString()} by ${operator.id}] Prior evidence — https://example.test/old`,
    } });
    const active = await tx.workItem.create({ data: {
      ...visible, title: 'Client implementation', status: 'active', assigneeId: user.id,
      description: 'Client-safe implementation description.',
    } });
    await tx.workItem.create({ data: {
      ...visible, title: 'Verified client deliverable', status: 'verified', description: 'Delivered publicly.',
    } });
    await tx.workItem.create({ data: {
      ...visible, title: 'Blocked client deliverable', status: 'blocked', description: 'Waiting for approval.',
      blockedOn: 'client', blockedReason: 'PORTAL_PLAN_PRIVATE_BLOCKER raw operational detail',
    } });
    await tx.cycle.update({ where: { id: cycle.id }, data: {
      scopeChanges: JSON.stringify([{ at: startsOn.toISOString(), by: operator.id,
        reason: 'Scope adjusted after commitment', added: [committed.id], removed: [hidden.id] }]),
    } });
    await tx.milestone.create({ data: {
      projectId: project.id, engagementId: engagement.id, title: 'Client launch milestone',
      description: 'PORTAL_PLAN_PRIVATE_MILESTONE', dueAt: endsOn, clientVisible: true,
    } });
    await tx.milestone.create({ data: {
      projectId: project.id, engagementId: engagement.id, title: 'PORTAL_PLAN_PRIVATE_MILESTONE_ROW',
      description: 'Internal-only milestone', dueAt: endsOn, clientVisible: false,
    } });
    return { clientId: client.id, otherClientId: otherClient.id, projectId: project.id,
      engagementId: engagement.id, cycleId: cycle.id, committedId: committed.id,
      activeId: active.id, hiddenId: hidden.id, userId: user.id, operatorId: operator.id,
      email, otherEmail, password };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
CYCLE_ID=$(echo "$SEED" | jget cycleId)
ACTIVE_ID=$(echo "$SEED" | jget activeId)
HIDDEN_ID=$(echo "$SEED" | jget hiddenId)
OPERATOR_ID=$(echo "$SEED" | jget operatorId)
CLIENT_USER_ID=$(echo "$SEED" | jget userId)
EMAIL=$(echo "$SEED" | jget email)
OTHER_EMAIL=$(echo "$SEED" | jget otherEmail)
PW=$(echo "$SEED" | jget password)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "seeded engagement/cycle, four visible work items, one hidden work item, two milestones, two clients" || die "seed" "$SEED"

# Request bodies stay in memory, not files containing credentials or fixture data.
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
  # `smoke_login` (from _common.sh) retries through the /auth/login rate
  # limit. This suite signs in three accounts back to back, so a single 429
  # here used to abort the whole run at "other client login" — a failure that
  # says nothing about the module under test.
  smoke_login "$1" "$2"
}
CLIENT_LOGIN=$(login "$EMAIL" "$PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client portal login works" || die "client login" "$CLIENT_LOGIN"
OTHER_LOGIN=$(login "$OTHER_EMAIL" "$PW")
OTHER_TOKEN=$(echo "$OTHER_LOGIN" | jget accessToken)
[ -n "$OTHER_TOKEN" ] && [ "$OTHER_TOKEN" != "__ERR__" ] && ok "other client login works" || die "other client login" "$OTHER_LOGIN"
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"

# Recursive serialized-JSON schema check. null denotes a scalar (NOT arbitrary
# JSON). Unknown keys fail even when null, false, zero, or empty. Array elements
# are checked individually, including nested scope changes. Diagnostics print
# precise paths so the pre-fix run is a usable leak inventory.
assert_allowlisted() {
  local label="$1" shape="$2" body="$3" issues
  issues=$(PORTAL_PLAN_BODY="$body" node - "$shape" <<'EOF'
const scalar = null;
const fields = (names) => Object.fromEntries(names.split(' ').map((k) => [k, scalar]));
const work = fields('id title description status verifyState dueOn capabilityLabel blockedOn blockedReason projectId');
const scope = fields('at reason requiresReconfirmation');
const cycle = { ...fields('id name status startsOn endsOn goal committedAt committedCount currentCount deliveredCount'), scopeChanges: [scope] };
const engagement = fields('id name serviceTier endsOn status');
const milestone = fields('id title dueOn status');
const schemas = { plan: { engagement, cycles: [cycle], milestones: [milestone], workItems: [work] }, work: { workItems: [work] }, evidence: work };
const errors = [];
function walk(value, schema, path) {
  if (schema === null) {
    if (value !== null && typeof value === 'object') errors.push(`${path} (expected scalar)`);
    return;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) { errors.push(`${path} (expected array)`); return; }
    value.forEach((entry, i) => walk(entry, schema[0], `${path}[${i}]`));
    return;
  }
  if (value === null && path === '$.engagement') return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} (expected object)`); return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema, key)) errors.push(`${path}.${key}`);
    else walk(value[key], schema[key], `${path}.${key}`);
  }
  // Required semantic fields prevent an empty or error-shaped response passing.
  const required = schema === work ? ['id', 'title', 'description', 'status', 'verifyState']
    : schema === scope ? ['at', 'reason', 'requiresReconfirmation']
    : schema === cycle ? ['id', 'name', 'status', 'endsOn', 'committedCount', 'currentCount', 'deliveredCount', 'scopeChanges']
    : schema === milestone ? ['id', 'title', 'dueOn', 'status']
    : schema === engagement ? ['id', 'name', 'status'] : Object.keys(schema);
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} (missing required field)`);
  if (schema === work && value.blockedReason != null && !['client-action', 'approval', 'dependency', 'other'].includes(value.blockedReason)) {
    errors.push(`${path}.blockedReason (must be client-action/approval/dependency/other)`);
  }
  if (schema === scope && typeof value.requiresReconfirmation !== 'boolean') {
    errors.push(`${path}.requiresReconfirmation (expected boolean)`);
  }
}
try { walk(JSON.parse(process.env.PORTAL_PLAN_BODY), schemas[process.argv[2]], '$'); }
catch (e) { errors.push(`$ (invalid JSON: ${e.message})`); }
console.log(errors.join('\n'));
process.exitCode = errors.length ? 1 : 0;
EOF
) && ok "$label recursive allowlist" || { bad "$label recursive allowlist"; printf '%s\n' "$issues"; }
}

# A second, deliberately independent layer, like released-summary.smoke.sh.
# Exact forbidden keys include alternate spellings to guard future additions.
# Also inspect values: hiding an actor id in a public description is still a leak.
assert_no_leaks() {
  local label="$1" body="$2" scope_json
  if echo "$body" | grep -Eiq '"(internalNotes|estimateHours|actualHours|hours|assigneeId|assignedToId|reviewerId|createdBy|sourceId|sourceIds|sourceType|dependsOn|dependencyIds)"[[:space:]]*:'; then
    bad "$label forbidden internal JSON key"
  else ok "$label no forbidden internal JSON keys"; fi
  if echo "$body" | grep -Eq 'PORTAL_PLAN_PRIVATE_'; then
    bad "$label private fixture value leaked"
  else ok "$label no private fixture values"; fi
  if echo "$body" | grep -Eq "($OPERATOR_ID|$CLIENT_USER_ID)"; then
    bad "$label actor user id leaked (including description/evidence stamps)"
  else ok "$label no actor user ids, including description/evidence stamps"; fi
  if echo "$body" | grep -Eq '"(actor|actorId|userId|assigneeId|assignedToId|reviewerId|createdBy|committedBy|by)"[[:space:]]*:[[:space:]]*"c[a-z0-9]{24,}"'; then
    bad "$label cuid-shaped actor value leaked"
  else ok "$label no cuid-shaped actor values"; fi
  scope_json=$(echo "$body" | jget cycles.0.scopeChanges)
  if echo "$scope_json" | grep -Eq '"(by|added|removed)"[[:space:]]*:'; then
    bad "$label scopeChanges actor or added/removed IDs leaked"
  else ok "$label no scopeChanges actor or added/removed IDs"; fi
  if echo "$body" | grep -Fq "$HIDDEN_ID"; then
    bad "$label internal-only work item id leaked"
  else ok "$label internal-only work item absent"; fi
}

request "client plan" GET "/portal/projects/$PID/plan" "$CLIENT_TOKEN" 200
PLAN="$BODY"
assert_allowlisted "GET /plan" plan "$PLAN"
assert_no_leaks "GET /plan" "$PLAN"
[ "$(echo "$PLAN" | jlen workItems)" = "4" ] && ok "plan contains exactly four client-visible work items" || bad "plan client-visible work item count"
[ "$(echo "$PLAN" | jlen milestones)" = "1" ] && ok "plan contains only the client-visible milestone" || bad "plan milestone visibility"
[ "$(echo "$PLAN" | jlen cycles)" = "1" ] && [ "$(echo "$PLAN" | jlen cycles.0.scopeChanges)" = "1" ] && ok "plan includes seeded cycle and scope change" || bad "missing cycle/scope change"
[ "$(echo "$PLAN" | jget engagement.name)" != "" ] && ok "plan includes non-null engagement" || bad "missing engagement"
# These are full-cycle aggregates by contract, not visible-row recounts.
[ "$(echo "$PLAN" | jget cycles.0.committedCount)" = "5" ] && [ "$(echo "$PLAN" | jget cycles.0.currentCount)" = "5" ] && [ "$(echo "$PLAN" | jget cycles.0.deliveredCount)" = "2" ] && ok "full-cycle aggregate counts remain 5 committed / 5 current / 2 delivered (including hidden work)" || bad "cycle aggregates changed"

request "client work list" GET "/portal/projects/$PID/work" "$CLIENT_TOKEN" 200
WORK="$BODY"
assert_allowlisted "GET /work" work "$WORK"
assert_no_leaks "GET /work" "$WORK"
[ "$(echo "$WORK" | jlen workItems)" = "4" ] && ok "work list contains exactly four client-visible work items" || bad "work list client-visible count"

request "staff work detail" GET "/projects/$PID/work-items/$ACTIVE_ID" "$TOKEN" 200
STAFF="$BODY"
[ "$(echo "$STAFF" | jget estimateHours)" = "17.5" ] && [ "$(echo "$STAFF" | jget actualHours)" = "9.25" ] && [ "$(echo "$STAFF" | jget internalNotes)" = "PORTAL_PLAN_PRIVATE_NOTES" ] && [ "$(echo "$STAFF" | jget assigneeId)" = "$CLIENT_USER_ID" ] && ok "staff work detail still returns hours, internal notes and assignee" || bad "staff work detail was narrowed"
request "staff cycle detail" GET "/projects/$PID/cycles/$CYCLE_ID/detail" "$TOKEN" 200
[ "$(echo "$BODY" | jget scopeChanges.0.by)" = "$OPERATOR_ID" ] && [ "$(echo "$BODY" | jlen workItems)" = "5" ] && ok "staff cycle retains actor scope history and hidden work" || bad "staff cycle lost internal fields/items"

request "client evidence" POST "/portal/projects/$PID/work/$ACTIVE_ID/evidence" "$CLIENT_TOKEN" 200 \
  -d '{"note":"Client implemented the agreed change.","sourceUrl":"https://example.test/client-proof"}'
EVIDENCE="$BODY"
assert_allowlisted "POST /work/:id/evidence" evidence "$EVIDENCE"
assert_no_leaks "POST /work/:id/evidence" "$EVIDENCE"
[ "$(echo "$EVIDENCE" | jget id)" = "$ACTIVE_ID" ] && [ "$(echo "$EVIDENCE" | jget status)" = "review" ] && ok "client evidence moves assigned active work to review" || bad "client evidence transition"
echo "$EVIDENCE" | grep -q 'Client implemented the agreed change.' && echo "$EVIDENCE" | grep -q 'https://example.test/client-proof' && ok "client evidence retains note and source URL" || bad "evidence content lost"
request "staff evidence readback" GET "/projects/$PID/work-items/$ACTIVE_ID" "$TOKEN" 200
[ "$(echo "$BODY" | jget status)" = "review" ] && echo "$BODY" | grep -q 'Client implemented the agreed change.' && ok "evidence persisted to staff-visible work item" || bad "evidence did not persist"

# Re-read both client endpoints after the mutation: sanitizing only the POST
# response is insufficient if the stored legacy evidence stamp leaks on GET.
request "client plan after evidence" GET "/portal/projects/$PID/plan" "$CLIENT_TOKEN" 200
assert_allowlisted "GET /plan after evidence" plan "$BODY"
assert_no_leaks "GET /plan after evidence" "$BODY"
request "client work after evidence" GET "/portal/projects/$PID/work" "$CLIENT_TOKEN" 200
assert_allowlisted "GET /work after evidence" work "$BODY"
assert_no_leaks "GET /work after evidence" "$BODY"

# Ownership must be enforced on every route, not just omitted from a list.
for path in "/portal/projects/$PID/plan" "/portal/projects/$PID/work"; do
  request "other client $path" GET "$path" "$OTHER_TOKEN" 404
  if echo "$BODY" | grep -Eq "($PID|$CYCLE_ID|$ACTIVE_ID|PORTAL_PLAN_PRIVATE_)"; then
    bad "other client response disclosed project data"
  else ok "other client sees none of this project's plan"; fi
done
request "other client evidence" POST "/portal/projects/$PID/work/$ACTIVE_ID/evidence" "$OTHER_TOKEN" 404 \
  -d '{"note":"This must not be accepted."}'
request "client hidden work evidence" POST "/portal/projects/$PID/work/$HIDDEN_ID/evidence" "$CLIENT_TOKEN" 404 \
  -d '{"note":"This must not be accepted."}'

echo
echo "portal-plan smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

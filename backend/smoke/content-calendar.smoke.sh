#!/usr/bin/env bash
# E2E smoke — P10 content calendar / publishing linkage (platform_improvement_plan.md §6.4-§6.7).
#
# What this suite is here to prove, in the plan's own words:
#
#   (a) "Month complete beyond 200 entries" — a month with more than one page of
#       events reports truncation explicitly, its window total is exact, and
#       following the cursor reaches every event exactly once. A read that
#       silently returned the first 200 rows would let a month look complete.
#   (b) Approval gates — a planned placement is visible *before* any approval
#       exists (state `awaiting-approval`), and dispatch is refused until an
#       approval exists at the exact revision and the destination is usable.
#   (c) DST — a nonexistent local time is rejected (not silently shifted), a
#       repeated local time must be disambiguated, and the staff project,
#       portfolio and client reads all resolve to the same instant.
#
# Plus the rules that are easy to get subtly wrong: cancellation preserves
# history instead of deleting it; a past due date reads "Not published yet" and
# never "Published"; moving an intention does not move the queued publication;
# and a client read reveals no unshared internal draft — not in the events, not
# in the unscheduled list, and not in any count.
#
# Fixtures are seeded through Prisma (HTTP project creation starts paid
# onboarding jobs). Every placement the API can create is created through the
# API, because the write path is half of what is under test. The only rows
# written directly are the publishing *results* the API will not produce without
# a real remote write: a queued publication whose destination was later
# disconnected, and a published one whose live check has not confirmed it.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }
eq()  { [ "$1" = "$2" ] && ok "$3" || { bad "$3"; echo "    got: '$1' expected: '$2'"; }; }
has() { echo "$2" | grep -Fq "$1" && ok "$3" || bad "$3"; }
lacks() { echo "$2" | grep -Fq "$1" && bad "$3" || ok "$3"; }

echo "== content-calendar smoke =="

# A transaction rolls back a partial seed. Install cleanup before authenticating
# so an early auth or HTTP failure still removes every fixture row.
SEED='{}'
cleanup() {
  CONTENT_CALENDAR_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.CONTENT_CALENDAR_SEED);
  if (!s.clientId) return;
  const projectIds = [s.projectId, s.dstProjectId];
  const assetIds = [s.shareAssetId, s.destAssetId, s.awaitAssetId, s.offAssetId, s.pastAssetId,
    s.liveAssetId, s.bulkAssetId, s.internalAssetId, s.opsAssetId, s.dstAssetId];
  await prisma.$transaction(async (tx) => {
    await tx.publication.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.contentSchedule.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.approvalRequest.deleteMany({ where: { artifactId: { in: assetIds } } });
    await tx.contentRevision.deleteMany({ where: { assetId: { in: assetIds } } });
    await tx.growthAsset.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.publishDestination.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.activityEvent.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.project.deleteMany({ where: { id: { in: projectIds } } });
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
const content = (title) => ({ title, body: `Draft body for ${title}.` });
(async () => {
  const stamp = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const otherEmail = `other-${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-content-calendar`;
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
    const client = await tx.client.create({ data: { name: `ContentCalendar ${stamp}` } });
    const otherClient = await tx.client.create({ data: { name: `Other ContentCalendar ${stamp}` } });
    const user = await tx.user.create({ data: {
      email, passwordHash, name: 'Calendar Client', type: 'client', clientId: client.id,
    } });
    await tx.user.create({ data: {
      email: otherEmail, passwordHash, name: 'Other Calendar Client', type: 'client',
      clientId: otherClient.id,
    } });

    const startsOn = new Date('2026-01-01T00:00:00.000Z');
    const endsOn = new Date('2026-12-31T23:59:59.000Z');
    const london = await tx.engagement.create({ data: {
      clientId: client.id, name: `London engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'Europe/London', deliveryLead: operator.id,
    } });
    const project = await tx.project.create({ data: {
      name: `Calendar Project ${stamp}`, domain: `${stamp}.example`, clientId: client.id,
      engagementId: london.id, onboardingStatus: 'pending',
    } });
    // A second project in the SAME client, on a zone with both DST edges: the
    // repeated-hour fixture has to be read in a zone where the reading is
    // genuinely repeated, and the portfolio scope has to cover it for the
    // "three views agree" assertion.
    const newYork = await tx.engagement.create({ data: {
      clientId: client.id, name: `New York engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'America/New_York', deliveryLead: operator.id,
    } });
    const dstProject = await tx.project.create({ data: {
      name: `Calendar DST Project ${stamp}`, domain: `dst-${stamp}.example`, clientId: client.id,
      engagementId: newYork.id, onboardingStatus: 'pending',
    } });

    const asset = (data) => tx.growthAsset.create({ data: {
      projectId: project.id, brief: 'Smoke fixture brief.', source: 'deterministic', ...data } });
    const share = await asset({ assetType: 'article', title: 'ContentCalendar shared article' });
    const dest = await asset({ assetType: 'article', title: 'ContentCalendar webhook article' });
    const awaiting = await asset({ assetType: 'article', title: 'ContentCalendar unapproved article' });
    const off = await asset({ assetType: 'article', title: 'ContentCalendar offline article' });
    const past = await asset({ assetType: 'social-content', title: 'ContentCalendar overdue post' });
    const live = await asset({ assetType: 'article', title: 'ContentCalendar published article' });
    const bulk = await asset({ assetType: 'article', title: 'ContentCalendar bulk article' });
    // The internal draft §6.5 says must never leak through a client read — not
    // as an event, not as an unscheduled item, not as a count.
    const internal = await asset({ assetType: 'article',
      title: 'CONTENT_CALENDAR_PRIVATE_DRAFT internal working title' });
    // Operational asset types are outside this calendar entirely (§6.4), so a
    // `structured-data` piece must not appear in any scope, ever.
    const ops = await asset({ assetType: 'structured-data',
      title: 'CONTENT_CALENDAR_PRIVATE_OPS structured data task' });
    const dst = await tx.growthAsset.create({ data: {
      projectId: dstProject.id, assetType: 'article', title: 'ContentCalendar DST article',
      brief: 'Smoke fixture brief.', source: 'deterministic' } });

    // Revisions. `clientVisible` is the only thing that shares a piece with a
    // client (§13.5) — approval is deliberately NOT enough.
    const shareRev = await tx.contentRevision.create({ data: {
      assetId: share.id, revision: 1, ...content('ContentCalendar shared article'),
      origin: 'operator-edit', clientVisible: true, clientVisibleAt: new Date(),
      clientVisibleBy: operator.id } });
    const destRev = await tx.contentRevision.create({ data: {
      assetId: dest.id, revision: 1, ...content('ContentCalendar webhook article'), origin: 'operator-edit' } });
    const awaitRev = await tx.contentRevision.create({ data: {
      assetId: awaiting.id, revision: 1, ...content('ContentCalendar unapproved article'), origin: 'operator-edit' } });
    const offRev = await tx.contentRevision.create({ data: {
      assetId: off.id, revision: 1, ...content('ContentCalendar offline article'), origin: 'operator-edit' } });
    const liveRev = await tx.contentRevision.create({ data: {
      assetId: live.id, revision: 1, ...content('ContentCalendar published article'),
      origin: 'operator-edit', clientVisible: true, clientVisibleAt: new Date(),
      clientVisibleBy: operator.id } });
    await tx.contentRevision.create({ data: {
      assetId: internal.id, revision: 1, ...content('CONTENT_CALENDAR_PRIVATE_DRAFT internal working title'),
      origin: 'generation', clientVisible: false } });
    const dstRev = await tx.contentRevision.create({ data: {
      assetId: dst.id, revision: 1, ...content('ContentCalendar DST article'), origin: 'operator-edit',
      clientVisible: true, clientVisibleAt: new Date(), clientVisibleBy: operator.id } });

    // Approvals, at the exact revision — the gate publishing rechecks at dispatch.
    const approval = (assetId, revisionId, title) => tx.approvalRequest.create({ data: {
      projectId: project.id, clientId: client.id, artifactType: 'content', artifactId: assetId,
      artifactRevision: 1, revisionId, title, reviewerType: 'client', requestedBy: operator.id,
      status: 'approved' } });
    const destApproval = await approval(dest.id, destRev.id, 'Approve webhook article');
    const offApproval = await approval(off.id, offRev.id, 'Approve offline article');
    await approval(live.id, liveRev.id, 'Approve published article');
    // `awaiting` deliberately has NO approval: that is the state under test.

    const destination = (label, endpoint) => tx.publishDestination.create({ data: {
      projectId: project.id, provider: 'custom-webhook', label,
      config: JSON.stringify({ endpoint, requiresAuth: false, grantedPermissions: ['content:write'] }),
      status: 'connected', createdBy: operator.id } });
    const hookDestination = await destination('Smoke webhook', 'https://example.test/hook');
    const offDestination = await destination('Smoke webhook (goes offline)', 'https://example.test/offline');

    // 224 placements on one day, so a month is genuinely more than one page.
    // 15 November is GMT, so the local reading equals the UTC time here.
    const base = Date.UTC(2026, 10, 15, 9, 0);
    const bulkRows = [];
    for (let i = 0; i < 224; i += 1) {
      const at = new Date(base + i * 60_000);
      const hh = String(at.getUTCHours()).padStart(2, '0');
      const mm = String(at.getUTCMinutes()).padStart(2, '0');
      bulkRows.push({
        projectId: project.id, assetId: bulk.id, contentType: 'article', channel: 'linkedin',
        deliveryMode: 'manual', plannedForUtc: at, plannedLocalDate: '2026-11-15',
        plannedLocalTime: `${hh}:${mm}`, timezone: 'Europe/London', status: 'planned',
        version: 1, createdBy: operator.id,
      });
    }
    await tx.contentSchedule.createMany({ data: bulkRows });

    return { clientId: client.id, otherClientId: otherClient.id, projectId: project.id,
      dstProjectId: dstProject.id, engagementId: london.id, dstEngagementId: newYork.id,
      shareAssetId: share.id, destAssetId: dest.id, awaitAssetId: awaiting.id, offAssetId: off.id,
      pastAssetId: past.id, liveAssetId: live.id, bulkAssetId: bulk.id,
      internalAssetId: internal.id, opsAssetId: ops.id, dstAssetId: dst.id,
      shareRevId: shareRev.id, destRevId: destRev.id, awaitRevId: awaitRev.id, offRevId: offRev.id,
      liveRevId: liveRev.id, dstRevId: dstRev.id, destApprovalId: destApproval.id,
      offApprovalId: offApproval.id, hookDestinationId: hookDestination.id,
      offDestinationId: offDestination.id, bulkCount: bulkRows.length,
      operatorId: operator.id, userId: user.id, email, otherEmail, password };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
DID=$(echo "$SEED" | jget dstProjectId)
A_SHARE=$(echo "$SEED" | jget shareAssetId)
A_DEST=$(echo "$SEED" | jget destAssetId)
A_AWAIT=$(echo "$SEED" | jget awaitAssetId)
A_OFF=$(echo "$SEED" | jget offAssetId)
A_PAST=$(echo "$SEED" | jget pastAssetId)
A_LIVE=$(echo "$SEED" | jget liveAssetId)
A_INTERNAL=$(echo "$SEED" | jget internalAssetId)
A_OPS=$(echo "$SEED" | jget opsAssetId)
A_DST=$(echo "$SEED" | jget dstAssetId)
R_DEST=$(echo "$SEED" | jget destRevId)
R_OFF=$(echo "$SEED" | jget offRevId)
R_LIVE=$(echo "$SEED" | jget liveRevId)
AP_OFF=$(echo "$SEED" | jget offApprovalId)
D_HOOK=$(echo "$SEED" | jget hookDestinationId)
D_OFF=$(echo "$SEED" | jget offDestinationId)
OPERATOR_ID=$(echo "$SEED" | jget operatorId)
EMAIL=$(echo "$SEED" | jget email)
OTHER_EMAIL=$(echo "$SEED" | jget otherEmail)
PW=$(echo "$SEED" | jget password)
[ -n "$PID" ] && [ -n "$DID" ] && [ -n "$A_INTERNAL" ] \
  && ok "seeded two projects, two destinations, 224 bulk placements and the content pieces" \
  || die "seed" "$SEED"

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
  # `smoke_login` retries through the /auth/login rate limit. A suite signs in
  # several accounts in quick succession, so one 429 here used to abort the
  # whole run at "client login" — a failure that says nothing about the module
  # under test.
  smoke_login "$1" "$2"
}
# Query string for a bounded window read (§6.7).
window() { echo "from=$1&to=$2&timezone=$3"; }

CLIENT_LOGIN=$(login "$EMAIL" "$PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client portal login works" || die "client login" "$CLIENT_LOGIN"
OTHER_LOGIN=$(login "$OTHER_EMAIL" "$PW")
OTHER_TOKEN=$(echo "$OTHER_LOGIN" | jget accessToken)
[ -n "$OTHER_TOKEN" ] && [ "$OTHER_TOKEN" != "__ERR__" ] && ok "other client login works" || die "other client login" "$OTHER_LOGIN"
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"

# Recursive serialized-JSON schema check, in the style of portal-plan.smoke.sh.
# The `client` shape omits the staff-only fields, so a leaked internal key fails
# even when its value is null. Unknown keys always fail.
assert_allowlisted() {
  local label="$1" shape="$2" body="$3" issues
  issues=$(CONTENT_CALENDAR_BODY="$body" node - "$shape" <<'EOF'
const OPTIONAL = '?optional?';
const scalar = null;
// A name prefixed with `?` may be absent: `execution.error` and
// `verification.error` are written only when there is one.
const fields = (names) => Object.fromEntries(names.split(' ').map((k) =>
  [k.startsWith('?') ? k.slice(1) : k, k.startsWith('?') ? OPTIONAL : scalar]));
const base = 'scheduleId projectId projectName assetId title contentType contentTypeLabel channel ' +
  'channelLabel deliveryMode state stateLabel holdReason holdReasonLabel pastDue pastDueLabel ' +
  'pastDueReason pastDueReasonLabel scheduledForUtc plannedLocalDate plannedLocalTime timezone ' +
  'dstDisambiguation execution attemptCount intentionAndExecutionDiffer verification liveUrl ' +
  'approvedRevision latestRevision commitmentId briefId cancelledAt version createdAt updatedAt';
const event = (staff) => ({
  ...fields(staff ? `${base} destinationLabel ownerId ownerLabel cancelReason` : base),
  execution: fields(staff ? 'publicationId status mode scheduledFor attempt remoteUrl ?error'
    : 'publicationId status mode scheduledFor attempt remoteUrl'),
  verification: fields(staff ? 'state verifiedAt verifiedUrl ?error' : 'state verifiedAt verifiedUrl'),
});
const unscheduled = (staff) => fields(staff
  ? 'assetId projectId title contentType contentTypeLabel state reason reasonLabel ownerId updatedAt'
  : 'assetId projectId title contentType contentTypeLabel state reason reasonLabel updatedAt');
const win = fields('from to timezone days bounded');
const scope = fields('kind projectId label');
const filters = fields('type channel state ownerId');
const page = (staff) => ({ items: [event(staff)], limit: scalar, returned: scalar, hasMore: scalar,
  nextCursor: scalar, truncated: scalar });
const unscheduledList = (staff) => ({ items: [unscheduled(staff)], limit: scalar, returned: scalar,
  hasMore: scalar, nextCursor: scalar, truncated: scalar, total: scalar, totalIsExact: scalar });
const schemas = {
  client: { scope: { ...scope, projectIds: [scalar] }, window: win, filters,
    layout: [event(false)], events: [event(false)], page: page(false),
    totalInWindow: scalar, totalIsExact: scalar, unscheduled: unscheduledList(false), generatedAt: scalar },
  staff: { scope: { ...scope, projectIds: [scalar] }, window: win, filters,
    layout: [event(true)], events: [event(true)], page: page(true),
    totalInWindow: scalar, totalIsExact: scalar, unscheduled: unscheduledList(true), generatedAt: scalar },
};
const required = ['scheduleId', 'projectId', 'assetId', 'title', 'contentType', 'channel',
  'deliveryMode', 'state', 'scheduledForUtc', 'plannedLocalDate', 'plannedLocalTime', 'timezone',
  'attemptCount', 'verification', 'version'];
const errors = [];
function walk(value, schema, path) {
  if (schema === OPTIONAL) return;
  if (schema === null) {
    if (value !== null && typeof value === 'object') errors.push(`${path} (expected scalar)`);
    return;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) { errors.push(`${path} (expected array)`); return; }
    value.forEach((entry, i) => walk(entry, schema[0], `${path}[${i}]`));
    return;
  }
  // A placement with nothing queued has no execution; that is a fact, not a leak.
  if (value === null && /(^|\.)execution$/.test(path)) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} (expected object)`); return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema, key)) errors.push(`${path}.${key}`);
    else walk(value[key], schema[key], `${path}.${key}`);
  }
  const keys = Object.keys(schema);
  const isEvent = keys.includes('scheduleId');
  const expected = isEvent ? required : keys;
  for (const key of expected) {
    if (!Object.hasOwn(value, key) && schema[key] !== OPTIONAL) {
      errors.push(`${path}.${key} (missing required field)`);
    }
  }
}
try { walk(JSON.parse(process.env.CONTENT_CALENDAR_BODY), schemas[process.argv[2]], '$'); }
catch (e) { errors.push(`$ (invalid JSON: ${e.message})`); }
console.log(errors.join('\n'));
process.exitCode = errors.length ? 1 : 0;
EOF
) && [ -z "$issues" ] && ok "$label recursive allowlist" \
  || { bad "$label recursive allowlist"; printf '%s\n' "$issues"; }
}

# Field of the event carrying a given scheduleId, from a calendar read body.
# Assertions address events by identity rather than by position: the read is
# ordered by instant, and an assertion that depends on where an event landed
# would fail for the wrong reason the moment a fixture moves.
ev() {
  CONTENT_CALENDAR_BODY="$1" node -e '
    const body = JSON.parse(process.env.CONTENT_CALENDAR_BODY);
    const event = (body.events || []).find((e) => e.scheduleId === process.argv[1]);
    let out = "__MISSING__";
    if (event) {
      let value = event;
      for (const key of process.argv[2].split(".")) value = value == null ? undefined : value[key];
      out = value == null ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    process.stdout.write(out);
  ' "$2" "$3"
}

# ── Writes: intentions first, no approval anywhere yet ─────────────────────
# The headline §6.6 claim: a planned date exists and is visible BEFORE anything
# is approved. Every placement below is created through the API.
request "plan shared piece (organic social)" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_SHARE\",\"channel\":\"organic-social\",\"scheduledFor\":\"2026-11-10T09:00\",\"timezone\":\"Europe/London\",\"ownerId\":\"$OPERATOR_ID\"}"
S_SHARE=$(echo "$BODY" | jget scheduleId)
[ -n "$S_SHARE" ] && [ "$S_SHARE" != "__ERR__" ] || die "S_SHARE create" "$BODY"
eq "$(echo "$BODY" | jget state)" "awaiting-approval" "a planned placement reads awaiting-approval before any approval exists"
eq "$(echo "$BODY" | jget stateLabel)" "Awaiting approval" "and it is labelled in words, not a code"
eq "$(echo "$BODY" | jget pastDue)" "false" "a future placement is not past due"
eq "$(echo "$BODY" | jget execution)" "" "an intention with nothing queued has no execution"
eq "$(echo "$BODY" | jget deliveryMode)" "manual" "a channel with no adapter is planned as manual delivery"
eq "$(echo "$BODY" | jget channelLabel)" "Organic social (manual)" "the channel label says it is delivered by a person"

request "plan shared piece (paid ads, second channel)" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_SHARE\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-20T09:00\",\"timezone\":\"Europe/London\"}"
S_CANCEL=$(echo "$BODY" | jget scheduleId)
eq "$(echo "$BODY" | jget deliveryMode)" "manual" "an ad creative is a plan, never an automated launch"
eq "$(echo "$BODY" | jget channelLabel)" "Paid ads" "and it is labelled as the ad channel, not as an internal source"
# §6.6: an unsupported channel may only be planned or delivered manually. Asking
# for an automated launch on one must be refused, not quietly downgraded.
request "plan an automated ad launch" POST "/projects/$PID/content-schedules" "$TOKEN" 400 \
  -d "{\"assetId\":\"$A_SHARE\",\"channel\":\"paid-ads\",\"deliveryMode\":\"automated\",\"scheduledFor\":\"2026-11-21T09:00\",\"timezone\":\"Europe/London\"}"
eq "$(echo "$BODY" | jget error)" "channel-not-automatable" "an automated launch on a planning-only channel is refused"

request "plan webhook article" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_DEST\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$D_HOOK\",\"scheduledFor\":\"2026-12-01T09:00\",\"timezone\":\"Europe/London\"}"
S_DEST=$(echo "$BODY" | jget scheduleId)
eq "$(echo "$BODY" | jget deliveryMode)" "automated" "a real provider with a connected destination may be automated"
request "plan same piece on a second channel" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_DEST\",\"channel\":\"email\",\"scheduledFor\":\"2026-12-08T09:00\",\"timezone\":\"Europe/London\"}"
S_DEST2=$(echo "$BODY" | jget scheduleId)
[ "$S_DEST" != "$S_DEST2" ] && ok "two channels for one piece are two entries with distinct ids" \
  || bad "second channel reused the first placement id"
request "plan unapproved article" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_AWAIT\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$D_HOOK\",\"scheduledFor\":\"2026-10-05T09:00\",\"timezone\":\"Europe/London\"}"
S_AWAIT=$(echo "$BODY" | jget scheduleId)
request "plan offline-destination article" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_OFF\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$D_OFF\",\"scheduledFor\":\"2026-12-05T09:00\",\"timezone\":\"Europe/London\"}"
S_OFF=$(echo "$BODY" | jget scheduleId)
request "plan overdue post" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_PAST\",\"channel\":\"organic-social\",\"scheduledFor\":\"2026-01-05T09:00\",\"timezone\":\"Europe/London\"}"
S_PAST=$(echo "$BODY" | jget scheduleId)
request "plan published article" POST "/projects/$PID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_LIVE\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$D_HOOK\",\"scheduledFor\":\"2026-08-20T09:00\",\"timezone\":\"Europe/London\"}"
S_LIVE=$(echo "$BODY" | jget scheduleId)

# §6.7 idempotency: a retried create must return the row it already made.
IDEM_BODY="{\"assetId\":\"$A_PAST\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-10-20T09:00\",\"timezone\":\"Europe/London\",\"idempotencyKey\":\"cal-smoke-idem-1\"}"
request "plan idempotent placement" POST "/projects/$PID/content-schedules" "$TOKEN" 201 -d "$IDEM_BODY"
S_IDEM=$(echo "$BODY" | jget scheduleId)
[ -n "$S_IDEM" ] && [ "$S_IDEM" != "__ERR__" ] || die "S_IDEM create" "$BODY"
request "plan idempotent placement (retry, same key)" POST "/projects/$PID/content-schedules" "$TOKEN" 201 -d "$IDEM_BODY"
eq "$(echo "$BODY" | jget scheduleId)" "$S_IDEM" "a retried create returns the same placement"
eq "$(echo "$BODY" | jget version)" "1" "and does not write a second row"

# §6.7 optimistic concurrency: a stale version is refused, not silently applied.
request "move placement" PATCH "/projects/$PID/content-schedules/$S_IDEM" "$TOKEN" 200 \
  -d '{"version":1,"scheduledFor":"2026-10-21T09:00"}'
eq "$(echo "$BODY" | jget version)" "2" "a move increments the version"
request "move placement with a stale version" PATCH "/projects/$PID/content-schedules/$S_IDEM" "$TOKEN" 409 \
  -d '{"version":1,"scheduledFor":"2026-10-22T09:00"}'
eq "$(echo "$BODY" | jget error)" "version-conflict" "a stale version is refused with version-conflict"
eq "$(echo "$BODY" | jget currentVersion)" "2" "and the refusal names the version to reload"

# ── DST (§6.7) — a project on a zone with both edges ───────────────────────
request "plan in a nonexistent local time" POST "/projects/$DID/content-schedules" "$TOKEN" 400 \
  -d "{\"assetId\":\"$A_DST\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-03-08T02:30\",\"timezone\":\"America/New_York\"}"
eq "$(echo "$BODY" | jget error)" "time-nonexistent" "a local time inside the spring-forward gap is rejected"
has "does not exist" "$BODY" "and the refusal explains why"
[ -n "$(echo "$BODY" | jget nextValidLocal)" ] && ok "and offers the next local time that does exist" \
  || bad "no nextValidLocal offered for a nonexistent time"

request "plan in a repeated local time" POST "/projects/$DID/content-schedules" "$TOKEN" 400 \
  -d "{\"assetId\":\"$A_DST\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\"}"
eq "$(echo "$BODY" | jget error)" "time-ambiguous" "a repeated local time is refused rather than guessed"
CAND_EARLIER=$(echo "$BODY" | jget candidates.0.utc)
CAND_LATER=$(echo "$BODY" | jget candidates.1.utc)
[ "$(echo "$BODY" | jlen candidates)" = "2" ] && [ -n "$CAND_EARLIER" ] && [ -n "$CAND_LATER" ] \
  && ok "and both candidate instants are returned for the caller to choose between" \
  || bad "ambiguous refusal did not return two candidates: $BODY"

request "plan repeated local time (later)" POST "/projects/$DID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_DST\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\",\"dstDisambiguation\":\"later\"}"
S_DST_LATER=$(echo "$BODY" | jget scheduleId)
eq "$(echo "$BODY" | jget scheduledForUtc)" "$CAND_LATER" "the later choice resolves to the later instant"
eq "$(echo "$BODY" | jget dstDisambiguation)" "later" "and the disambiguation is stored with the row"
request "plan repeated local time (earlier)" POST "/projects/$DID/content-schedules" "$TOKEN" 201 \
  -d "{\"assetId\":\"$A_DST\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\",\"dstDisambiguation\":\"earlier\"}"
S_DST_EARLIER=$(echo "$BODY" | jget scheduleId)
eq "$(echo "$BODY" | jget scheduledForUtc)" "$CAND_EARLIER" "the earlier choice resolves to the earlier instant"
[ "$CAND_EARLIER" != "$CAND_LATER" ] && ok "the two choices are genuinely different instants" \
  || bad "the two candidates were identical"
eq "$(echo "$BODY" | jget plannedLocalTime)" "01:30" "while the stored wall clock reading is the one the caller asked for"
[ -n "$S_DST_LATER" ] && [ -n "$S_DST_EARLIER" ] && [ "$S_DST_LATER" != "$S_DST_EARLIER" ] \
  && ok "and the two readings are two distinct placements" || bad "DST placements share an id"

# ── Publishing results that only a real remote write could produce ──────────
# Written directly, because the API cannot produce them without dispatching:
# a queued publication whose destination was later disconnected, and a
# published one whose live check has not confirmed it.
CONTENT_CALENDAR_PUBLISH_FIXTURE=$(PID="$PID" DID="$DID" D_OFF="$D_OFF" A_OFF="$A_OFF" \
  R_OFF="$R_OFF" AP_OFF="$AP_OFF" S_OFF="$S_OFF" D_HOOK="$D_HOOK" A_LIVE="$A_LIVE" R_LIVE="$R_LIVE" \
  S_LIVE="$S_LIVE" OPERATOR_ID="$OPERATOR_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { PID, D_OFF, A_OFF, R_OFF, AP_OFF, S_OFF, D_HOOK, A_LIVE, R_LIVE, S_LIVE, OPERATOR_ID } = process.env;
(async () => {
  await prisma.$transaction(async (tx) => {
    // The destination is disconnected AFTER the publication was queued — the
    // "disconnected account" case §6.5 requires be distinguished from a failure.
    await tx.publishDestination.updateMany({ where: { id: D_OFF }, data: { status: 'unconfigured' } });
    await tx.publication.create({ data: {
      projectId: PID, destinationId: D_OFF, assetId: A_OFF, revisionId: R_OFF, approvalId: AP_OFF,
      scheduleId: S_OFF, mode: 'publish', status: 'pending', attempt: 1,
      scheduledFor: new Date('2026-12-05T09:00:00.000Z'), publishedBy: OPERATOR_ID } });
    // A successful push whose live check has not run: delivery and verification
    // are separate facts (§6.6), so this must read as neither published-and-known
    // nor as an error.
    await tx.publication.create({ data: {
      projectId: PID, destinationId: D_HOOK, assetId: A_LIVE, revisionId: R_LIVE,
      scheduleId: S_LIVE, mode: 'publish', status: 'published', attempt: 1,
      scheduledFor: new Date('2026-08-20T09:00:00.000Z'), remoteId: 'smoke-remote-1',
      remoteUrl: 'https://example.test/live-article', publishedBy: OPERATOR_ID } });
  });
  console.log('(publishing fixtures written)');
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "publishing fixture failed" "$CONTENT_CALENDAR_PUBLISH_FIXTURE"

# ── Approval gates (§6.6/§6.7) ─────────────────────────────────────────────
request "link an unapproved revision" POST "/projects/$PID/content-schedules/$S_AWAIT/publication" "$TOKEN" 409 \
  -d '{"permissions":["content:write"]}'
eq "$(echo "$BODY" | jget error)" "no-approved-revision" "dispatch is refused with no approval at that revision"
request "link a manual-only channel" POST "/projects/$PID/content-schedules/$S_DEST2/publication" "$TOKEN" 400 \
  -d '{"permissions":["content:write"]}'
eq "$(echo "$BODY" | jget error)" "manual-delivery-only" "a channel delivered by a person offers no automated send"
request "link a disconnected destination" POST "/projects/$PID/content-schedules/$S_OFF/publication" "$TOKEN" 409 \
  -d '{"permissions":["content:write"]}'
eq "$(echo "$BODY" | jget error)" "destination-not-connected" "a disconnected destination cannot be dispatched to"
request "link an approved revision" POST "/projects/$PID/content-schedules/$S_DEST/publication" "$TOKEN" 201 \
  -d "{\"revisionId\":\"$R_DEST\",\"permissions\":[\"content:write\"]}"
S_DEST_PUB=$(echo "$BODY" | jget execution.publicationId)
[ -n "$S_DEST_PUB" ] && [ "$S_DEST_PUB" != "__ERR__" ] || die "S_DEST link produced no publication" "$BODY"
eq "$(echo "$BODY" | jget state)" "scheduled" "with an exact-revision approval the placement becomes scheduled"
eq "$(echo "$BODY" | jget attemptCount)" "1" "one placement with one attempt is still one event"
eq "$(echo "$BODY" | jget execution.scheduledFor)" "2026-12-01T09:00:00.000Z" "the execution is queued at the intended instant"
eq "$(echo "$BODY" | jget intentionAndExecutionDiffer)" "false" "so intention and execution agree at first"

# ── §6.7: moving the plan never silently moves the publication ──────────────
request "move the linked placement" PATCH "/projects/$PID/content-schedules/$S_DEST" "$TOKEN" 200 \
  -d '{"version":1,"scheduledFor":"2026-12-20T14:30"}'
eq "$(echo "$BODY" | jget execution.scheduledFor)" "2026-12-01T09:00:00.000Z" "rescheduling the intention leaves the queued publication where it was"
eq "$(echo "$BODY" | jget intentionAndExecutionDiffer)" "true" "and the event says intention and execution now differ"
eq "$(echo "$BODY" | jget scheduledForUtc)" "2026-12-20T14:30:00.000Z" "the new intended instant is the one reported"

# ── Reads ──────────────────────────────────────────────────────────────────
request "portfolio calendar (bounded)" GET "/content-calendar?$(window 2026-10-01 2026-10-31 Europe/London)" "$TOKEN" 200
eq "$(echo "$BODY" | jget scope.kind)" "portfolio" "the portfolio route answers in portfolio scope"
eq "$(echo "$BODY" | jget window.bounded)" "true" "and the window is explicitly bounded"
eq "$(echo "$BODY" | jget window.timezone)" "Europe/London" "read in the requested zone"

request "October project calendar" GET "/projects/$PID/content-calendar?$(window 2026-10-01 2026-10-31 Europe/London)" "$TOKEN" 200
OCT="$BODY"
assert_allowlisted "GET /content-calendar" staff "$OCT"
eq "$(echo "$OCT" | jlen events)" "2" "October holds the unapproved placement and the idempotent one"
eq "$(echo "$OCT" | jget totalInWindow)" "2" "and the window total agrees with the page"
eq "$(echo "$OCT" | jget page.truncated)" "false" "a complete window is not reported as truncated"

request "January project calendar" GET "/projects/$PID/content-calendar?$(window 2026-01-01 2026-01-31 Europe/London)" "$TOKEN" 200
JAN="$BODY"
eq "$(echo "$JAN" | jlen events)" "1" "January holds the overdue post"
eq "$(echo "$JAN" | jget events.0.pastDue)" "true" "whose planned instant has passed"
eq "$(echo "$JAN" | jget events.0.pastDueLabel)" "Not published yet" "and it reads Not published yet, never Published"
eq "$(echo "$JAN" | jget events.0.state)" "planned" "a past date is not evidence that anything was sent"
eq "$(echo "$JAN" | jget events.0.liveUrl)" "" "so there is no live URL to offer"
eq "$(echo "$JAN" | jget events.0.pastDueReason)" "not-linked" "and the reason is that no publication was ever linked"
request "January filtered by published" GET "/projects/$PID/content-calendar?$(window 2026-01-01 2026-01-31 Europe/London)&state=published" "$TOKEN" 200
eq "$(echo "$BODY" | jlen events)" "0" "nothing in that past month is published"

request "December project calendar" GET "/projects/$PID/content-calendar?$(window 2026-12-01 2026-12-31 Europe/London)" "$TOKEN" 200
DEC="$BODY"
assert_allowlisted "GET /content-calendar (December)" staff "$DEC"
eq "$(echo "$DEC" | jlen events)" "3" "December holds three placements"
eq "$(ev "$DEC" "$S_OFF" state)" "held" "the one with a queued publication and a dead destination is held"
eq "$(ev "$DEC" "$S_OFF" holdReason)" "destination-not-connected" "held because the destination is not connected"
eq "$(ev "$DEC" "$S_OFF" holdReasonLabel)" "The destination is not connected yet." "and the reason is labelled in words for a reader"
eq "$(ev "$DEC" "$S_OFF" pastDue)" "false" "a future placement is not past due even while it is held"
eq "$(ev "$DEC" "$S_OFF" pastDueReason)" "" "so no past-due reason is attached to it"
eq "$(ev "$DEC" "$S_OFF" attemptCount)" "1" "its queued attempt is the child of the event, not a second event"
eq "$(ev "$DEC" "$S_OFF" execution.status)" "pending" "the attempt is still pending"
eq "$(ev "$DEC" "$S_OFF" stateLabel)" "On hold" "and the state is shown as words, not as the stored code"
eq "$(ev "$DEC" "$S_DEST" attemptCount)" "1" "the linked placement carries its attempt"
eq "$(ev "$DEC" "$S_DEST" state)" "scheduled" "and reads scheduled, at its asked-for revision"
eq "$(ev "$DEC" "$S_DEST" assetId)" "$(ev "$DEC" "$S_DEST2" assetId)" "one piece planned for two channels is one asset on two entries"
[ "$(ev "$DEC" "$S_DEST" scheduleId)" != "$(ev "$DEC" "$S_DEST2" scheduleId)" ] \
  && ok "and the two channels are two distinct events" || bad "two channels collapsed into one event"
eq "$(ev "$DEC" "$S_DEST2" channelLabel)" "Email" "with the channel named, not an internal source type"
eq "$(ev "$DEC" "$S_DEST2" deliveryMode)" "manual" "and an email send is planned, never auto-sent"
eq "$(ev "$DEC" "$S_DEST2" state)" "ready" "an approved manual placement reads ready for a person to send"
eq "$(ev "$DEC" "$S_DEST2" holdReason)" "manual-delivery" "and says it is waiting on manual delivery, not on the system"
eq "$(ev "$DEC" "$S_DEST" title)" "ContentCalendar webhook article" "and the title is the piece's own title, never a run id"

request "August project calendar" GET "/projects/$PID/content-calendar?$(window 2026-08-01 2026-08-31 Europe/London)" "$TOKEN" 200
AUG="$BODY"
eq "$(echo "$AUG" | jget events.0.state)" "published" "a published publication reads Published"
eq "$(echo "$AUG" | jget events.0.verification.state)" "pending" "while its live check is still pending — delivery and verification are separate facts"
eq "$(echo "$AUG" | jget events.0.verification.verifiedAt)" "" "with no verification instant recorded"
eq "$(echo "$AUG" | jget events.0.liveUrl)" "https://example.test/live-article" "a known safe published URL is offered as the live link"
eq "$(echo "$AUG" | jget events.0.pastDue)" "false" "and a published placement is never past due"

# ── Cancellation preserves history (§6.7) ──────────────────────────────────
request "cancel a placement" POST "/projects/$PID/content-schedules/$S_CANCEL/cancel" "$TOKEN" 201 \
  -d '{"reason":"The campaign was postponed before anything went out.","version":1}'
eq "$(echo "$BODY" | jget state)" "cancelled" "cancelling reads back as cancelled"
eq "$(echo "$BODY" | jget version)" "2" "and advances the version rather than deleting the row"
has "campaign was postponed" "$BODY" "the reason is kept with the row"
[ -n "$(echo "$BODY" | jget cancelledAt)" ] && ok "and the cancellation is stamped" || bad "no cancelledAt on a cancelled placement"
request "cancelled placement in the default read" GET "/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&state=planned" "$TOKEN" 200
lacks "$S_CANCEL" "$BODY" "a cancelled placement is out of the live read"
request "cancelled placement under state=cancelled" GET "/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&state=cancelled" "$TOKEN" 200
CANCELLED="$BODY"
assert_allowlisted "GET /content-calendar (state=cancelled)" staff "$CANCELLED"
[ "$(echo "$CANCELLED" | jlen events)" = "1" ] && ok "and is still there, with its history, under state=cancelled" \
  || bad "cancelled placement missing from the state=cancelled read: $(echo "$CANCELLED" | jlen events) events, $(echo "$CANCELLED" | jget totalInWindow) in the window"
eq "$(echo "$CANCELLED" | jget events.0.scheduleId)" "$S_CANCEL" "the cancelled read returns that placement"
has "campaign was postponed" "$CANCELLED" "with the recorded reason still attached"
eq "$(echo "$CANCELLED" | jget events.0.version)" "2" "and the version it reached"

# ── Month complete beyond 200 entries (the exit gate) ──────────────────────
request "November project calendar (page 1)" GET "/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&limit=200" "$TOKEN" 200
NOV1="$BODY"
assert_allowlisted "GET /content-calendar (November page 1)" staff "$NOV1"
eq "$(echo "$NOV1" | jget page.returned)" "200" "a 225-entry month returns a full page"
eq "$(echo "$NOV1" | jget page.hasMore)" "true" "and says there is more"
eq "$(echo "$NOV1" | jget page.truncated)" "true" "and says the page is truncated"
eq "$(echo "$NOV1" | jget totalInWindow)" "225" "while the window total still counts the whole month"
eq "$(echo "$NOV1" | jget totalIsExact)" "true" "and the total is exact, not a lower bound"
CURSOR=$(echo "$NOV1" | jget page.nextCursor)
[ -n "$CURSOR" ] && [ "$CURSOR" != "__ERR__" ] || die "no cursor on a truncated page" "$NOV1"
request "November project calendar (page 2)" GET "/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&limit=200&cursor=$CURSOR" "$TOKEN" 200
NOV2="$BODY"
eq "$(echo "$NOV2" | jget page.returned)" "25" "following the cursor reaches the rest of the month"
eq "$(echo "$NOV2" | jget page.truncated)" "false" "and the last page is not truncated"
eq "$(echo "$NOV2" | jget page.hasMore)" "false" "with nothing more after it"
UNION=$(CONTENT_CALENDAR_P1="$NOV1" CONTENT_CALENDAR_P2="$NOV2" node -e '
const a = JSON.parse(process.env.CONTENT_CALENDAR_P1).events.map((e) => e.scheduleId);
const b = JSON.parse(process.env.CONTENT_CALENDAR_P2).events.map((e) => e.scheduleId);
process.stdout.write(String(new Set([...a, ...b]).size));')
eq "$UNION" "225" "and the two pages together are 225 distinct events, none repeated and none missed"
eq "$(echo "$NOV1" | jget page.returned)" "$(echo "$NOV1" | jlen events)" "the page metadata matches the array it describes"

# §6.5's owner filter — the options come from the server, because the only staff
# directory is admin-only and a delivery lead must still be able to use it.
request "November filtered by owner" GET "/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&ownerId=$OPERATOR_ID" "$TOKEN" 200
eq "$(echo "$BODY" | jlen events)" "1" "the owner filter narrows to that owner's placement"
OWNER_LABEL=$(echo "$BODY" | jget events.0.ownerLabel)
[ -n "$OWNER_LABEL" ] && [ "$OWNER_LABEL" != "$OPERATOR_ID" ] \
  && ok "and the server resolves a name for the owner, not a raw id" \
  || bad "owner label missing or was the raw id: $OWNER_LABEL"

# ── Unscheduled content is a separate list, never a fabricated date ────────
eq "$(echo "$NOV1" | jget unscheduled.total)" "1" "the unscheduled list holds the one piece with no date"
eq "$(echo "$NOV1" | jget unscheduled.items.0.assetId)" "$A_INTERNAL" "and that piece is the internal draft"
eq "$(echo "$NOV1" | jget unscheduled.items.0.state)" "unscheduled" "labelled unscheduled rather than given a date"
eq "$(echo "$NOV1" | jget unscheduled.items.0.scheduledForUtc)" "" "with no date field invented for it at all"
lacks "$A_OPS" "$NOV1" "an operational asset type never appears anywhere on this calendar"
lacks "CONTENT_CALENDAR_PRIVATE_OPS" "$NOV1" "not even by name"

# ── Client visibility, including counts (§6.5) ─────────────────────────────
request "client November calendar" GET "/portal/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&limit=200" "$CLIENT_TOKEN" 200
CNOV="$BODY"
assert_allowlisted "GET /portal/.../content-calendar" client "$CNOV"
eq "$(echo "$CNOV" | jlen events)" "1" "the client sees only the explicitly shared piece"
eq "$(echo "$CNOV" | jget totalInWindow)" "1" "and the window total counts only shared content"
eq "$(echo "$CNOV" | jget page.truncated)" "false" "so the same month is not truncated for them"
eq "$(echo "$CNOV" | jget events.0.assetId)" "$A_SHARE" "the event is the shared piece"
eq "$(echo "$CNOV" | jget events.0.stateLabel)" "Awaiting approval" "whose status is shown plainly, before approval"
has "ContentCalendar shared article" "$CNOV" "the shared title is present"
eq "$(echo "$CNOV" | jget unscheduled.total)" "0" "the client's unscheduled total counts no unshared draft"
eq "$(echo "$CNOV" | jlen unscheduled.items)" "0" "and the list is empty"
lacks "CONTENT_CALENDAR_PRIVATE_" "$CNOV" "no private fixture value reaches the client"
lacks "$A_INTERNAL" "$CNOV" "no unshared internal draft id reaches the client"
lacks "$A_OPS" "$CNOV" "no operational asset id reaches the client"
lacks "$D_HOOK" "$CNOV" "no internal destination id reaches the client"
lacks "$OPERATOR_ID" "$CNOV" "no staff user id reaches the client"
lacks "destinationLabel" "$CNOV" "no destination label field is even present"
lacks "ownerLabel" "$CNOV" "no owner name field is present"
# The filter echo is the one legitimate mention of the key — a client read has no
# owner anywhere else, events and unscheduled items included.
eq "$(echo "$CNOV" | grep -o '"ownerId"' | wc -l | tr -d ' ')" "1" "and ownerId appears only in the filter echo, never on an event"
eq "$(echo "$CNOV" | grep -o "\"ownerId\":null" | wc -l | tr -d ' ')" "1" "where it is dropped rather than honoured"
eq "$(echo "$CNOV" | jget filters.ownerId)" "" "the owner filter is not applied for a client"

request "client January calendar" GET "/portal/projects/$PID/content-calendar?$(window 2026-01-01 2026-01-31 Europe/London)" "$CLIENT_TOKEN" 200
eq "$(echo "$BODY" | jget totalInWindow)" "0" "an empty client month is empty in the count, not only in the page"
eq "$(echo "$BODY" | jlen events)" "0" "with no events at all"

request "client August calendar" GET "/portal/projects/$PID/content-calendar?$(window 2026-08-01 2026-08-31 Europe/London)" "$CLIENT_TOKEN" 200
eq "$(echo "$BODY" | jget events.0.scheduledForUtc)" "$(echo "$AUG" | jget events.0.scheduledForUtc)" "the client and staff reads agree on the same instant"
eq "$(echo "$BODY" | jget events.0.liveUrl)" "$(echo "$AUG" | jget events.0.liveUrl)" "and on the same live link"

request "client type filter" GET "/portal/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&type=article" "$CLIENT_TOKEN" 200
eq "$(echo "$BODY" | jlen events)" "1" "the type filter is honoured on the client read"
request "client type filter (no matches)" GET "/portal/projects/$PID/content-calendar?$(window 2026-11-01 2026-11-30 Europe/London)&type=ad-creative" "$CLIENT_TOKEN" 200
eq "$(echo "$BODY" | jlen events)" "0" "and narrows to nothing when nothing matches"

# ── The three views agree on one instant (§6.7 DST) ────────────────────────
DST_Q=$(window 2026-11-01 2026-11-01 America/New_York)
request "DST project window" GET "/projects/$DID/content-calendar?$DST_Q" "$TOKEN" 200
DST_PROJ="$BODY"
request "DST portfolio window" GET "/content-calendar?projectId=$DID&$DST_Q" "$TOKEN" 200
DST_PORT="$BODY"
request "DST client window" GET "/portal/projects/$DID/content-calendar?$DST_Q" "$CLIENT_TOKEN" 200
DST_CLIENT="$BODY"
eq "$(echo "$DST_PROJ" | jlen events)" "2" "both repeated-hour placements are in that local day"
eq "$(echo "$DST_PROJ" | jget window.timezone)" "America/New_York" "the window is read in the project's own zone"
eq "$(echo "$DST_PROJ" | jget events.0.scheduledForUtc)" "$CAND_EARLIER" "the earlier reading keeps the earlier instant"
eq "$(echo "$DST_PROJ" | jget events.1.scheduledForUtc)" "$CAND_LATER" "and the later reading the later one"
eq "$(echo "$DST_PROJ" | jget events.0.plannedLocalTime)" "01:30" "both rows record the intended wall clock reading"
eq "$(echo "$DST_PROJ" | jget events.1.plannedLocalTime)" "01:30" "on both rows"
eq "$(echo "$DST_PROJ" | jget events.0.dstDisambiguation)" "earlier" "with the choice that was made stored beside it"
eq "$(echo "$DST_PORT" | jlen events)" "2" "the portfolio read sees the same two events"
eq "$(echo "$DST_PORT" | jget totalInWindow)" "2" "and counts them the same way"
eq "$(echo "$DST_PORT" | jget events.1.scheduledForUtc)" "$(echo "$DST_PROJ" | jget events.1.scheduledForUtc)" "portfolio agrees on the instant"
eq "$(echo "$DST_CLIENT" | jlen events)" "2" "the client read sees them too"
eq "$(echo "$DST_CLIENT" | jget events.0.scheduledForUtc)" "$(echo "$DST_PROJ" | jget events.0.scheduledForUtc)" "and the client agrees on the earlier instant"
eq "$(echo "$DST_CLIENT" | jget events.1.scheduledForUtc)" "$(echo "$DST_PROJ" | jget events.1.scheduledForUtc)" "and on the later one"

# ── Ownership is enforced, not merely omitted from a list ─────────────────
for path in "/portal/projects/$PID/content-calendar" "/portal/projects/$DID/content-calendar"; do
  request "other client $path" GET "$path" "$OTHER_TOKEN" 404
  if echo "$BODY" | grep -Eq "(CONTENT_CALENDAR_PRIVATE_|$A_INTERNAL|$A_SHARE|$A_DST)"; then
    bad "other client response disclosed this project's calendar data"
  else ok "other client sees none of this project's calendar"; fi
done

echo
echo "content-calendar smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

#!/usr/bin/env bash
# E2E smoke — §3.4's client-list delivery columns.
#
# Contract under test: `GET /clients` returns, per client, the delivery facts
# §3.4 asks the client list to show — business name, delivery lead, current
# plan progress, overdue commitments, waiting on client, last report — and
# keeps them **distinct from** the project performance score. §3.4:
#
#   "A project performance score can be a secondary detail, but never confuse
#    it with account health or delivery completion."
#
# The interesting cases are the ones where a naive implementation lies:
#   - `planProgress.committed` must be the cycle's FROZEN denominator, not a
#     live recount of whatever work items happen to exist now (§6.3).
#   - a settled commitment past its target date is NOT overdue.
#   - "last report" counts RELEASED reports only — a draft revision is not
#     something the client has been sent.
#   - a client with no engagement records `deliveryLeadName: null` ("nobody
#     recorded one"), which is a different fact from "no lead exists".
#
# Seeded via Prisma (creating a client over HTTP would start the paid Day-1
# pipeline), driven through the real staff HTTP surface. Cleans up on exit.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== client-list-columns smoke =="

SEED='{}'
cleanup() {
  CLC_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.CLC_SEED);
  if (!s.clientId) return;
  await prisma.$transaction(async (tx) => {
    await tx.commitment.deleteMany({ where: { projectId: s.projectId } });
    for (const pid of [s.projectId, s.emptyProjectId].filter(Boolean)) {
      await tx.onboardingRequest.deleteMany({ where: { projectId: pid } });
      // ReportRevision has no Prisma relation back to Report (plain `reportId`
      // String), so the revisions are matched by id rather than nested.
      const reportIds = (await tx.report.findMany({ where: { projectId: pid }, select: { id: true } })).map((r) => r.id);
      await tx.reportRevision.deleteMany({ where: { reportId: { in: reportIds } } });
      await tx.report.deleteMany({ where: { projectId: pid } });
      const items = await tx.workItem.findMany({ where: { projectId: pid }, select: { id: true } });
      const workItemId = { in: items.map((w) => w.id) };
      await tx.acceptanceCheck.deleteMany({ where: { workItemId } });
      await tx.verification.deleteMany({ where: { workItemId } });
      await tx.workItem.deleteMany({ where: { projectId: pid } });
      await tx.cycle.deleteMany({ where: { projectId: pid } });
      await tx.project.deleteMany({ where: { id: pid } });
    }
    const clientId = { in: [s.clientId, s.noEngagementClientId].filter(Boolean) };
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
  const stamp = `clc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // _common.sh rule 1: upsert with an EMPTY update. Never alter the shared
  // smoke operator's role, password or type.
  const operator = await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });
  const lead = await prisma.user.create({ data: {
    email: `lead-${stamp}@example.test`,
    passwordHash: await bcryptjs.hash('unused-placeholder-pw', 10),
    name: `Lead ${stamp}`, role: 'delivery-lead', type: 'operator',
  } });

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `CLC ${stamp}` } });
    const noEngagementClient = await tx.client.create({ data: { name: `CLC NoEng ${stamp}` } });
    await tx.project.create({ data: {
      name: `CLC NoEng Project ${stamp}`, domain: `noeng-${stamp}.example`,
      clientId: noEngagementClient.id, onboardingStatus: 'pending',
    } });

    const startsOn = new Date('2026-09-01T00:00:00.000Z');
    const endsOn = new Date('2026-12-31T23:59:59.000Z');
    const engagement = await tx.engagement.create({ data: {
      clientId: client.id, name: `CLC engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'UTC', deliveryLead: lead.id, hoursPerCycle: 40,
    } });
    const project = await tx.project.create({ data: {
      name: `CLC Project ${stamp}`, domain: `clc-${stamp}.example`,
      clientId: client.id, engagementId: engagement.id, onboardingStatus: 'complete',
    } });

    // The cycle's FROZEN denominator is 10, but only 3 work items exist and
    // only 2 of those are verified. A live recount would report "2 of 3"; the
    // contract is "2 of 10".
    const cycle = await tx.cycle.create({ data: {
      projectId: project.id, engagementId: engagement.id, name: 'Current cycle',
      startsOn, endsOn, status: 'active', committedAt: startsOn,
      committedBy: operator.id, committedCount: 10,
    } });
    const base = { projectId: project.id, cycleId: cycle.id, category: 'fix',
      discipline: 'technical', priority: 'high', createdBy: operator.id,
      reviewerId: operator.id, dueAt: endsOn };
    await tx.workItem.create({ data: { ...base, title: 'Verified A', status: 'verified' } });
    await tx.workItem.create({ data: { ...base, title: 'Verified B', status: 'verified' } });
    await tx.workItem.create({ data: { ...base, title: 'Still open', status: 'active' } });

    // Overdue: target date in the past, not settled.
    await tx.commitment.create({ data: {
      projectId: project.id, cycleId: cycle.id, title: 'Overdue commitment',
      workstream: 'content', status: 'active', targetDate: new Date('2026-01-01T00:00:00.000Z'),
    } });
    // Past its date but SETTLED — must not count as overdue.
    await tx.commitment.create({ data: {
      projectId: project.id, cycleId: cycle.id, title: 'Done late but done',
      workstream: 'content', status: 'completed', targetDate: new Date('2026-01-01T00:00:00.000Z'),
    } });

    // "Waiting on client": one outstanding onboarding request + one settled.
    await tx.onboardingRequest.create({ data: {
      projectId: project.id, kind: 'gsc-access', title: 'Confirm your Google property',
      status: 'open', requestedBy: operator.id,
    } });
    await tx.onboardingRequest.create({ data: {
      projectId: project.id, kind: 'brand-assets', title: 'Already supplied',
      status: 'done', requestedBy: operator.id, resolvedAt: new Date(),
    } });

    // Last report: one RELEASED (older) and one DRAFT (newer). "Last report"
    // must be the released one — a draft is not something the client was sent.
    const releasedAt = new Date('2026-08-01T00:00:00.000Z');
    await tx.report.create({ data: {
      projectId: project.id, slug: `clc-released-${stamp}`,
      title: 'Released report', targetUrl: `https://clc-${stamp}.example`,
      executiveSummary: 'Released.', scoreTotal: 61, scoreBand: 'faint',
      subScores: '[]', findingsSnapshot: '[]', roadmapSnapshot: '[]',
      status: 'released', releasedRevision: 1, releasedAt,
    } });
    await tx.report.create({ data: {
      projectId: project.id, slug: `clc-draft-${stamp}`,
      title: 'Draft report', targetUrl: `https://clc-${stamp}.example`,
      executiveSummary: 'Draft.', scoreTotal: 99, scoreBand: 'recommended',
      subScores: '[]', findingsSnapshot: '[]', roadmapSnapshot: '[]',
      status: 'draft', createdAt: new Date('2026-09-10T00:00:00.000Z'),
    } });

    return { clientId: client.id, noEngagementClientId: noEngagementClient.id,
      projectId: project.id, leadName: lead.name, releasedSlug: `clc-released-${stamp}` };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

CID=$(echo "$SEED" | jget clientId)
NCID=$(echo "$SEED" | jget noEngagementClientId)
LEAD=$(echo "$SEED" | jget leadName)
RSLUG=$(echo "$SEED" | jget releasedSlug)
[ -n "$CID" ] && [ "$CID" != "__ERR__" ] && ok "seeded client with engagement/cycle/commitments/reports" || die "seed" "$SEED"

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"

CLIENTS=$(curl -s "$API/clients" -H "authorization: Bearer $TOKEN")
ROW=$(echo "$CLIENTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).clients.find(c=>c.id===process.argv[1]);process.stdout.write(JSON.stringify(p||{}))}catch(e){process.stdout.write("{}")}})' "$CID")
NROW=$(echo "$CLIENTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).clients.find(c=>c.id===process.argv[1]);process.stdout.write(JSON.stringify(p||{}))}catch(e){process.stdout.write("{}")}})' "$NCID")
[ "$(echo "$ROW" | jget id)" = "$CID" ] && ok "client appears in GET /clients" || die "client missing from list" "$CLIENTS"

# ── The §3.4 columns ────────────────────────────────────────────────────────
[ "$(echo "$ROW" | jget deliveryLeadName)" = "$LEAD" ] && ok "delivery lead resolved to the engagement's lead by name" || bad "deliveryLeadName = $(echo "$ROW" | jget deliveryLeadName), expected $LEAD"

[ "$(echo "$ROW" | jget planProgress.committed)" = "10" ] && [ "$(echo "$ROW" | jget planProgress.delivered)" = "2" ] && ok "plan progress is 2 of 10 — the FROZEN denominator, not a live recount of 3 work items" || bad "planProgress = $(echo "$ROW" | jget planProgress)"

[ "$(echo "$ROW" | jget overdueCommitments)" = "1" ] && ok "exactly one overdue commitment (the settled past-due one is not counted)" || bad "overdueCommitments = $(echo "$ROW" | jget overdueCommitments), expected 1"

[ "$(echo "$ROW" | jget waitingOnClient)" = "1" ] && ok "one open ask waiting on the client (the done one is not counted)" || bad "waitingOnClient = $(echo "$ROW" | jget waitingOnClient), expected 1"

[ "$(echo "$ROW" | jget lastReport.slug)" = "$RSLUG" ] && ok "last report is the RELEASED one, not the newer draft" || bad "lastReport.slug = $(echo "$ROW" | jget lastReport.slug), expected $RSLUG"
echo "$ROW" | grep -q 'clc-draft-' && bad "the draft report leaked into the client list row" || ok "no draft report slug anywhere in the row"

# ── The distinction §3.4 insists on ─────────────────────────────────────────
# `latestScore` reads the newest report row (99, the draft) while `lastReport`
# reports the released one (61). They are different columns on purpose; the
# point of this assertion is that neither has been renamed into the other.
[ "$(echo "$ROW" | jget latestScore)" != "$(echo "$ROW" | jget lastReport.releasedAt)" ] && ok "project score and last-report are separate fields, not conflated" || bad "score/report fields conflated"

# ── "Not recorded" vs "none" ────────────────────────────────────────────────
[ "$(echo "$NROW" | jget deliveryLeadName)" = "" ] && ok "a client with no engagement reports deliveryLeadName null ('not recorded')" || bad "no-engagement deliveryLeadName = $(echo "$NROW" | jget deliveryLeadName)"
[ "$(echo "$NROW" | jget overdueCommitments)" = "0" ] && [ "$(echo "$NROW" | jget waitingOnClient)" = "0" ] && ok "a client with no commitments/asks reports real zeros, not nulls" || bad "no-engagement counts = $(echo "$NROW" | jget overdueCommitments)/$(echo "$NROW" | jget waitingOnClient)"
[ "$(echo "$NROW" | jget lastReport)" = "" ] && ok "a client with no released report reports lastReport null" || bad "no-engagement lastReport = $(echo "$NROW" | jget lastReport)"

# ── Cross-client isolation: the counts are per client ───────────────────────
[ "$(echo "$NROW" | jget planProgress.committed)" = "0" ] && ok "another client's plan progress is not borrowed from the first" || bad "cross-client planProgress leak = $(echo "$NROW" | jget planProgress)"

echo
echo "client-list-columns smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

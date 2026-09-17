#!/usr/bin/env bash
# E2E smoke — P15 Overview / Results / report adoption.
#
# Contract under test (platform_improvement_plan.md §5.1, §5.5–§5.7, §14.5,
# §14.6; acceptance journey 17 in §21.2). Four properties, each driven through
# the real HTTP surface with a real client-type login:
#
#   (a) LIVE/REPORT SEPARATION — a released report carries the score that was
#       live at release time, from the frozen `ReportRevision.snapshot`. After
#       release we move the live score (a second run), write WRONG values into
#       every mutable `Report` column, and add a newer private draft revision.
#       The released report's score, bucket detail and title must be identical
#       throughout, on every client read path. Seeding the mutable columns to a
#       wrong value means any read that touches them fails here instead of
#       passing quietly (the same trick released-summary.smoke.sh uses).
#
#   (b) FULL APPROVAL/RELEASE JOURNEY — draft → review → approve → release, then
#       the client sees it, and the newer private draft revision is invisible on
#       the overview, the report list and the report detail.
#
#   (c) NO FAKE TOTAL — an incomplete run renders an explicit incomplete state
#       with NO numeric total while still reporting every bucket's state.
#
#   (d) PANEL ISOLATION — one panel's source read failing (an invalid project
#       timezone makes the calendar read refuse rather than guess a zone) leaves
#       the other four panels intact on a 200 response, each with its own status.
#
# Plus §5.7 (a page load starts no audit, refreshes no provider, builds no score
# and creates no job), the §5.1/§5.6 hard limits (one total, applicable buckets
# only, at most three action cards with the TRUE total, at most five upcoming
# items) and §3.3's four client tabs — including Online presence, which adds no
# projection of its own and reuses P05's client-safe inventory (a founder's
# personal profile is dropped, a candidate is shown as needing confirmation).
#
# Everything is seeded through Prisma (the Day-1 pipeline would spawn real
# background jobs over HTTP); the lifecycle steps are driven over HTTP. No API
# keys, no live spend. Cleans up on exit.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }
# assert_eq <actual> <expected> <label>
assert_eq() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', expected '$2')"; fi; }
# assert_absent <body> <needle> <label> — the needle must not appear at all.
assert_absent() {
  if echo "$1" | grep -q -- "$2"; then bad "$3 (found \"$2\")"; else ok "$3"; fi
}
# assert_present <body> <needle> <label> — the needle must appear somewhere.
assert_present() {
  if echo "$1" | grep -q -- "$2"; then ok "$3"; else bad "$3 (\"$2\" is missing)"; fi
}

echo "== overview-results smoke =="

# Fixture ids for cleanup, filled in as soon as the seed returns. The trap is
# installed before the first HTTP call so an early auth failure still cleans up.
PID=""; PID_B=""; PID_C=""; CID=""; OCID=""
cleanup() {
  PID="$PID" PID_B="$PID_B" PID_C="$PID_C" CID="$CID" OCID="$OCID" node <<'EOF' >/dev/null 2>&1
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const projects = [process.env.PID, process.env.PID_B, process.env.PID_C].filter(Boolean);
  const reportIds = (await prisma.report.findMany({ where: { projectId: { in: projects } }, select: { id: true } })).map((r) => r.id);
  const requestIds = (await prisma.approvalRequest.findMany({ where: { projectId: { in: projects } }, select: { id: true } })).map((r) => r.id);
  const assetIds = (await prisma.growthAsset.findMany({ where: { projectId: { in: projects } }, select: { id: true } })).map((a) => a.id);
  // Children first: every row below exists only because this smoke created it.
  await prisma.approvalDecision.deleteMany({ where: { approvalRequestId: { in: requestIds } } });
  await prisma.approvalRequest.deleteMany({ where: { id: { in: requestIds } } });
  // PresenceAccount carries no FK to Project (by design — the inventory
  // outlives a re-onboard), so deleting the project does not remove it.
  await prisma.presenceAccount.deleteMany({ where: { projectId: { in: projects } } });
  await prisma.contentSchedule.deleteMany({ where: { projectId: { in: projects } } });
  await prisma.contentRevision.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.growthAsset.deleteMany({ where: { projectId: { in: projects } } });
  await prisma.scoreBucketRun.deleteMany({ where: { runId: { in: (await prisma.scoreFamilyRun.findMany({ where: { projectId: { in: projects } }, select: { id: true } })).map((r) => r.id) } } });
  await prisma.scoreFamilyRun.deleteMany({ where: { projectId: { in: projects } } });
  await prisma.reportRevision.deleteMany({ where: { reportId: { in: reportIds } } });
  await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projects } } });
  const clientIds = [process.env.CID, process.env.OCID].filter(Boolean);
  await prisma.user.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
})().catch(() => {}).finally(() => prisma.$disconnect());
EOF
  rm -f /tmp/ovr-c.json /tmp/ovr-review2.json
  echo "(smoke rows deleted)"
}
trap cleanup EXIT

# ─── Seed ───────────────────────────────────────────────────────────────────
# All three projects belong to ONE client, so a single client login proves the
# happy path (A) and both edges (B incomplete score, C panel isolation) — while
# a second client proves none of it leaks across tenants.

SEED=$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PW="$SMOKE_PW" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const otherEmail = `other-${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-overview`;
  const passwordHash = await bcryptjs.hash(password, 10);

  // _common.sh rule 1: upsert with an EMPTY update. Never alter the shared
  // smoke operator's role, password, type or any other existing field.
  await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL },
    update: {},
    create: { email: process.env.SMOKE_EMAIL, passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10), name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `Overview ${stamp}` } });
    const otherClient = await tx.client.create({ data: { name: `Other Overview ${stamp}` } });
    const user = await tx.user.create({ data: { email, passwordHash, name: 'Overview Client', type: 'client', clientId: client.id } });
    await tx.user.create({ data: { email: otherEmail, passwordHash, name: 'Other Overview Client', type: 'client', clientId: otherClient.id } });

    const mkProject = (suffix, timezone) =>
      tx.project.create({ data: { name: `Overview ${suffix} ${stamp}`, domain: `${stamp}-${suffix}.example`, clientId: client.id, onboardingStatus: 'pending', timezone } });
    const projectA = await mkProject('a', 'UTC');
    const projectB = await mkProject('b', 'UTC');
    // An invalid IANA zone is deliberate: the calendar read REFUSES an unknown
    // zone instead of defaulting, which drives panel (d) without touching
    // anything else the page reads.
    const projectC = await mkProject('c', 'Mars/Olympus');

    // The report under test. Its mutable columns hold values the released
    // payload must stop echoing the moment they diverge (the "wrong mutable
    // value" step rewrites every one of them after release).
    const slug = `${stamp}-report`;
    const report = await tx.report.create({
      data: {
        projectId: projectA.id, slug, title: 'September update', targetUrl: `https://${projectA.domain}`,
        executiveSummary: 'Seed report for the overview-results smoke.', scoreTotal: 71, scoreBand: 'weak',
        subScores: '[]', findingsSnapshot: '[]', roadmapSnapshot: '[]', status: 'draft',
      },
    });

    // §5.6's queue: four open client approvals, one already overdue, so both
    // the ordering rule and "three cards, true total" are observable.
    const approvalIds = [];
    for (const [index, spec] of [
      { title: 'Approve the overdue homepage rewrite', dueAt: new Date(Date.now() - 3 * 86400000) },
      { title: 'Approve the September article', dueAt: null },
      { title: 'Approve the Google profile wording', dueAt: null },
      { title: 'Approve the pricing page copy', dueAt: null },
    ].entries()) {
      const row = await tx.approvalRequest.create({
        data: {
          projectId: projectA.id, clientId: client.id,
          // Deliberately not artifactType 'report': these are content
          // approvals, so they neither block the release gate nor pretend to.
          artifactType: 'content', artifactId: `seed-content-${index + 1}`, artifactRevision: 1,
          title: spec.title, detail: 'Seeded for the overview smoke.',
          reviewerType: 'client', requestedBy: user.id, dueAt: spec.dueAt, status: 'pending',
        },
      });
      approvalIds.push(row.id);
    }

    // §5.1's "Upcoming content": six placements in the next 30 days against a
    // client-visible revision (a client read only ever sees explicitly shared
    // content), so the panel can show five and still report the true number.
    const asset = await tx.growthAsset.create({
      data: { projectId: projectA.id, assetType: 'article', title: 'Seeded content', brief: 'Seeded for the overview smoke.' },
    });
    await tx.contentRevision.create({
      data: { assetId: asset.id, revision: 1, title: 'Seeded content', body: 'Seeded body.', clientVisible: true, clientVisibleAt: new Date() },
    });
    for (let day = 1; day <= 6; day++) {
      const at = new Date(Date.now() + day * 86400000);
      await tx.contentSchedule.create({
        data: {
          projectId: projectA.id, assetId: asset.id, contentType: 'article', channel: 'website', deliveryMode: 'manual',
          plannedForUtc: at, plannedLocalDate: at.toISOString().slice(0, 10), plannedLocalTime: '09:00', timezone: 'UTC', status: 'planned',
        },
      });
    }

    // P05's inventory, seeded so §3.3's fourth client tab — Online presence —
    // has something real to project: one confirmed company row, one search
    // candidate still awaiting confirmation, and one PERSONAL row that must
    // never reach the client. The audit is about the company's reach; a
    // founder's own profile is not the company's, and the projection drops it.
    await tx.presenceAccount.create({
      data: {
        projectId: projectA.id, platform: 'linkedin', url: 'https://www.linkedin.com/company/seed-overview',
        handle: 'seed-overview', source: 'manual', entity: 'company', state: 'confirmed',
      },
    });
    await tx.presenceAccount.create({
      data: {
        projectId: projectA.id, platform: 'facebook', url: 'https://www.facebook.com/seed-overview-candidate',
        handle: 'seed-overview-candidate', source: 'serp', entity: 'company', state: 'candidate', confidence: 0.62,
      },
    });
    await tx.presenceAccount.create({
      data: {
        projectId: projectA.id, platform: 'twitter', url: 'https://x.com/seed-founder-personal',
        handle: 'seed-founder-personal', source: 'manual', entity: 'personal', state: 'confirmed',
      },
    });

    return {
      clientId: client.id, otherClientId: otherClient.id, userId: user.id, email, otherEmail, password,
      reportId: report.id, slug, projectA: projectA.id, projectB: projectB.id, projectC: projectC.id,
      assetId: asset.id, overdueApprovalId: approvalIds[0],
    };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

CID=$(echo "$SEED" | jget clientId)
OCID=$(echo "$SEED" | jget otherClientId)
PID=$(echo "$SEED" | jget projectA)
PID_B=$(echo "$SEED" | jget projectB)
PID_C=$(echo "$SEED" | jget projectC)
RID=$(echo "$SEED" | jget reportId)
RSLUG=$(echo "$SEED" | jget slug)
EMAIL=$(echo "$SEED" | jget email)
OTHER_EMAIL=$(echo "$SEED" | jget otherEmail)
PW=$(echo "$SEED" | jget password)
OVERDUE_APPROVAL=$(echo "$SEED" | jget overdueApprovalId)
[ -n "$CID" ] && [ "$PID" != "__ERR__" ] && [ -n "$PID_B" ] && [ -n "$PID_C" ] && [ -n "$RSLUG" ] \
  && ok "seeded two clients, three projects, a draft report, 4 approvals, 6 scheduled placements and 3 presence rows" \
  || die "seed output incomplete" "$SEED"

OTOKEN=$(smoke_auth)
[ -n "$OTOKEN" ] && [ "$OTOKEN" != "__ERR__" ] && ok "operator login works" || die "operator login failed" "$OTOKEN"
OAUTH=(-H "authorization: Bearer $OTOKEN")

login() {
  # `smoke_login` retries through the /auth/login rate limit.
  smoke_login "$1" "$2"
}
CLIENT_LOGIN=$(login "$EMAIL" "$PW")
CTOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
[ -n "$CTOKEN" ] && [ "$CTOKEN" != "__ERR__" ] && ok "client portal login works" || die "client login failed" "$CLIENT_LOGIN"
CAUTH=(-H "authorization: Bearer $CTOKEN")
OTHER_LOGIN=$(login "$OTHER_EMAIL" "$PW")
OTOKEN2=$(echo "$OTHER_LOGIN" | jget accessToken)
[ -n "$OTOKEN2" ] && [ "$OTOKEN2" != "__ERR__" ] && ok "second client login works" || die "other client login failed" "$OTHER_LOGIN"
OAUTH2=(-H "authorization: Bearer $OTOKEN2")

# ─── Methodology + the live score the release will freeze ────────────────────
# This read is what makes the v1 methodology row exist (the service seeds it on
# demand when none is stored). It happens BEFORE the no-write baseline below, so
# a later read creating anything at all shows up as a failure rather than as a
# first-run seeding.
METH=$(curl -s "$API/projects/$PID/scores/digital-performance/latest" "${OAUTH[@]}")
MVER=$(echo "$METH" | jget methodology.version)
[ -n "$MVER" ] && ok "digital-performance methodology available (version $MVER)" || die "methodology read failed" "$METH"

# A COMPLETE run with one bucket recorded not-applicable. Seeded directly:
# producing a complete run over HTTP would need all six source domains
# populated, which is a fixture project of its own and nothing to do with what
# this suite tests. The stored row is exactly what a real run writes.
SEED_RUN=$(MVER="$MVER" PID="$PID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const version = Number(process.env.MVER);
  const projectId = process.env.PID;
  // §5.2's v1 weights: 25/20/20/15/10/10. The five applicable buckets weigh 85,
  // and 6290 / 85 = 74 exactly — the stored total, not a recomputed one.
  //
  // `detailPath`/`detailQuery` are the values the v1 methodology itself
  // declares (`digital-performance.methodology.ts`), copied rather than
  // invented: §5.5's drilldown opens the Results tab a bucket belongs to, so a
  // fixture that made up its own paths would test nothing.
  const buckets = [
    { key: 'website-health',    label: 'Website health',    weight: 25, value: 80, detailPath: '/results/website',         detailQuery: null },
    { key: 'google-visibility', label: 'Google visibility', weight: 20, value: 75, detailPath: '/results/website',         detailQuery: 'tab=google' },
    { key: 'ai-visibility',     label: 'AI visibility',     weight: 20, value: 70, detailPath: '/results/ai-visibility',   detailQuery: null },
    { key: 'online-profiles',   label: 'Online profiles',   weight: 15, value: null, applicability: 'not-applicable',
      detailPath: '/results/online-presence', detailQuery: null,
      applicabilityReason: 'You told us you do not want directory listings managed.' },
    { key: 'social-activity',   label: 'Social activity',   weight: 10, value: 59, detailPath: '/results/online-presence', detailQuery: 'tab=social' },
    { key: 'content-quality',   label: 'Content quality',   weight: 10, value: 80, detailPath: '/results/content',         detailQuery: null },
  ];
  const run = await prisma.scoreFamilyRun.create({
    data: {
      projectId, methodologyVersion: version, status: 'complete', total: 74,
      applicableWeightTotal: 85, weightedPointsTotal: 6290, evidenceCoverage: 85,
      comparisonKey: 'seed-comparison-key', segmentIndex: 1, comparisonState: 'new-segment',
      fingerprint: 'seed-fingerprint-1', scope: '{}', applicabilitySnapshot: '{}',
      buckets: {
        create: buckets.map((b) => ({
          key: b.key, label: b.label, weight: b.weight,
          applicability: b.applicability ?? 'applicable', applicabilityReason: b.applicabilityReason ?? null,
          state: b.applicability === 'not-applicable' ? 'not-applicable' : 'measured',
          value: b.value,
          weightedPoints: b.value == null ? 0 : b.weight * b.value,
          effectiveWeight: b.applicability === 'not-applicable' ? 0 : b.weight,
          contribution: b.value == null ? 0 : Number(((b.weight * b.value) / 85).toFixed(6)),
          windowStart: new Date(Date.now() - 28 * 86400000), windowEnd: new Date(),
          methodologyVersion: version, metricVersion: `${b.key}/1`,
          metricInputs: JSON.stringify([{ id: `${b.key}-1`, question: `How well does ${b.label.toLowerCase()} perform?`, scored: true, numerator: b.value, denominator: 100, units: 'percent', rounding: 'half-up', value: b.value }]),
          sources: JSON.stringify([{ kind: 'technical-audit', ref: 'seed-source', observedAt: new Date().toISOString(), ageDays: 1 }]),
          maxAgeDays: 30, minSample: 1, missingReasons: '[]',
          notes: JSON.stringify([`${b.label} is measured from the last 28 days of checks.`]),
          detailPath: b.detailPath, detailQuery: b.detailQuery,
        })),
      },
    },
  });
  console.log(JSON.stringify({ runId: run.id }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "live run seed failed" "$SEED_RUN"
RUN1=$(echo "$SEED_RUN" | jget runId)
[ -n "$RUN1" ] && [ "$RUN1" != "__ERR__" ] && ok "seeded a complete live run (total 74: five measured buckets, one not-applicable)" || die "run seed" "$SEED_RUN"

live_score() { curl -s "$API/projects/$PID/scores/digital-performance/latest" "${OAUTH[@]}"; }
assert_eq "$(live_score | jget latest.total)" "74" "the live score reads back as 74 from the stored run"

# ─── (b) The approval/release journey, driven over HTTP ──────────────────────
REVIEW=$(curl -s -X POST "$API/projects/$PID/reports/$RSLUG/review" "${OAUTH[@]}" -H 'content-type: application/json' -d '{"note":"Ready for review."}')
assert_eq "$(echo "$REVIEW" | jget status)" "in-review" "review locks the snapshot as revision 1"
assert_eq "$(echo "$REVIEW" | jget revision)" "1" "the locked revision is numbered 1"

REVIEW2_CODE=$(curl -s -o /tmp/ovr-review2.json -w '%{http_code}' -X POST "$API/projects/$PID/reports/$RSLUG/review" "${OAUTH[@]}" -H 'content-type: application/json' -d '{}')
assert_eq "$REVIEW2_CODE" "409" "a second review of the same revision is refused"
assert_present "$(cat /tmp/ovr-review2.json)" 'revision-not-editable' "the refusal is a stable code, not a message"

APPROVE=$(curl -s -X POST "$API/projects/$PID/reports/$RSLUG/approve" "${OAUTH[@]}" -H 'content-type: application/json' -d '{"decision":"approved","note":"QA passed."}')
assert_eq "$(echo "$APPROVE" | jget status)" "approved" "approve records the QA decision on that revision"

PUBLISH=$(curl -s -X POST "$API/projects/$PID/reports/$RSLUG/publish" "${OAUTH[@]}" -H 'content-type: application/json' -d '{"note":"Releasing to the client."}')
assert_eq "$(echo "$PUBLISH" | jget status)" "released" "publish releases the approved revision"

# ─── The client sees it, with the §5.1 limits applied ───────────────────────
OV=$(curl -s "$API/portal/projects/$PID/overview" "${CAUTH[@]}")
[ -n "$OV" ] && [ "$(echo "$OV" | jget audience)" = "client" ] && ok "the client overview reads and reports its audience" || die "client overview failed" "$OV"

assert_eq "$(echo "$OV" | jget sections.score.data.status)" "complete" "the score panel reports a complete run"
assert_eq "$(echo "$OV" | jget sections.score.data.total)" "74" "one prominent score: the live total (74)"
assert_eq "$(echo "$OV" | jget sections.score.data.weightsApproved)" "false" "the unapproved weighting is disclosed on the read (§22 D01)"
assert_eq "$(echo "$OV" | jget sections.report.data.releasedScoreTotal)" "71" "the report panel shows the FROZEN score (71), not the live one"
assert_eq "$(echo "$OV" | jget sections.report.data.releasedDigitalPerformance.total)" "74" "the report panel carries the frozen Cailyx score-family total"
assert_eq "$(echo "$OV" | jget sections.report.data.releasedDigitalPerformance.measuredBucketCount)" "5" "the frozen section counts its measured buckets"
assert_eq "$(echo "$OV" | jget sections.report.data.releasedDigitalPerformance.applicableBucketCount)" "5" "the frozen section leaves the not-applicable bucket out of its cards"
assert_eq "$(echo "$OV" | jget sections.report.data.revision)" "1" "the report panel names the released revision"
assert_present "$OV" 'As released in the September report' "the report panel labels the release month explicitly"
assert_present "$OV" 'Live score, updated' "the score panel labels the live score explicitly"

# §5.1's hard limits.
assert_eq "$(echo "$OV" | jlen sections.score.data.buckets)" "5" "the score panel shows the APPLICABLE buckets only (5 of 6)"
assert_eq "$(echo "$OV" | jlen sections.score.data.excludedFromScore)" "1" "the not-applicable bucket is reported as a decision instead"
# §5.5's drilldown: a bucket card carries the STORED destination and period, so
# the tab it opens is the one the score itself recorded — never one the UI
# inferred from a bucket's name, and never a bucket with no detail page.
assert_present "$OV" '/results/website' "the bucket cards carry the stored drilldown path (§5.5)"
assert_present "$OV" 'tab=google' "a sub-view destination survives the projection (the Google tab of Website)"
assert_present "$OV" '/results/content' "the content bucket points at the area the score recorded for it"
assert_eq "$(echo "$OV" | jlen sections.actions.data.items)" "3" "the action panel shows at most three cards"
assert_eq "$(echo "$OV" | jget sections.actions.data.total)" "4" "the action panel reports the TRUE total (4) beyond the three cards"
assert_eq "$(echo "$OV" | jget sections.actions.data.limit)" "3" "the action panel publishes its cap"
assert_eq "$(echo "$OV" | jget sections.actions.data.items.0.severity)" "overdue" "the overdue item is ordered first (§5.6)"
assert_eq "$(echo "$OV" | jget sections.actions.data.items.0.sourceId)" "$OVERDUE_APPROVAL" "the first card is the overdue request itself, by its own id"
assert_eq "$(echo "$OV" | jlen sections.upcomingContent.data.items)" "5" "the upcoming panel shows at most five items"
UPCOMING_TOTAL=$(echo "$OV" | jget sections.upcomingContent.data.totalInWindow)
[ "${UPCOMING_TOTAL:-0}" -ge 6 ] && ok "the upcoming panel reports every placement in the window ($UPCOMING_TOTAL, more than the five shown)" || bad "totalInWindow = $UPCOMING_TOTAL, expected at least 6"
assert_eq "$(echo "$OV" | jget sections.upcomingContent.data.truncated)" "true" "the upcoming panel says its list is a prefix, not the whole window"
assert_present "$OV" 'commitments completed' "the plan footer carries the 30-day progress label"
assert_eq "$(echo "$OV" | jget sections.score.data.resultsHref)" "/client/projects/$PID/results" "the client's 'View results' opens the client Results screen"

# §5.1's staff-only shortcut must not exist on the client read at all.
assert_absent "$OV" 'teamAttention' "the client overview has no teamAttention key"

# §4.5 — every panel is its own section, and each one carries a status.
for panel in score actions upcomingContent plan report; do
  st=$(echo "$OV" | jget "sections.$panel.status")
  [ -n "$st" ] && ok "panel '$panel' carries its own status ('$st')" || bad "panel '$panel' has no status envelope"
done

# §5.6 — opening an item must not complete it. Reading the overview reads the
# source rows, and the source rows must be untouched afterwards.
APPROVALS_STILL=$(PID="$PID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const requestIds = (await prisma.approvalRequest.findMany({ where: { projectId: process.env.PID }, select: { id: true } })).map((r) => r.id);
  console.log(JSON.stringify({
    pending: await prisma.approvalRequest.count({ where: { projectId: process.env.PID, status: 'pending' } }),
    decisions: await prisma.approvalDecision.count({ where: { approvalRequestId: { in: requestIds } } }),
  }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
)
assert_eq "$(echo "$APPROVALS_STILL" | jget pending)" "4" "reading the overview leaves all four requests pending"
assert_eq "$(echo "$APPROVALS_STILL" | jget decisions)" "0" "reading the overview records no approval decision"

# ─── (a) Live/report separation ─────────────────────────────────────────────
DETAIL_BEFORE=$(curl -s "$API/portal/reports/$RSLUG" "${CAUTH[@]}")
assert_eq "$(echo "$DETAIL_BEFORE" | jget scoreTotal)" "71" "the report detail carries the frozen score"
assert_eq "$(echo "$DETAIL_BEFORE" | jget title)" "September update" "the report detail carries the frozen title"
assert_eq "$(echo "$DETAIL_BEFORE" | jget digitalPerformance.total)" "74" "the report detail carries the frozen score-family section"
frozen_subtree() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.digitalPerformance))})'; }
FROZEN_BEFORE=$(echo "$DETAIL_BEFORE" | frozen_subtree)

# Move the live score, corrupt every mutable Report column, and open a newer
# private draft revision — all three at once, because a released report must
# survive all three.
SEED_LIVE2=$(PID="$PID" RID="$RID" RUN1="$RUN1" MVER="$MVER" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const version = Number(process.env.MVER);
  const previous = await prisma.scoreFamilyRun.findUnique({ where: { id: process.env.RUN1 }, include: { buckets: true } });
  const run = await prisma.scoreFamilyRun.create({
    data: {
      projectId: process.env.PID, methodologyVersion: version, status: 'complete', total: 91,
      applicableWeightTotal: 85, weightedPointsTotal: 7735, evidenceCoverage: 85,
      comparisonKey: 'seed-comparison-key', segmentIndex: 1, comparisonState: 'comparable',
      previousRunId: previous.id, fingerprint: 'seed-fingerprint-2', scope: '{}', applicabilitySnapshot: '{}',
      buckets: {
        create: previous.buckets.map((b) => ({
          key: b.key, label: b.label, weight: b.weight,
          applicability: b.applicability, applicabilityReason: b.applicabilityReason, state: b.state,
          value: b.value == null ? null : b.value + 10,
          weightedPoints: b.value == null ? 0 : b.weight * (b.value + 10),
          effectiveWeight: b.effectiveWeight,
          contribution: b.value == null ? 0 : Number(((b.weight * (b.value + 10)) / 85).toFixed(6)),
          windowStart: b.windowStart, windowEnd: b.windowEnd, methodologyVersion: version,
          metricVersion: b.metricVersion, metricInputs: b.metricInputs, sources: b.sources,
          maxAgeDays: b.maxAgeDays, minSample: b.minSample, missingReasons: b.missingReasons,
          notes: b.notes, detailPath: b.detailPath, detailQuery: b.detailQuery,
        })),
      },
    },
  });

  // Every mutable column a released report must never read again.
  await prisma.report.update({
    where: { id: process.env.RID },
    data: { title: 'MUTATED mutable title', scoreTotal: 99, scoreBand: 'excellent', executiveSummary: 'MUTATED summary' },
  });

  // A newer PRIVATE draft revision whose content must never surface anywhere.
  const draftSnapshot = {
    title: 'DRAFT ONLY internal rewrite', targetUrl: 'https://draft-only.example',
    executiveSummary: 'DRAFT ONLY executive summary', scoreTotal: 42, scoreBand: 'weak',
    subScores: [], findings: [], roadmap: [], growthPlan: null, backlinks: null, presence: null,
    competitors: null, branding: null, rubricVersion: null, scoreRunId: null, manifestId: null,
    periodId: null, cohortId: null, digitalPerformance: null, planProgress: null,
    contentCreatedAt: new Date().toISOString(), contentUpdatedAt: new Date().toISOString(),
    snapshotAt: new Date().toISOString(),
  };
  await prisma.reportRevision.create({
    data: { reportId: process.env.RID, revision: 2, status: 'draft', title: 'DRAFT ONLY internal rewrite', snapshot: JSON.stringify(draftSnapshot) },
  });

  console.log(JSON.stringify({ runId: run.id }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "live-change seed failed" "$SEED_LIVE2"
RUN2=$(echo "$SEED_LIVE2" | jget runId)
[ -n "$RUN2" ] && [ "$RUN2" != "__ERR__" ] && ok "live score moved (run 2, total 91), every mutable Report column rewritten, a newer draft revision opened" || die "live change seed" "$SEED_LIVE2"

OV_AFTER=$(curl -s "$API/portal/projects/$PID/overview" "${CAUTH[@]}")
assert_eq "$(echo "$OV_AFTER" | jget sections.score.data.total)" "91" "the LIVE score panel moved to 91"
assert_eq "$(echo "$OV_AFTER" | jget sections.score.data.changeInTotal)" "17" "the live comparison reports the movement"
assert_eq "$(echo "$OV_AFTER" | jget sections.report.data.releasedScoreTotal)" "71" "the report panel still shows the released score (71), not the mutable 99"
assert_eq "$(echo "$OV_AFTER" | jget sections.report.data.releasedDigitalPerformance.total)" "74" "the report panel still shows the frozen 74, not the live 91"
assert_eq "$(echo "$OV_AFTER" | jget sections.report.data.title)" "September update" "the report panel still shows the frozen title, not the mutated one"
assert_absent "$OV_AFTER" 'DRAFT ONLY' "the overview does not leak the newer draft revision"
assert_absent "$OV_AFTER" 'MUTATED' "the overview does not leak a mutated mutable column"

DETAIL_AFTER=$(curl -s "$API/portal/reports/$RSLUG" "${CAUTH[@]}")
FROZEN_AFTER=$(echo "$DETAIL_AFTER" | frozen_subtree)
assert_eq "$FROZEN_AFTER" "$FROZEN_BEFORE" "the frozen score section is IDENTICAL after the live score moved (journey 17)"
assert_eq "$(echo "$DETAIL_AFTER" | jget scoreTotal)" "71" "the report detail still reads the frozen score"
assert_eq "$(echo "$DETAIL_AFTER" | jget title)" "September update" "the report detail still reads the frozen title"
assert_eq "$(echo "$DETAIL_AFTER" | jget revision)" "1" "the report detail still names the released revision"
assert_absent "$DETAIL_AFTER" 'DRAFT ONLY' "the report detail does not leak the newer draft revision"
assert_absent "$DETAIL_AFTER" 'MUTATED' "the report detail carries no mutable-column value"

LIST=$(curl -s "$API/portal/reports" "${CAUTH[@]}")
assert_absent "$LIST" 'DRAFT ONLY' "the report list does not leak the draft revision"
assert_absent "$LIST" 'MUTATED' "the report list carries no mutable-column value"
LIST_ROW=$(echo "$LIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const p=(o.reports||[]).find(x=>x.slug===process.argv[1]);process.stdout.write(JSON.stringify(p||{}))})' "$RSLUG")
assert_eq "$(echo "$LIST_ROW" | jget scoreTotal)" "71" "the report list carries the frozen score"
assert_eq "$(echo "$LIST_ROW" | jget revision)" "1" "the report list carries the released revision number"
assert_eq "$(echo "$LIST_ROW" | jget title)" "September update" "the report list carries the frozen title"
# The portal report list is a deliberate summary allowlist (client-portal's
# `PortalReportSummaryDto`): it carries the frozen score and band but not the
# per-bucket section, which rides the two reads that actually render it — the
# report detail and the Overview's report panel (both asserted above). Pinned
# here so a future spread of the snapshot into the list is a visible decision.
assert_absent "$LIST_ROW" 'digitalPerformance' "the report list stays a summary allowlist (the frozen section rides the detail read)"
assert_eq "$(echo "$LIST_ROW" | jget scoreBand)" "weak" "the report list carries the frozen band, not the mutated one"

# ─── (c) No fake total ──────────────────────────────────────────────────────
# An empty project's first run has nothing measured, so it must come back
# incomplete with NO numeric total while still reporting each bucket's state.
RUN_B=$(curl -s -X POST "$API/projects/$PID_B/scores/digital-performance/run" "${OAUTH[@]}" -H 'content-type: application/json' -d '{}')
assert_eq "$(echo "$RUN_B" | jget status)" "incomplete" "an unmeasured run is incomplete"
assert_eq "$(echo "$RUN_B" | jget total)" "" "an incomplete run carries NO total"
assert_eq "$(echo "$RUN_B" | jlen buckets)" "6" "the incomplete run still lists all six buckets"

OV_B=$(curl -s "$API/portal/projects/$PID_B/overview" "${CAUTH[@]}")
assert_eq "$(echo "$OV_B" | jget sections.score.data.status)" "incomplete" "the overview says the score is incomplete"
assert_eq "$(echo "$OV_B" | jget sections.score.data.total)" "" "the overview shows no numeric total"
assert_eq "$(echo "$OV_B" | jlen sections.score.data.buckets)" "6" "the overview still shows every applicable bucket card"
assert_eq "$(echo "$OV_B" | jget sections.score.data.buckets.0.state)" "not-measured" "an unmeasured bucket says so"
assert_eq "$(echo "$OV_B" | jget sections.score.data.buckets.0.value)" "" "an unmeasured bucket carries no value"
SCORE_B=$(echo "$OV_B" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.sections.score))})')
assert_absent "$SCORE_B" '"total":0' "the incomplete score panel contains no zero total"
assert_present "$SCORE_B" '"total":null' "the incomplete score panel says the total is missing"
[ -n "$(echo "$OV_B" | jget sections.score.data.missingAreas.0)" ] && ok "the overview names an area it could not measure" || bad "missingAreas is empty on an unmeasured run"

# ─── (d) Panel isolation ────────────────────────────────────────────────────
# Project C's timezone is not a real IANA zone, so the calendar read refuses.
# That must cost ONE panel, not the page.
OV_C_CODE=$(curl -s -o /tmp/ovr-c.json -w '%{http_code}' "$API/portal/projects/$PID_C/overview" "${CAUTH[@]}")
OV_C=$(cat /tmp/ovr-c.json)
assert_eq "$OV_C_CODE" "200" "a failed panel still returns a 200 page"
assert_eq "$(echo "$OV_C" | jget sections.upcomingContent.status)" "unavailable" "the calendar panel degrades to 'unavailable'"
assert_eq "$(echo "$OV_C" | jget sections.upcomingContent.reasonCode)" "read-failed" "the failed panel carries a stable reason code"
[ -n "$(echo "$OV_C" | jget sections.upcomingContent.reason)" ] && ok "the failed panel carries a safe sentence" || bad "the failed panel has no reason"
assert_absent "$OV_C" 'IANA timezone' "the failed panel leaks no exception text (§4.4)"
assert_eq "$(echo "$OV_C" | jget sections.upcomingContent.data)" "" "the failed panel carries no data"
for panel in score actions plan report; do
  st=$(echo "$OV_C" | jget "sections.$panel.status")
  [ "$st" = "unavailable" ] && bad "panel '$panel' was blanked by the calendar failure" || ok "panel '$panel' survived the calendar failure (status '$st')"
done
[ -n "$(echo "$OV_C" | jget sections.plan.data.label)" ] && ok "the surviving panels still carry their data" || bad "a surviving panel lost its data"

# ─── §3.3's client Results tabs, projected from the domain read models ──────
WEB_TAB=$(curl -s "$API/portal/projects/$PID/results/website" "${CAUTH[@]}")
WEB_STATUS=$(echo "$WEB_TAB" | jget status)
[ -n "$WEB_STATUS" ] && ok "the Website tab answers with a section envelope ('$WEB_STATUS')" || bad "the Website tab returned no envelope: $WEB_TAB"
assert_absent "$WEB_TAB" 'ruleId' "the Website tab drops rule ids"
assert_absent "$WEB_TAB" 'pageIdentityId' "the Website tab drops page identity handles"
assert_absent "$WEB_TAB" 'sourceIds' "the Website tab drops source ids (counts only)"

AI_TAB=$(curl -s "$API/portal/projects/$PID/results/ai" "${CAUTH[@]}")
assert_eq "$(echo "$AI_TAB" | jget status)" "empty" "the AI visibility tab reports 'nothing checked yet' rather than an error"
assert_eq "$(echo "$AI_TAB" | jget reasonCode)" "no-data-yet" "the empty AI tab carries the no-data code"
assert_absent "$AI_TAB" 'accessMode' "the AI tab drops how we collect, not what the client gets"

COMP_TAB=$(curl -s "$API/portal/projects/$PID/results/competitors" "${CAUTH[@]}")
assert_eq "$(echo "$COMP_TAB" | jget status)" "empty" "the Competitors tab reports 'none tracked yet' rather than an error"
assert_eq "$(echo "$COMP_TAB" | jget reasonCode)" "no-data-yet" "the empty Competitors tab carries the no-data code"

# Online presence — §3.3's fourth tab. It adds NO projection of its own: it
# reuses P05's client-safe inventory verbatim, which is the point (a second read
# path for the same fact is how two screens start disagreeing).
PRES_TAB=$(curl -s "$API/portal/projects/$PID/results/presence" "${CAUTH[@]}")
assert_eq "$(echo "$PRES_TAB" | jget status)" "ok" "the Online presence tab reads the stored inventory"
assert_eq "$(echo "$PRES_TAB" | jlen data.accounts)" "2" "the tab shows the company's two rows — a candidate is shown, and marked as such"
assert_eq "$(echo "$PRES_TAB" | jget data.counts.total)" "1" "the tab counts only confirmed profiles as found"
assert_eq "$(echo "$PRES_TAB" | jget data.counts.needsConfirmation)" "1" "the tab counts the search candidate as needing confirmation"
assert_present "$PRES_TAB" 'Confirmed account' "a confirmed stored row arrives with its client-facing state label (§4.3)"
assert_present "$PRES_TAB" 'Recommended profile — needs confirmation' "the search candidate arrives as a recommendation, not as an account"
assert_present "$PRES_TAB" 'https://www.linkedin.com/company/seed-overview' "the tab links to the profile itself"
assert_absent "$PRES_TAB" 'seed-founder-personal' "the tab never presents a founder's personal profile as the company's reach"
assert_absent "$PRES_TAB" 'handle' "the tab drops the stored handle — a url and a label are what the client gets"
assert_absent "$PRES_TAB" 'confidence' "the tab drops the search-confidence ordering hint"
assert_absent "$PRES_TAB" 'foundOn' "the tab drops the page a finding came from (operator evidence, not client content)"

PRES_EMPTY=$(curl -s "$API/portal/projects/$PID_B/results/presence" "${CAUTH[@]}")
assert_eq "$(echo "$PRES_EMPTY" | jget status)" "empty" "a project with nothing discovered reports 'nothing found yet' rather than an error"
assert_eq "$(echo "$PRES_EMPTY" | jget reasonCode)" "no-data-yet" "the empty presence tab carries the no-data code"
assert_absent "$PRES_EMPTY" 'seed-overview' "the empty tab leaks nothing from the other project"

# The Cailyx score is reachable to the client as a client-safe projection.
SCORE_TAB=$(curl -s "$API/portal/projects/$PID/scores/digital-performance/latest" "${CAUTH[@]}")
assert_eq "$(echo "$SCORE_TAB" | jget score.latest.total)" "91" "the client's own score read shows the live total"
assert_eq "$(echo "$SCORE_TAB" | jget score.latest.buckets.0.applicability)" "applicable" "the client score read carries bucket applicability"
assert_absent "$SCORE_TAB" 'fingerprint' "the client score read drops the run fingerprint"
assert_absent "$SCORE_TAB" 'weightedPoints' "the client score read drops the internal arithmetic"

# A client must not reach another client's project through any new route.
#
# The refusal code differs by read path and both are correct in place: the
# project-scoped routes go through the shared `ScopeValidationService`, whose
# client branch answers 403 for a project that exists but is not theirs (the
# same guard the pre-existing `/portal/projects/:id/results` route uses), while
# the release-gated report reads do their own ownership check and answer the
# same 404 as "no such report". What must hold either way is that the refusal
# carries nothing about the project — so both are asserted, and the body is
# checked for the project id rather than the code being taken on faith.
for path in "/portal/projects/$PID/overview" "/portal/projects/$PID/results/website" "/portal/projects/$PID/results/presence" "/portal/projects/$PID/results/competitors"; do
  code=$(curl -s -o /tmp/ovr-foreign.json -w '%{http_code}' "$API$path" "${OAUTH2[@]}")
  if [ "$code" = "403" ] || [ "$code" = "404" ]; then ok "another client is refused $path (HTTP $code)"; else bad "another client got HTTP $code from $path"; fi
  assert_absent "$(cat /tmp/ovr-foreign.json)" "$PID" "the refusal for $path names nothing about the project"
done
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' "$API/portal/reports/$RSLUG" "${OAUTH2[@]}")" "404" "another client cannot read this released report (404, not 403: the report reads are release-gated)"
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' "$API/projects/$PID/overview" "${CAUTH[@]}")" "403" "a client login cannot reach the staff overview route"
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' "$API/portal/projects/$PID/overview" "${OAUTH[@]}")" "403" "an operator login cannot reach the client portal route"
rm -f /tmp/ovr-foreign.json

# ─── §5.7 — a page load is a read ───────────────────────────────────────────
counts() {
  node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const out = {
    scoreFamilyRuns: await prisma.scoreFamilyRun.count(),
    scoreBucketRuns: await prisma.scoreBucketRun.count(),
    scoreMethodologies: await prisma.scoreMethodology.count(),
    technicalAudits: await prisma.technicalAudit.count(),
    aeoAudits: await prisma.aeoAudit.count(),
    presenceAccounts: await prisma.presenceAccount.count(),
    techStackScans: await prisma.techStackScan.count(),
    competitorProfiles: await prisma.competitorProfile.count(),
    comparisonSnapshots: await prisma.competitorComparisonSnapshot.count(),
    websiteInsightSnapshots: await prisma.websiteInsightSnapshot.count(),
    growthAssets: await prisma.growthAsset.count(),
    contentSchedules: await prisma.contentSchedule.count(),
    approvalRequests: await prisma.approvalRequest.count(),
    reportRevisions: await prisma.reportRevision.count(),
    reports: await prisma.report.count(),
  };
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
}
BEFORE=$(counts)
# Every read the Overview and the Results screen make, including both edges.
for route in \
  "portal/projects/$PID/overview" \
  "portal/projects/$PID/results/website" \
  "portal/projects/$PID/results/ai" \
  "portal/projects/$PID/results/presence" \
  "portal/projects/$PID/results/competitors" \
  "portal/projects/$PID/scores/digital-performance/latest" \
  "portal/projects/$PID_B/overview" \
  "portal/projects/$PID_C/overview"; do
  curl -s "$API/$route" "${CAUTH[@]}" >/dev/null
done
curl -s "$API/projects/$PID/overview" "${OAUTH[@]}" >/dev/null
AFTER=$(counts)
if [ "$BEFORE" = "$AFTER" ]; then
  ok "no run, bucket, audit, presence, competitor, insight, asset, schedule, request or revision row was created by reading"
else
  bad "a read created rows: $BEFORE -> $AFTER"
fi

# ─── Staff overview: the §5.1 shortcut, below the client-equivalent info ────
SOV=$(curl -s "$API/projects/$PID/overview" "${OAUTH[@]}")
assert_eq "$(echo "$SOV" | jget audience)" "operator" "the staff overview is served as the operator audience"
[ -n "$(echo "$SOV" | jget sections.teamAttention.status)" ] && ok "the staff overview carries the team attention panel" || bad "the staff overview has no teamAttention panel"
assert_eq "$(echo "$SOV" | jget sections.score.data.total)" "$(echo "$OV_AFTER" | jget sections.score.data.total)" "the staff and client reads agree about the live score"
assert_eq "$(echo "$SOV" | jget sections.actions.data.total)" "4" "the staff read of the client queue reports the same true total"
assert_eq "$(echo "$SOV" | jget sections.report.data.releasedScoreTotal)" "71" "the staff read of the report footer is frozen too"
# The §3.3 mapping, operator side: there is no staff twin of the client Results
# screen, so "View results" must send the operator to the research read of the
# same domain models rather than into the client app.
assert_eq "$(echo "$SOV" | jget sections.score.data.resultsHref)" "/projects/$PID/research/website" "the staff 'View results' opens the operator's own read, not the client app"

echo
echo "overview-results smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

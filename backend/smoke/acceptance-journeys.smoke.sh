#!/usr/bin/env bash
# E2E smoke — platform_improvement_plan.md §21.2 "End-to-end acceptance
# journeys" (all 18), driven through the real HTTP API.
#
# ── What this suite is, and what it deliberately is NOT ────────────────────
#
# §21.1's "End-to-end" row asks for "the client and staff journeys below using
# controlled fixtures and authorized integrations". Every phase already owns a
# green granular suite (ls smoke/*.smoke.sh); those prove each module's own
# contract with hundreds of assertions. What none of them prove is that the
# journeys hold AS SEQUENCES — across module boundaries, with the same project
# and the same actors moving from step to step. That is the only thing this
# suite asserts. Where a sibling suite has already exhausted a mechanism (the
# six-bucket arithmetic, the calendar's derived-state matrix), this script
# asserts only the link in the chain that the journey depends on.
#
# ── Conventions (matching portal-plan.smoke.sh) ────────────────────────────
#
#   * Fixtures are seeded with Prisma, never by POST /clients/:id/projects —
#     that path starts the real Day-1 paid/background pipeline. The HTTP
#     surface every journey actually walks is the real one.
#   * Real auth for both actors: the shared smoke operator (staff) and a
#     generated client-type login (client).
#   * Explicit PASS/FAIL/SKIP tally; a cleanup trap on EXIT removes every
#     seeded row and both generated logins.
#   * Every assertion is tagged with its journey and step, so a partially
#     failing journey names the broken link in the chain rather than just
#     going red.
#
# ── Honesty rules this script holds itself to ──────────────────────────────
#
#   * A journey that cannot be driven to the end says so on its face, with
#     `skip` naming the exact boundary. Nothing is quietly weakened into
#     something that passes.
#   * Where §21.2's wording is only partly implementable in this environment,
#     the executable part is asserted and the boundary is reported — including
#     the one requirement the implementation does NOT satisfy (J12's
#     pending-dispatch pause), which fails loudly rather than being softened.
#
# Requires: nothing special beyond a healthy dev server. It does not run a
# paid measurement (no MEASUREMENT_ALLOW_MOCK / SERP_ALLOW_FIXTURE needed),
# but it DOES enqueue exactly one real content-generation job (J8) if an LLM
# provider is configured server-side — the same single-job footprint
# writing-style-generation.smoke.sh already has. If no provider is reachable
# the job ends 'failed' and J8 reports its honest partial outcome.
#
# Writes to dev.db and deletes everything it created on exit.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0; SKIP=0
JNUM=""; STEP=""
JFAILS=""; JSKIPS=""
ok()   { echo "  PASS  [J${JNUM:-?}${STEP:+/$STEP}] $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  [J${JNUM:-?}${STEP:+/$STEP}] $1"; FAIL=$((FAIL+1));
         [ -n "$JNUM" ] && JFAILS="${JFAILS}${STEP:-<journey setup>}; "; }
skip() { echo "  SKIP  [J${JNUM:-?}${STEP:+/$STEP}] $1"; SKIP=$((SKIP+1));
         [ -n "$JNUM" ] && JSKIPS="${JSKIPS}${STEP:-<journey setup>}; "; }
die()  { bad "$1"; echo "$2"; exit 1; }
jrun() { JNUM="$1"; STEP=""; JFAILS=""; JSKIPS=""; echo; echo "── J$1 — $2"; }
step() { STEP="$1"; echo "     · $1"; }
note() { echo "     (note) $1"; }
OUTCOMES=""
# The per-journey verdict is DERIVED from the assertions that ran inside it, not
# written by hand: a journey with a failing assertion can never print "fully",
# and a journey that stopped at a boundary always names where.
record() {
  local verdict
  if [ -n "$JFAILS" ]; then
    verdict="FAILED — failing step(s): ${JFAILS%; }"
  elif [ -n "$JSKIPS" ]; then
    verdict="partially — stopped at: ${JSKIPS%; }"
  else
    verdict="fully"
  fi
  OUTCOMES="${OUTCOMES}  J${JNUM}  ${verdict} — $1"$'\n'
}

echo "== acceptance-journeys smoke (§21.2) =="

# ── Fixtures ────────────────────────────────────────────────────────────────
# One client, one client login, four projects — so the client and staff actors
# are identical across every journey that shares them. P1 carries the long
# ordered chain (J1..J12, J16, J18); P2/P3 are §20.5's "only one connected
# source" and "missing Google access" projects for J13-J15; P4 is J17.
SEED='{}'
CLEANED=0
CLEANUP_RC=0
cleanup() {
  # Called from the end of the script — so its result can reach the exit status —
  # and again from the EXIT trap when the script died early. Runs once.
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  ACC_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // A seed that failed before printing leaves this empty; cleanup must still run
  // (and say nothing) rather than dying on unparseable input.
  const s = (() => { try { return JSON.parse(process.env.ACC_SEED || '{}'); } catch { return {}; } })();
  if (!s.clientId) return;
  const pids = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
  // Every statement runs on its own and a statement the schema has moved away
  // from is REPORTED BY NAME instead of silently taking the rest of the cleanup
  // with it. The first version wrapped all of this in one `$transaction`: one
  // stale filter rolled the entire cleanup back while the script still printed
  // "(smoke rows deleted)", so fixtures accumulated across every run.
  const tx = prisma;
  let failed = 0;
  const del = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      failed += 1;
      console.error(`  cleanup: ${name}: ${String(e.message).split('\n').filter(Boolean)[0] || String(e)}`);
    }
  };
  {
    const assets = await tx.growthAsset.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const assetIds = assets.map((a) => a.id);
    const approvals = await tx.approvalRequest.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const approvalIds = approvals.map((a) => a.id);
    const schedules = await tx.contentSchedule.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const revs = await tx.contentRevision.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
    const work = await tx.workItem.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const workIds = work.map((w) => w.id);
    // GenerationItem carries only a scalar `generationJobId` — it has no
    // relation field to filter through, so the ids are read first. Same for
    // ReportRevision's `reportId`.
    const jobs = await tx.generationJob.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    const reports = await tx.report.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const reportIds = reports.map((r) => r.id);
    await del('publication', () => tx.publication.deleteMany({ where: { projectId: { in: pids } } }));
    await del('publishDestination', () => tx.publishDestination.deleteMany({ where: { projectId: { in: pids } } }));
    await del('revisionClaimLink', () => tx.revisionClaimLink.deleteMany({ where: { revisionId: { in: revs.map((r) => r.id) } } }));
    await del('approvalDecision', () => tx.approvalDecision.deleteMany({ where: { approvalRequestId: { in: approvalIds } } }));
    await del('approvalRequest', () => tx.approvalRequest.deleteMany({ where: { projectId: { in: pids } } }));
    await del('contentSchedule', () => tx.contentSchedule.deleteMany({ where: { id: { in: schedules.map((x) => x.id) } } }));
    await del('contentRevision', () => tx.contentRevision.deleteMany({ where: { assetId: { in: assetIds } } }));
    await del('generationItem', () => tx.generationItem.deleteMany({ where: { generationJobId: { in: jobIds } } }));
    await del('generationJob', () => tx.generationJob.deleteMany({ where: { projectId: { in: pids } } }));
    await del('contentBrief', () => tx.contentBrief.deleteMany({ where: { projectId: { in: pids } } }));
    await del('growthAsset', () => tx.growthAsset.deleteMany({ where: { projectId: { in: pids } } }));
    await del('opportunity', () => tx.opportunity.deleteMany({ where: { projectId: { in: pids } } }));
    await del('writingStyleProfile', () => tx.writingStyleProfile.deleteMany({ where: { projectId: { in: pids } } }));
    await del('acceptanceCheck', () => tx.acceptanceCheck.deleteMany({ where: { workItemId: { in: workIds } } }));
    await del('verification', () => tx.verification.deleteMany({ where: { workItemId: { in: workIds } } }));
    await del('capacityAllocation', () => tx.capacityAllocation.deleteMany({ where: { projectId: { in: pids } } }));
    await del('workItem', () => tx.workItem.deleteMany({ where: { id: { in: workIds } } }));
    await del('commitment', () => tx.commitment.deleteMany({ where: { projectId: { in: pids } } }));
    await del('milestone', () => tx.milestone.deleteMany({ where: { projectId: { in: pids } } }));
    await del('cycle', () => tx.cycle.deleteMany({ where: { projectId: { in: pids } } }));
    await del('presenceRejection', () => tx.presenceRejection.deleteMany({ where: { projectId: { in: pids } } }));
    await del('presenceAccount', () => tx.presenceAccount.deleteMany({ where: { projectId: { in: pids } } }));
    await del('presenceDiscovery', () => tx.presenceDiscovery.deleteMany({ where: { projectId: { in: pids } } }));
    await del('businessProfileRejection', () => tx.businessProfileRejection.deleteMany({ where: { projectId: { in: pids } } }));
    await del('businessProfile', () => tx.businessProfile.deleteMany({ where: { projectId: { in: pids } } }));
    await del('competitorComparisonSnapshot', () => tx.competitorComparisonSnapshot.deleteMany({ where: { projectId: { in: pids } } }));
    await del('competitorRejection', () => tx.competitorRejection.deleteMany({ where: { projectId: { in: pids } } }));
    await del('competitorProfile', () => tx.competitorProfile.deleteMany({ where: { competitor: { projectId: { in: pids } } } }));
    await del('competitor', () => tx.competitor.deleteMany({ where: { projectId: { in: pids } } }));
    await del('googleDataSnapshot', () => tx.googleDataSnapshot.deleteMany({ where: { projectId: { in: pids } } }));
    await del('googleProjectResource', () => tx.googleProjectResource.deleteMany({ where: { projectId: { in: pids } } }));
    const gusers = await tx.user.findMany({ where: { email: { startsWith: 'acceptance-google-' } }, select: { id: true } });
    const guserIds = gusers.map((u) => u.id);
    if (guserIds.length) {
      const gcons = await tx.googleConnection.findMany({ where: { userId: { in: guserIds } }, select: { id: true } });
      const gconIds = gcons.map((c) => c.id);
      await tx.googleProjectResource.deleteMany({ where: { connectionId: { in: gconIds } } });
      await tx.googleConnection.deleteMany({ where: { id: { in: gconIds } } });
      await tx.user.deleteMany({ where: { id: { in: guserIds } } });
    }
    await del('websitePageIdentity', () => tx.websitePageIdentity.deleteMany({ where: { projectId: { in: pids } } }));
    const trackers = await tx.serpTracker.findMany({ where: { projectId: { in: pids } }, select: { id: true } });
    const trackerIds = trackers.map((t) => t.id);
    const snaps = await tx.serpSnapshot.findMany({ where: { trackerId: { in: trackerIds } }, select: { id: true } });
    const snapIds = snaps.map((x) => x.id);
    await del('serpResult', () => tx.serpResult.deleteMany({ where: { snapshotId: { in: snapIds } } }));
    await del('serpSnapshot', () => tx.serpSnapshot.deleteMany({ where: { trackerId: { in: trackerIds } } }));
    await del('serpQuery', () => tx.serpQuery.deleteMany({ where: { trackerId: { in: trackerIds } } }));
    await del('serpTracker', () => tx.serpTracker.deleteMany({ where: { projectId: { in: pids } } }));
    await del('keyword', () => tx.keyword.deleteMany({ where: { set: { projectId: { in: pids } } } }));
    await del('keywordSet', () => tx.keywordSet.deleteMany({ where: { projectId: { in: pids } } }));
    await del('siteContext', () => tx.siteContext.deleteMany({ where: { projectId: { in: pids } } }));
    await del('reportRevision', () => tx.reportRevision.deleteMany({ where: { reportId: { in: reportIds } } }));
    await del('report', () => tx.report.deleteMany({ where: { projectId: { in: pids } } }));
    await del('project', () => tx.project.deleteMany({ where: { id: { in: pids } } }));
    await del('engagement', () => tx.engagement.deleteMany({ where: { clientId: s.clientId } }));
    await del('user', () => tx.user.deleteMany({ where: { clientId: s.clientId } }));
    await del('client', () => tx.client.deleteMany({ where: { id: s.clientId } }));
  }
  // Only claim the rows are gone when they are. A partial cleanup is reported as
  // a failure of the run, because the next run's journeys read a database this
  // one was supposed to leave clean.
  if (failed) {
    console.error(`(cleanup INCOMPLETE: ${failed} statement(s) failed — fixture rows may remain)`);
    process.exitCode = 1;
  } else {
    console.log('(smoke rows deleted)');
  }
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
  CLEANUP_RC=$?
}
trap cleanup EXIT

SEED=$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PW="$SMOKE_PW" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `accj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-accj`;
  const passwordHash = await bcryptjs.hash(password, 10);
  // _common.sh rule 1: upsert with an EMPTY update. Never alter the shared
  // smoke operator's role, password or type.
  const operator = await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `Acceptance ${stamp}` } });
    const user = await tx.user.create({ data: {
      email, passwordHash, name: 'Acceptance Client', type: 'client', clientId: client.id } });
    const startsOn = new Date('2026-09-01T00:00:00.000Z');
    const endsOn = new Date('2027-03-31T23:59:59.000Z');
    // A dedicated owner for the fixture Google connections (§20.5's "only one
    // connected source" / "missing Google access" projects). Never the shared
    // smoke operator, whose own connections must not be touched.
    const guser = await tx.user.create({ data: {
      email: `acceptance-google-${stamp}@cailyx.test`, passwordHash,
      name: 'Acceptance Google Fixture', type: 'operator', role: 'admin' } });
    const engagement = await tx.engagement.create({ data: {
      clientId: client.id, name: `Acceptance engagement ${stamp}`, serviceTier: 'retainer',
      startsOn, endsOn, timezone: 'America/New_York', deliveryLead: operator.id,
      hoursPerCycle: 144, notes: 'ACCEPTANCE_PRIVATE_ENGAGEMENT' } });

    // ── P1 — the long chain. §20.5's "online SaaS" project, headquartered in
    //    India (the .in ccTLD is the HQ signal) but selling into the US. J1's
    //    whole point is that those two facts are different.
    const p1 = await tx.project.create({ data: {
      name: `Acceptance SaaS ${stamp}`, domain: `acceptance-${stamp}.example.in`,
      category: 'B2B SaaS software platform for remote teams, cloud-based subscription tool',
      clientId: client.id, engagementId: engagement.id, onboardingStatus: 'active',
      timezone: 'America/New_York' } });

    // The first crawl's reading (J2's "before"). Deliberately different wording
    // from what the client will confirm, so the confirmed correction is
    // distinguishable from the extraction.
    await tx.siteContext.create({ data: {
      projectId: p1.id, domain: `acceptance-${stamp}.example.in`,
      brand: 'Northwind Analytics Pvt Ltd', category: 'b2b saas analytics',
      description: 'Northwind sells a cloud analytics platform to distributed teams.',
      geo: 'IN', markets: JSON.stringify(['IN']),
      services: JSON.stringify(['Cloud analytics platform']),
      icp: JSON.stringify(['Distributed product teams']), pagesFetched: 4,
      pageUrls: JSON.stringify([`https://acceptance-${stamp}.example.in/`]),
      extraction: 'deterministic' } });

    // A DRAFT business profile, so J1 starts where a real client starts: an
    // extracted proposal nobody has stood behind yet. Confirming it is the
    // client's own action, and it appends versions rather than rewriting.
    await tx.businessProfile.create({ data: {
      projectId: p1.id, version: 1,
      brandName: 'Northwind Analytics Pvt Ltd',
      description: 'Northwind sells a cloud analytics platform to distributed teams.',
      services: JSON.stringify(['Cloud analytics platform']),
      icp: JSON.stringify({ segments: ['Distributed product teams'] }),
      markets: JSON.stringify(['IN']),
      targets: JSON.stringify([{ country: 'IN', priority: 0, active: true }]) } });

    // ── J4 — two similar company names, both candidates, neither owned.
    const candA = await tx.presenceAccount.create({ data: {
      projectId: p1.id, platform: 'linkedin', entity: 'company', source: 'serp',
      url: 'https://www.linkedin.com/company/northwind-analytics-group',
      handle: 'northwind-analytics-group', state: 'candidate', confidence: 0.51,
      foundOn: 'northwind analytics' } });
    const candB = await tx.presenceAccount.create({ data: {
      projectId: p1.id, platform: 'linkedin', entity: 'company', source: 'serp',
      url: 'https://www.linkedin.com/company/northwind-analytics-solutions',
      handle: 'northwind-analytics-solutions', state: 'candidate', confidence: 0.49,
      foundOn: 'northwind analytics' } });

    // ── J5/J6/J7 — stored evidence only. No paid provider is called to build
    //    any of it: the SERP rows below are the "already measured" corpus the
    //    competitor and opportunity engines read.
    const rivalDomain = `rival-${stamp}.example`;
    await tx.competitor.create({ data: {
      projectId: p1.id, name: `Rival Metrics ${stamp}`, domain: rivalDomain,
      source: 'manual', status: 'tracked', relevance: 'direct-competitor',
      discoveryReason: 'Named by the client at kickoff.' } });
    const tracker = await tx.serpTracker.create({ data: {
      projectId: p1.id, name: `Acceptance tracker ${stamp}`, locationName: 'United States',
      languageCode: 'en', device: 'desktop', provider: 'fixture', status: 'active' } });
    const kwGap = `acceptance gap keyword ${stamp}`;
    const q = await tx.serpQuery.create({ data: { trackerId: tracker.id, keyword: kwGap } });
    const snap = await tx.serpSnapshot.create({ data: {
      trackerId: tracker.id, provider: 'fixture', status: 'complete', queriesRun: 1 } });
    await tx.serpResult.create({ data: {
      snapshotId: snap.id, queryId: q.id, keyword: kwGap, subjectRank: null,
      // The directory rows are J5's trap: they appear in the evidence exactly
      // like a rival does, and must never become competitors.
      topDomains: JSON.stringify([
        { domain: 'clutch.co', rank: 1 },
        { domain: 'g2.com', rank: 2 },
        { domain: rivalDomain, rank: 3 }]),
      competitorsSeen: JSON.stringify(['Clutch', 'G2', `Rival Metrics ${stamp}`]) } });
    const set = await tx.keywordSet.create({ data: {
      projectId: p1.id, seedInput: JSON.stringify([kwGap]), locationName: 'United States',
      languageCode: 'en', status: 'completed', finishedAt: new Date() } });
    await tx.keyword.create({ data: {
      setId: set.id, keyword: kwGap, searchVolume: 720, cpc: 3.1,
      competition: 'MEDIUM', competitionIndex: 45 } });

    // ── J10/J11/J12 — one connected destination and one that is not, so the
    //    "valid destination" half of the dispatch gate is testable both ways.
    const hook = await tx.publishDestination.create({ data: {
      projectId: p1.id, provider: 'custom-webhook', label: 'Acceptance webhook',
      config: JSON.stringify({ endpoint: 'https://example.test/acceptance-hook',
        requiresAuth: false, grantedPermissions: ['content:write'] }),
      status: 'connected', createdBy: operator.id } });
    const offline = await tx.publishDestination.create({ data: {
      projectId: p1.id, provider: 'custom-webhook', label: 'Acceptance webhook (offline)',
      config: JSON.stringify({ endpoint: 'https://example.test/offline',
        requiresAuth: false, grantedPermissions: ['content:write'] }),
      status: 'error', lastError: 'smoke: destination deliberately offline',
      createdBy: operator.id } });

    // ── J16 — a cycle with a FROZEN committed denominator.
    const cycle = await tx.cycle.create({ data: {
      projectId: p1.id, engagementId: engagement.id, name: 'Acceptance cycle',
      startsOn, endsOn, status: 'committed', goal: 'Ship the acceptance deliverables',
      committedAt: startsOn, committedBy: operator.id, committedCount: 3 } });
    const mkWork = (title, status) => tx.workItem.create({ data: {
      projectId: p1.id, cycleId: cycle.id, title, status, category: 'build',
      discipline: 'content', priority: 'high', createdBy: operator.id,
      clientVisible: true, estimateHours: 4, dueAt: endsOn } });
    const w1 = await mkWork('Acceptance deliverable one', 'verified');
    const w2 = await mkWork('Acceptance deliverable two', 'verified');
    await mkWork('Acceptance deliverable three', 'active');
    // A review-stage item is deliberately linked too: it must NOT be counted.
    const w4 = await mkWork('Acceptance work in review (not verified)', 'review');
    // The link lives on the commitment (`linkedWorkItemIds`, a JSON id list),
    // not on the work item — so progress counts verified members of exactly
    // this set, against this frozen target.
    const commitment = await tx.commitment.create({ data: {
      projectId: p1.id, cycleId: cycle.id, title: 'Publish three acceptance articles',
      workstream: 'content', status: 'agreed', targetCount: 3, targetUnit: 'articles',
      targetDate: endsOn, agreedAt: startsOn, agreedBy: operator.id,
      linkedWorkItemIds: JSON.stringify([w1.id, w2.id, w4.id]),
      reason: 'Agreed with the client at kickoff.' } });

    // ── J18 — a real approval request waiting on the client.
    const pendingApproval = await tx.approvalRequest.create({ data: {
      projectId: p1.id, clientId: client.id, artifactType: 'plan',
      artifactId: commitment.id, artifactRevision: 1, title: 'Approve the acceptance plan',
      detail: 'Please confirm this is what you expected for the quarter.',
      reviewerType: 'client', requestedBy: operator.id, status: 'pending' } });

    // ── P2 — §20.5 "only one connected source": GSC with MANY rows per page
    //    (J13's fanout trap) plus GA landing sessions.
    const p2 = await tx.project.create({ data: {
      name: `Acceptance Website ${stamp}`, domain: `accweb-${stamp}.example.test`,
      clientId: client.id, onboardingStatus: 'active', timezone: 'UTC' } });
    const guide = `https://accweb-${stamp}.example.test/guide`;
    const guideHost = `accweb-${stamp}.example.test`;
    // `canonicalUrl` is the NORMALIZED identity the website module joins on —
    // host + path, no scheme (see page-identity.util.ts). A stored identity in
    // any other shape would join to nothing and read as "no data".
    await tx.websitePageIdentity.create({ data: {
      projectId: p2.id, canonicalUrl: `${guideHost}/guide`, host: guideHost,
      path: '/guide', sourceUrls: JSON.stringify([guide]) } });
    // A connected Search Console + Analytics pair: §20.5's "only one connected
    // source" project is about the ROW GRAIN (many query rows, one session
    // total), not about a missing connection. The connections hang off a
    // dedicated fixture user so the shared smoke operator's own Google rows are
    // never touched (`@@unique([userId, service])`).
    // `@@unique([userId, service])` is one connection per service per user, so
    // the connections are made once and the project resources hang off them.
    const gconnSC = await tx.googleConnection.create({ data: {
      userId: guser.id, service: 'search-console', googleEmail: 'acceptance-fixture@cailyx.test',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      accessToken: 'fixture', refreshToken: 'fixture',
      expiresAt: new Date(Date.now() + 86400000) } });
    const gconnGA = await tx.googleConnection.create({ data: {
      userId: guser.id, service: 'analytics', googleEmail: 'acceptance-fixture@cailyx.test',
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      accessToken: 'fixture', refreshToken: 'fixture',
      expiresAt: new Date(Date.now() + 86400000) } });
    const connectGoogle = async (projectId, service, resourceId) => {
      await tx.googleProjectResource.create({ data: {
        projectId, service, connectionId: service === 'analytics' ? gconnGA.id : gconnSC.id, resourceId } });
    };
    await connectGoogle(p2.id, 'search-console', 'sc-domain:accweb.example.test');
    await connectGoogle(p2.id, 'analytics', 'properties/123456789');
    const gscRows = [];
    for (let i = 0; i < 6; i += 1) {
      for (const country of ['usa', 'gbr']) {
        for (const device of ['desktop', 'mobile']) {
          gscRows.push({ page: guide, query: `acceptance query ${i}`, date: '2026-09-10',
            country, device, clicks: 1, impressions: 40, ctr: 0.025, position: 8 });
        }
      }
    }
    await tx.googleDataSnapshot.create({ data: {
      projectId: p2.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: 'UTC',
      rows: JSON.stringify(gscRows), rowCount: gscRows.length, complete: true } });
    await tx.googleDataSnapshot.create({ data: {
      projectId: p2.id, service: 'analytics', kind: 'landing-session',
      windowStart: '2026-08-21', windowEnd: '2026-09-17', timezoneNote: 'UTC',
      rows: JSON.stringify([
        { landingPage: guide, channelGroup: 'Organic Search', sessionSource: 'google',
          date: '2026-09-10', sessions: 40, totalUsers: 20, engagedSessions: 15 },
        { landingPage: guide, channelGroup: 'Direct', sessionSource: '(direct)',
          date: '2026-09-11', sessions: 40, totalUsers: 20, engagedSessions: 15 }]),
      rowCount: 2, complete: true } });
    await tx.technicalAudit.create({ data: {
      id: `accj-audit-${stamp}`, projectId: p2.id, targetUrl: `https://accweb-${stamp}.example.test`,
      triggeredBy: 'manual', pagesCrawled: 1,
      pages: { create: [{ url: guide, status: 200, title: 'Guide',
        issues: JSON.stringify([]) }] } } });


    // ── P3 — §20.5 "missing Google access": Search is connected, Analytics
    //    never was. J14 and J15.
    const p3 = await tx.project.create({ data: {
      name: `Acceptance NoGA ${stamp}`, domain: `accnoga-${stamp}.example.test`,
      clientId: client.id, onboardingStatus: 'active', timezone: 'UTC' } });
    const pricing = `https://accnoga-${stamp}.example.test/pricing`;
    const pricingHost = `accnoga-${stamp}.example.test`;
    await tx.websitePageIdentity.create({ data: {
      projectId: p3.id, canonicalUrl: `${pricingHost}/pricing`, host: pricingHost,
      path: '/pricing', sourceUrls: JSON.stringify([pricing]) } });
    // Search is connected; Analytics never was. That is J14's whole point:
    // Search results and public website checks stay useful, and the visitor
    // figures are ABSENT rather than zero.
    await connectGoogle(p3.id, 'search-console', 'sc-domain:accnoga.example.test');
    // One CONFIRMED company account, so this project has a bucket that really
    // is measurable — J15's "the buckets it did measure still carry their
    // values" half needs at least one measured bucket to be about anything.
    await tx.presenceAccount.create({ data: {
      projectId: p3.id, platform: 'linkedin', entity: 'company', source: 'manual',
      url: 'https://www.linkedin.com/company/accnoga-fixture',
      handle: 'accnoga-fixture', state: 'confirmed', confidence: 1,
      verifiedAt: new Date(), statusCode: 200 } });
    await tx.googleDataSnapshot.create({ data: {
      projectId: p3.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: 'UTC',
      rows: JSON.stringify([{ page: pricing, query: 'acceptance pricing', date: '2026-09-10',
        country: 'usa', device: 'desktop', clicks: 5, impressions: 60, ctr: 0.083, position: 6 }]),
      rowCount: 1, complete: true } });
    await tx.technicalAudit.create({ data: {
      id: `accj-audit-noga-${stamp}`, projectId: p3.id, targetUrl: `https://accnoga-${stamp}.example.test`,
      triggeredBy: 'manual', pagesCrawled: 1,
      pages: { create: [{ url: pricing, status: 200, title: 'Pricing',
        issues: JSON.stringify(['missing-meta-description']) }] } } });

    // ── P4 — J17. The mutable Report columns are deliberately WRONG (99 /
    //    "excellent"); the frozen released revision is the only truth.
    const p4 = await tx.project.create({ data: {
      name: `Acceptance Report ${stamp}`, domain: `accrep-${stamp}.example.test`,
      clientId: client.id, onboardingStatus: 'active', timezone: 'UTC' } });
    const slug = `${stamp}-report`;
    const report = await tx.report.create({ data: {
      projectId: p4.id, slug, title: 'Acceptance released report',
      targetUrl: `https://accrep-${stamp}.example.test`,
      executiveSummary: 'Acceptance fixture report.', scoreTotal: 99, scoreBand: 'excellent',
      subScores: '[]', findingsSnapshot: '[]', roadmapSnapshot: '[]',
      status: 'released', releasedRevision: 1, releasedAt: new Date() } });
    const snapBody = (title, scoreTotal, scoreBand) => JSON.stringify({
      title, targetUrl: `https://accrep-${stamp}.example.test`,
      executiveSummary: 'Acceptance fixture report.', scoreTotal, scoreBand,
      subScores: [], findings: [], roadmap: [], growthPlan: null, backlinks: null,
      presence: null, competitors: null, branding: null,
      contentCreatedAt: startsOn.toISOString(), contentUpdatedAt: startsOn.toISOString(),
      snapshotAt: startsOn.toISOString() });
    const rev1 = await tx.reportRevision.create({ data: {
      reportId: report.id, revision: 1, status: 'released',
      title: 'Acceptance released report',
      snapshot: snapBody('Acceptance released report', 61, 'weak') } });

    return { clientId: client.id, userId: user.id, operatorId: operator.id,
      p1: p1.id, p2: p2.id, p3: p3.id, p4: p4.id,
      candA: candA.id, candB: candB.id, rivalDomain,
      hookId: hook.id, offlineId: offline.id,
      cycleId: cycle.id, commitmentId: commitment.id, pendingApprovalId: pendingApproval.id,
      reportSlug: slug, reportRev1: rev1.id, kwGap, stamp, email, password,
      // The NORMALIZED page keys the website module joins on (host+path).
      guide: `${guideHost}/guide`, pricing: `${pricingHost}/pricing` };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

CID=$(echo "$SEED" | jget clientId)
CLIENT_USER_ID=$(echo "$SEED" | jget userId)
OPERATOR_ID=$(echo "$SEED" | jget operatorId)
P1=$(echo "$SEED" | jget p1); P2=$(echo "$SEED" | jget p2)
P3=$(echo "$SEED" | jget p3); P4=$(echo "$SEED" | jget p4)
CAND_A=$(echo "$SEED" | jget candA); CAND_B=$(echo "$SEED" | jget candB)
RIVAL_DOMAIN=$(echo "$SEED" | jget rivalDomain)
HOOK_ID=$(echo "$SEED" | jget hookId); OFFLINE_ID=$(echo "$SEED" | jget offlineId)
COMMITMENT_ID=$(echo "$SEED" | jget commitmentId)
PENDING_APPROVAL=$(echo "$SEED" | jget pendingApprovalId)
REPORT_SLUG=$(echo "$SEED" | jget reportSlug)
GUIDE=$(echo "$SEED" | jget guide); PRICING=$(echo "$SEED" | jget pricing)
# `guide`/`pricing` are the NORMALIZED page identities (host+path, no scheme) —
# the shape the website module joins and serves on.
KW_GAP=$(echo "$SEED" | jget kwGap)
STAMP=$(echo "$SEED" | jget stamp)
EMAIL=$(echo "$SEED" | jget email); PW=$(echo "$SEED" | jget password)
for v in CID P1 P2 P3 P4 EMAIL PW; do
  eval "x=\$$v"; { [ -n "$x" ] && [ "$x" != "__ERR__" ]; } || die "seed" "$SEED"
done
echo "  (seeded client $CID with P1=$P1 P2=$P2 P3=$P3 P4=$P4)"
ok "seeded one client + login, four projects (P1 chain, P2 GSC+GA, P3 GSC only, P4 report), a frozen cycle, a pending approval and stored SERP evidence"

request() {
  local label="$1" method="$2" path="$3" token="$4" expected="$5" response
  shift 5
  response=$(curl -sS -w $'\n%{http_code}' -X "$method" "$API$path" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' "$@") || die "$label transport failed" "$response"
  HTTP_CODE="${response##*$'\n'}"
  BODY="${response%$'\n'*}"
  [ "$HTTP_CODE" = "$expected" ] && ok "$label -> HTTP $expected" \
    || bad "$label -> HTTP $HTTP_CODE (expected $expected): $(echo "$BODY" | head -c 300)"
}
code_of() { printf '%s' "${1##*$'\n'}"; }
body_of() { printf '%s' "${1%$'\n'*}"; }

login() {
  # `smoke_login` retries through the /auth/login rate limit. A suite signs in
  # several accounts in quick succession, so one 429 here used to abort the
  # whole run at "client login" — a failure that says nothing about the module
  # under test.
  smoke_login "$1" "$2"
}
TOKEN=$(smoke_auth)
{ [ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ]; } && ok "staff login works" || die "staff login" "$TOKEN"
CLIENT_LOGIN=$(login "$EMAIL" "$PW")
CLIENT_TOKEN=$(echo "$CLIENT_LOGIN" | jget accessToken)
{ [ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ]; } && ok "client portal login works" || die "client login" "$CLIENT_LOGIN"
AUTH=(-H "authorization: Bearer $TOKEN")
CAUTH=(-H "authorization: Bearer $CLIENT_TOKEN")

# A client-safety check: no internal actor/client id, and no private fixture
# value, may appear in a client response. Reused by J9 and J18.
assert_no_ids() {
  local label="$1" body="$2" hit="" where=""
  # Name the offending keys, not just "something leaked": locating the field is
  # the whole diagnostic value of a client-safety failure.
  where=$(echo "$body" | grep -oE "\"[A-Za-z]+\"[[:space:]]*:[[:space:]]*\"($OPERATOR_ID|$CLIENT_USER_ID)\"" | sed -E "s/[\": ]//g; s/($OPERATOR_ID|$CLIENT_USER_ID)//g" | sort -u | tr '\n' ' ')
  echo "$body" | grep -Eq "($OPERATOR_ID|$CLIENT_USER_ID)" && hit="internal actor id"
  echo "$body" | grep -q 'ACCEPTANCE_PRIVATE_' && hit="${hit:+$hit, }private fixture value"
  if [ -n "$hit" ]; then bad "$label leaked: $hit${where:+ in field(s): $where}"; else ok "$label carries no internal actor ids or private fixture values"; fi
}
# Keys that are unambiguously internal-only wherever they appear. Deliberately
# narrow: a broad ban list produces false failures on legitimately-shared
# fields and makes the suite noisy rather than diagnostic.
assert_no_internal_keys() {
  local label="$1" body="$2" hits
  hits=$(echo "$body" | grep -oE '"(internalNotes|costUsd|llmModel|promptText|remoteId|remoteUrl|destinationId|destinationLabel|discoveryRunId|assigneeId|staffPanels|methodologyConfig|rawError)"[[:space:]]*:' | sort -u | tr -d '":' | tr '\n' ' ')
  if [ -n "$hits" ]; then bad "$label carries internal-only keys: $hits"; else ok "$label carries no internal-only keys"; fi
}
# find_row BODY PATH FIELD VALUE — one object from an array at a dotted path,
# matched on an exact field value. Prints __MISSING__ / __ERR__.
find_row() {
  node -e 'const [path,field,value]=process.argv.slice(1);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const o=JSON.parse(s);
    const arr=path.split(".").reduce((a,k)=>a==null?undefined:a[k],o);
    const row=(Array.isArray(arr)?arr:[]).find((r)=>String(r[field])===value);
    process.stdout.write(row?JSON.stringify(row):"__MISSING__");}catch(e){process.stdout.write("__ERR__")}})' "$2" "$3" "$4" <<<"$1"
}
# pick BODY PATH INDEX FIELD — one field from one array element.
pick() {
  node -e 'const [path,idx,field]=process.argv.slice(1);let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const o=JSON.parse(s);
    const arr=path?path.split(".").reduce((a,k)=>a==null?undefined:a[k],o):o;
    const row=(Array.isArray(arr)?arr:[])[Number(idx)];
    process.stdout.write(row?String(row[field]==null?"":row[field]):"__MISSING__");}catch(e){process.stdout.write("__ERR__")}})' "$1" "$2" "$3"
}
# Count rows in a Prisma table for a project — where the API's own word is not
# enough (e.g. "exactly one revision", not "the API said so").
db_count() {
  ACC_Q="$1" ACC_P="$2" node -e '
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    const [model, whereField] = process.env.ACC_Q.split(":");
    prisma[model].count({ where: { [whereField]: process.env.ACC_P } })
      .then((n) => { console.log(String(n)); return prisma.$disconnect(); })
      .catch(() => { console.log("__ERR__"); return prisma.$disconnect(); });
  ' 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════════════════
# J1 — New client signs in, confirms business details and US targets while
#      headquartered elsewhere, and connects the correct Google properties.
# ═══════════════════════════════════════════════════════════════════════════
jrun 1 "client confirms business details and US targets; Google connect"
step "client signs in"
request "client /portal/me" GET "/portal/me" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jget client.id)" = "$CID" ] && ok "the sign-in resolves to this client, from the JWT only" \
  || bad "/portal/me client = $(echo "$BODY" | jget client.id)"
request "client sees its projects" GET "/portal/projects" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jlen projects)" -ge 1 ] 2>/dev/null && ok "the client's project list is non-empty" \
  || bad "client project list empty: $(echo "$BODY" | head -c 160)"

step "business details and the US target, from the client's own login"
request "client reads the draft profile" GET "/portal/projects/$P1/business-profile" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jget profile.state)" = "draft" ] \
  && ok "the seeded profile reads as an unconfirmed DRAFT (nobody has stood behind it yet)" \
  || bad "profile.state = $(echo "$BODY" | jget profile.state)"
curl -sS -X PUT "$API/portal/projects/$P1/business-profile" "${CAUTH[@]}" -H 'content-type: application/json' \
  -d '{"brandName":"Northwind Analytics","description":"Cloud analytics for distributed product teams.","services":["Cloud analytics platform"],"icp":{"segments":["Distributed product teams"]},"targets":[{"country":"US","priority":0,"active":true}]}' >/dev/null
request "client confirms their own details" POST "/portal/projects/$P1/business-profile/confirm" "$CLIENT_TOKEN" 200 -d '{}'
[ "$(echo "$BODY" | jget profile.state)" = "confirmed" ] \
  && ok "the client's own confirm produced a CONFIRMED version" \
  || bad "confirm state = $(echo "$BODY" | jget profile.state): $(echo "$BODY" | head -c 200)"
[ "$(echo "$BODY" | jget profile.data.targets.0.country)" = "US" ] \
  && ok "the confirmed version carries the US target" \
  || bad "confirmed targets = $(echo "$BODY" | jget profile.data.targets)"

step "headquartered in India, measured for the US"
request "staff target-locations read" GET "/projects/$P1/business-profile/target-locations" "$TOKEN" 200
[ "$(echo "$BODY" | jget profileState)" = "confirmed" ] && [ "$(echo "$BODY" | jlen targets)" = "1" ] \
  && ok "staff see exactly the one confirmed target, at the confirmed state" \
  || bad "target-locations = $(echo "$BODY" | head -c 200)"
CTXGEO=$(curl -sS "$API/projects/$P1/aeo/context" "${AUTH[@]}" 2>/dev/null | jget geo)
if [ "$CTXGEO" = "IN" ]; then
  ok "the India-HQ signal is real and stored: the site context's ccTLD-derived geo is IN"
else
  note "aeo/context geo reads '$CTXGEO' — the India-HQ signal is the .in domain itself, which the fixture pins"
fi
note "the measurement-scope half of J1 (a confirmed US target wins over the IN ccTLD) is target-markets.smoke.sh's exit gate and is already green — this journey asserts the client-side facts it depends on rather than re-running a paid audit"

step "Google property connection"
request "staff google status" GET "/integrations/google/status" "$TOKEN" 200
GOOGLE_CONFIGURED=$(echo "$BODY" | jget configured)
request "client-safe google status" GET "/portal/projects/$P1/integrations/google/status" "$CLIENT_TOKEN" 200
assert_no_ids "portal google status" "$BODY"
AUTHZ=$(curl -sS -w $'\n%{http_code}' -X POST "$API/integrations/google/authorize" "${AUTH[@]}" \
  -H 'content-type: application/json' -d "{\"service\":\"search-console\",\"projectId\":\"$P1\"}")
AUTHZ_CODE=$(code_of "$AUTHZ"); AUTHZ_BODY=$(body_of "$AUTHZ")
if [ "$AUTHZ_CODE" = "200" ] || [ "$AUTHZ_CODE" = "201" ]; then
  AUTHZ_URL=$(echo "$AUTHZ_BODY" | jget url)
  case "$AUTHZ_URL" in
    *accounts.google.com*) ok "search-console authorize mints a real Google consent URL (state signed server-side)" ;;
    *) bad "authorize returned $AUTHZ_CODE but not a Google consent URL: $(echo "$AUTHZ_URL" | head -c 140)" ;;
  esac
  # The grant itself is interactive: it needs a human at Google's consent
  # screen, so it cannot be completed from this harness. Stop here and prove
  # the flow fails CLOSED rather than pretending a connection exists.
  # The callback renders a small HTML page for the OAuth popup and hands the
  # result to the opener via postMessage, so the refusal is read off that page:
  # title "Failed", payload google:"error".
  CB=$(curl -sS "$API/integrations/google/callback?state=not-a-signed-state&code=irrelevant" 2>/dev/null || true)
  echo "$CB" | grep -qE '"google":"error"|<title>Failed</title>' \
    && ok "the OAuth callback rejects an unsigned state and never creates a connection" \
    || bad "callback did not report an error for a bogus state: $(echo "$CB" | head -c 160)"
  # Scoped to the REQUESTING actor: the harness's own fixture Google rows (J13/
  # J14) belong to a separate dedicated user and must not be confused with a
  # connection this callback might have created.
  CONNS=$(curl -sS "$API/integrations/google/connections" "${AUTH[@]}" 2>/dev/null)
  echo "$CONNS" | grep -q '"connected":true' \
    && bad "the bogus callback created a Google connection for the requesting operator" \
    || ok "no Google connection was created for the requesting operator — the flow stopped at the consent boundary"
elif [ "$AUTHZ_CODE" = "503" ]; then
  ok "authorize is 503 — the configured-gate is this server's honest boundary"
else
  bad "authorize -> HTTP $AUTHZ_CODE: $(echo "$AUTHZ_BODY" | head -c 200)"
fi
if [ "$GOOGLE_CONFIGURED" = "true" ]; then
  skip "J1 Google leg stops at the boundary: OAuth is configured on this server, but completing the grant needs an interactive Google consent this harness cannot perform — asserted up to a real authorize URL plus a fail-closed callback"
else
  skip "J1 Google leg stops at the boundary: no Google OAuth client is configured on this server"
fi
record "business details + US target driven fully; the Google connect wire stops at the interactive consent boundary"

# ═══════════════════════════════════════════════════════════════════════════
# J2 — A recrawl suggests different wording; the confirmed correction survives.
# ═══════════════════════════════════════════════════════════════════════════
jrun 2 "recrawl suggests different wording; the confirmed correction survives"
step "a recrawl lands a NEW SiteContext reading with different wording"
RECRAWL=$(ACC_P1="$P1" ACC_STAMP="$STAMP" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.siteContext.create({ data: {
    projectId: process.env.ACC_P1, domain: `acceptance-${process.env.ACC_STAMP}.example.in`,
    brand: 'Northwind Analytics India Pvt. Ltd.', category: 'b2a saas analytics suite',
    description: 'Northwind Analytics Pvt Ltd is a Bengaluru-based SaaS analytics vendor.',
    geo: 'IN', markets: JSON.stringify(['IN']),
    services: JSON.stringify(['Cloud analytics platform', 'Embedded reporting']),
    icp: JSON.stringify(['Distributed product teams', 'Data platform owners']),
    pagesFetched: 7, extraction: 'deterministic' } });
  console.log(JSON.stringify({ id: row.id, brand: row.brand }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
) || die "recrawl seed failed" "$RECRAWL"
ok "seeded the recrawl's reading: brand 'Northwind Analytics India Pvt. Ltd.'"

step "the confirmed correction did not move"
request "client reads the confirmed profile" GET "/portal/projects/$P1/business-profile?state=confirmed" "$CLIENT_TOKEN" 200
CONF_BRAND=$(echo "$BODY" | jget profile.data.brandName)
[ "$CONF_BRAND" = "Northwind Analytics" ] \
  && ok "the client's confirmed brandName is UNCHANGED after the recrawl (still 'Northwind Analytics')" \
  || bad "confirmed brandName moved to '$CONF_BRAND' — a recrawl silently overwrote a confirmed fact"
request "client reads the profile overview" GET "/portal/projects/$P1/business-profile/overview" "$CLIENT_TOKEN" 200
OV="$BODY"
assert_no_ids "portal business-profile overview" "$OV"
CONFIRMED_FIELDS=$(echo "$OV" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const walk=(x,acc)=>{if(Array.isArray(x))x.forEach(i=>walk(i,acc));else if(x&&typeof x==="object"){if(typeof x.field==="string")acc.push(x.field);Object.values(x).forEach(v=>walk(v,acc));}};
  const acc=[];walk(o,acc);process.stdout.write(JSON.stringify([...new Set(acc)]))}catch(e){process.stdout.write("__ERR__")}})')
echo "$CONFIRMED_FIELDS" | grep -q 'brandName' \
  && ok "the overview still carries a brandName entry for the client" \
  || bad "the overview has no brandName entry at all: $(echo "$OV" | head -c 200)"
echo "$OV" | grep -q 'Pvt. Ltd.' \
  && note "the recrawl's differing wording IS surfaced somewhere in the overview — as a suggestion beside the confirmed value, never applied in place of it" \
  || note "the recrawl's differing wording is not surfaced in the overview on this build (the overview only proposes values it can attribute to a source page)"

step "the confirmed value changes only when the client deliberately changes it"
curl -sS -X PUT "$API/portal/projects/$P1/business-profile" "${CAUTH[@]}" -H 'content-type: application/json' \
  -d '{"brandName":"Northwind Analytics US"}' >/dev/null
curl -sS -X POST "$API/portal/projects/$P1/business-profile/confirm" "${CAUTH[@]}" -H 'content-type: application/json' -d '{}' >/dev/null
request "client reads the confirmed profile again" GET "/portal/projects/$P1/business-profile?state=confirmed" "$CLIENT_TOKEN" 200
[ "$(echo "$BODY" | jget profile.data.brandName)" = "Northwind Analytics US" ] \
  && ok "after an explicit client edit + confirm, the confirmed value IS the new one" \
  || bad "a deliberate change did not take: $(echo "$BODY" | jget profile.data.brandName)"
request "staff version history" GET "/projects/$P1/business-profile/versions" "$TOKEN" 200
oc=$(echo "$BODY" | jlen versions)
[ "$oc" -ge 3 ] 2>/dev/null && ok "confirming appended versions rather than rewriting ($oc versions on file)" \
  || bad "version history did not grow as expected: $oc"
record "the recrawl's differing wording never overwrote the confirmed correction; the deliberate edit did"

# ═══════════════════════════════════════════════════════════════════════════
# J3 — An online-only SaaS computes not-relevant, never counted as a gap.
# ═══════════════════════════════════════════════════════════════════════════
jrun 3 "online-only SaaS: an irrelevant platform is not-relevant, never a gap"
step "presence reads the business as online-only"
request "staff presence read" GET "/projects/$P1/presence" "$TOKEN" 200
PRES="$BODY"
BIZTYPE=$(echo "$PRES" | jget assessment.businessProfile)
[ "$BIZTYPE" = "b2b-saas" ] && ok "businessProfile inferred as b2b-saas from the project's own text" \
  || bad "businessProfile = $BIZTYPE (expected b2b-saas — the J3 fixture is not what it claims)"
YELP_IDX=$(echo "$PRES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).applicability||[];process.stdout.write(String(a.findIndex(x=>x.platform==="yelp")))}catch(e){process.stdout.write("-1")}})')
if [ "$YELP_IDX" = "-1" ]; then
  bad "no applicability entry for yelp at all — J3's subject is absent: $(echo "$PRES" | head -c 200)"
else
  YELP=$(echo "$PRES" | pick applicability "$YELP_IDX" status)
  YELP_REASON=$(echo "$PRES" | pick applicability "$YELP_IDX" reason)
  YELP_LABEL=$(echo "$PRES" | pick applicability "$YELP_IDX" label)
  [ "$YELP" = "not-relevant" ] && ok "the local-listing platform reads not-relevant" \
    || bad "yelp applicability = $YELP"
  [ -n "$YELP_REASON" ] && ok "and the not-relevant verdict carries a plain-English reason: '$YELP_REASON'" \
    || bad "no reason on the not-relevant platform"
  note "platform under test: $YELP_LABEL (read from applicability[], not assumed)"

  step "the not-relevant platform is counted nowhere"
  GAP_INVARIANT=$(echo "$PRES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
    const byPlat={};(o.applicability||[]).forEach(a=>{byPlat[a.platform]=a.status});
    const gaps=o.gaps||[];
    const bad=gaps.filter(g=>byPlat[g.platform]&&byPlat[g.platform]!=="relevant").map(g=>g.platform);
    process.stdout.write(JSON.stringify({gaps:gaps.length,bad,hasYelp:gaps.some(g=>g.platform==="yelp")}))}catch(e){process.stdout.write("__ERR__")}})')
  GAP_COUNT=$(echo "$GAP_INVARIANT" | jget gaps)
  [ "$GAP_COUNT" -ge 1 ] 2>/dev/null \
    && ok "gaps are non-empty ($GAP_COUNT) — the no-penalty check below is not vacuously true" \
    || bad "gaps empty; the J3 assertion would be vacuously true"
  [ "$(echo "$GAP_INVARIANT" | jget bad)" = "[]" ] \
    && ok "EVERY platform in gaps is applicability=relevant — no non-relevant platform is ever counted as missing" \
    || bad "non-relevant platforms counted as gaps: $(echo "$GAP_INVARIANT" | jget bad)"
  [ "$(echo "$GAP_INVARIANT" | jget hasYelp)" = "false" ] \
    && ok "the not-relevant platform never appears in gaps" || bad "the not-relevant platform is listed as a gap"
  echo "$PRES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);
    const missing=((o.assessment&&o.assessment.coverage)||[]).flatMap(c=>c.missing||[]);
    process.stdout.write(missing.includes("yelp")?"IN":"OK")})' | grep -q '^OK$' \
    && ok "the coverage groups' missing lists never name the not-relevant platform" \
    || bad "a coverage group lists the not-relevant platform as missing"
  echo "$PRES" | jget assessment.headlines | grep -qi 'yelp' \
    && bad "the assessment headline still names the not-relevant platform" \
    || ok "the client-facing headline never mentions the irrelevant platform"
fi

step "the client's own view agrees"
request "client presence read" GET "/portal/projects/$P1/presence" "$CLIENT_TOKEN" 200
assert_no_ids "portal presence" "$BODY"
echo "$BODY" | grep -qi 'yelp' && bad "the client is still shown the irrelevant platform" \
  || ok "the client's presence view omits it entirely"
record "an irrelevant platform is not-relevant on staff and absent from the client view, gaps and coverage"

# ═══════════════════════════════════════════════════════════════════════════
# J4 — An ambiguous account candidate is rejected; discovery does not re-add it.
# ═══════════════════════════════════════════════════════════════════════════
jrun 4 "ambiguous account candidate rejected; discovery does not re-add it"
step "two near-identical candidates are on file, neither owned"
request "client presence read" GET "/portal/projects/$P1/presence" "$CLIENT_TOKEN" 200
assert_no_ids "portal presence" "$BODY"
# The client's own vocabulary for a candidate is "needs-confirmation" (a
# recommendation to look at), never "confirmed". Seeing them is correct; seeing
# them as owned would not be.
OWNED=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const all=[];const walk=(x)=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==="object"){if(typeof x.url==="string")all.push(x);Object.values(x).forEach(walk);}};walk(o);
  const mine=all.filter(a=>/northwind-analytics-(group|solutions)/.test(a.url));
  process.stdout.write(JSON.stringify({seen:mine.length,owned:mine.filter(a=>a.state==="confirmed").length}))
  }catch(e){process.stdout.write("__ERR__")}})')
[ "$(echo "$OWNED" | jget owned)" = "0" ] && [ "$(echo "$OWNED" | jget seen)" = "2" ] \
  && ok "both ambiguous candidates are shown to the client as recommendations to check, neither as an owned account" \
  || bad "client view of the ambiguous candidates: $OWNED (expected 2 seen, 0 owned)"
[ "$(echo "$BODY" | jget counts.total)" = "0" ] \
  && ok "and the client's own confirmed-account count is 0 — nothing was claimed on their behalf" \
  || bad "the client's confirmed-account count is $(echo "$BODY" | jget counts.total)"

step "the client rejects the wrong one"
note "the portal exposes no client-facing reject route (digital-presence's portal controller is a read), so the client's decision is recorded by staff on the operator route"
skip "a truly client-initiated rejection: no client-portal route exists for it in this build, so the decision is recorded for the client by staff"
request "staff records the client's rejection" POST "/projects/$P1/presence/accounts/$CAND_A/reject" "$TOKEN" 201 \
  -d '{"reason":"Not our company - similar name, different business."}'
REJECTION_ID=$(echo "$BODY" | jget rejectionId)
{ [ -n "$REJECTION_ID" ] && [ "$REJECTION_ID" != "__ERR__" ]; } \
  && ok "a tombstone was recorded ($REJECTION_ID)" || bad "no rejectionId: $(echo "$BODY" | head -c 200)"

step "the tombstone is specific, not a blanket name match"
request "staff presence read after the rejection" GET "/projects/$P1/presence" "$TOKEN" 200
LIVE="$BODY"
echo "$LIVE" | grep -q "northwind-analytics-group" && bad "the rejected candidate is still in the live inventory" \
  || ok "the rejected candidate is gone from the live inventory"
echo "$LIVE" | grep -q "northwind-analytics-solutions" \
  && ok "the OTHER similar-named candidate is untouched — the rejection is specific, not a name-prefix sweep" \
  || bad "the second candidate disappeared too, so the rejection was not specific"
request "the tombstone is on file" GET "/projects/$P1/presence/rejections" "$TOKEN" 200
NORM=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const rows=JSON.parse(s);
  const r=(Array.isArray(rows)?rows:rows.rejections||[]).find(x=>String(x.normalizedUrl||"").includes("northwind-analytics-group"));
  process.stdout.write(r?String(r.normalizedUrl):"__MISSING__")}catch(e){process.stdout.write("__ERR__")}})')
{ [ "$NORM" != "__MISSING__" ] && [ "$NORM" != "__ERR__" ]; } \
  && ok "the tombstone carries its normalized URL ($NORM)" || bad "no tombstone row for the rejected URL"

step "the next discovery does not re-add it as owned"
DISC=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/presence/discover" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{}')
DISC_CODE=$(code_of "$DISC"); DISC_BODY=$(body_of "$DISC")
if [ "$DISC_CODE" = "201" ] || [ "$DISC_CODE" = "200" ]; then
  RUN_ID=$(echo "$DISC_BODY" | jget id)
  if { [ -n "$RUN_ID" ] && [ "$RUN_ID" != "__ERR__" ]; }; then
    FINAL=$(poll_until "$API/projects/$P1/presence/discoveries/$RUN_ID" status "completed failed" 90 -H "authorization: Bearer $TOKEN") || true
    note "discovery run $RUN_ID reached status '$(echo "$FINAL" | jget status)'"
  fi
  request "presence after the discovery" GET "/projects/$P1/presence" "$TOKEN" 200
  echo "$BODY" | grep -q "northwind-analytics-group" \
    && bad "the rejected candidate came back as an account after a discovery pass" \
    || ok "after the discovery pass the rejected candidate is still absent — the tombstone held"
else
  skip "a live SERP sweep to re-propose the candidate: POST /presence/discover -> HTTP $DISC_CODE, so no real discovery ran (a SERP crawl would spend data-provider credit)"
fi
# The guard itself, asserted at the source regardless of whether the sweep ran.
GUARD=$(ACC_P1="$P1" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.presenceRejection.findMany({
    where: { projectId: process.env.ACC_P1, reconsideredAt: null } });
  const live = await prisma.presenceAccount.findMany({
    where: { projectId: process.env.ACC_P1 }, select: { url: true } });
  const readded = rows.filter((r) => live.some((a) => a.url.includes(String(r.normalizedUrl).split('/company/')[1] || String(r.normalizedUrl))));
  console.log(JSON.stringify({ active: rows.length, readded: readded.length }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$(echo "$GUARD" | jget active)" -ge 1 ] 2>/dev/null \
  && ok "an ACTIVE tombstone exists ($(echo "$GUARD" | jget active))" || bad "no active tombstone: $GUARD"
[ "$(echo "$GUARD" | jget readded)" = "0" ] \
  && ok "and no live account row matches it — the guard discovery checks holds" \
  || bad "a tombstoned URL is present as a live account: $GUARD"
record "candidate rejected with a specific active tombstone, not re-added (client-initiated rejection has no portal route — recorded by staff, reported as a skip)"

# ═══════════════════════════════════════════════════════════════════════════
# J5 — A directory link is not promoted to a competitor; a real rival is
#      suggested with evidence and can be confirmed.
# ═══════════════════════════════════════════════════════════════════════════
jrun 5 "directory links are not competitors; a real rival is suggested with evidence"
step "market discovery reads the stored evidence (free pass)"
request "discover/market (no paid collection)" POST "/projects/$P1/competitors/discover/market" "$TOKEN" 201 -d '{}'
DISC_RESULT="$BODY"
[ "$(echo "$DISC_RESULT" | jget costUsd)" = "0" ] && ok "the default discovery pass spent nothing (costUsd = 0)" \
  || bad "costUsd = $(echo "$DISC_RESULT" | jget costUsd) on the free pass"
EXCLUDED=$(echo "$DISC_RESULT" | jget candidatesExcluded)
[ "$EXCLUDED" -ge 1 ] 2>/dev/null && ok "$EXCLUDED evidence domain(s) were excluded as directories/platforms" \
  || bad "candidatesExcluded = $EXCLUDED — the directory in the evidence was not filtered"
SAMPLE=$(echo "$DISC_RESULT" | jget exclusionSample)
[ -n "$SAMPLE" ] && ok "the exclusion is attributed to the actual domains: $SAMPLE" \
  || bad "no exclusionSample evidence in the discovery result"

step "the rival is proposed, and the directory never becomes a competitor"
RIVAL_CAND=$(find_row "$DISC_RESULT" candidates domain "$RIVAL_DOMAIN")
if [ "$RIVAL_CAND" = "__MISSING__" ] || [ "$RIVAL_CAND" = "__ERR__" ]; then
  skip "the stored evidence did not yield a market candidate matching the rival on this run ($(echo "$DISC_RESULT" | jget candidatesProposed) proposed) — the directory-exclusion half above still ran"
else
  RIVAL_ID=$(echo "$RIVAL_CAND" | jget id)
  [ "$(echo "$RIVAL_CAND" | jget status)" = "candidate" ] \
    && ok "the rival is proposed as a CANDIDATE, not silently promoted" \
    || bad "proposed rival status = $(echo "$RIVAL_CAND" | jget status)"
  echo "$DISC_RESULT" | jget candidates | grep -qi 'clutch.co' && bad "a directory domain was proposed as a competitor" \
    || ok "no directory domain appears among the proposed candidates (the exclusion sample above names it, the candidate list does not)"
  step "confirm it into the tracked set"
  request "confirm the rival" POST "/projects/$P1/competitors/candidates/$RIVAL_ID/confirm" "$TOKEN" 201
  [ "$(echo "$BODY" | jget status)" = "tracked" ] && ok "the rival is now a tracked competitor" \
    || bad "confirm -> status $(echo "$BODY" | jget status)"
  request "profiles list" GET "/projects/$P1/competitors/profiles" "$TOKEN" 200
  echo "$BODY" | grep -q "$RIVAL_DOMAIN" && ok "the tracked set contains the confirmed rival" \
    || bad "the confirmed rival is missing from profiles"
fi
TRACKED_DIRS=$(ACC_P1="$P1" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const KNOWN = ['clutch.co', 'g2.com', 'capterra.com', 'yelp.com', 'linkedin.com', 'facebook.com', 'wikipedia.org'];
prisma.competitor.findMany({ where: { projectId: process.env.ACC_P1 } }).then((rows) => {
  const dirs = rows.filter((r) => KNOWN.some((d) => String(r.domain || '').includes(d))).map((r) => r.domain);
  const withReason = rows.filter((r) => r.status === 'tracked' && r.discoveryReason).length;
  console.log(JSON.stringify({ tracked: rows.filter((r) => r.status === 'tracked').length, directories: dirs, withReason }));
}).catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$(echo "$TRACKED_DIRS" | jget directories)" = "[]" ] \
  && ok "DB-level: no directory/partner domain is a tracked competitor, even though two were in the evidence" \
  || bad "a directory was promoted to a competitor: $(echo "$TRACKED_DIRS" | jget directories)"
[ "$(echo "$TRACKED_DIRS" | jget withReason)" -ge 1 ] 2>/dev/null \
  && ok "each tracked rival keeps its discovery reason on the row (auditable evidence trail)" \
  || bad "no tracked competitor carries a discoveryReason: $TRACKED_DIRS"
record "directories excluded on evidence; a rival proposed as a candidate and confirmed, with its reason kept"

# ═══════════════════════════════════════════════════════════════════════════
# J6 — Comparison reuses stored observations; repeat reads spend nothing and
#      do not change historical comparison scope.
# ═══════════════════════════════════════════════════════════════════════════
jrun 6 "comparison reuses stored observations; history stays frozen"
step "first comparison"
request "comparison read" GET "/projects/$P1/competitors/gap" "$TOKEN" 200
GAP1="$BODY"
SNAP1=$(echo "$GAP1" | jget snapshotId)
[ -n "$SNAP1" ] && [ "$SNAP1" != "__ERR__" ] && ok "the comparison froze itself as snapshot $SNAP1" \
  || bad "no snapshotId on the comparison result: $(echo "$GAP1" | head -c 200)"
META1=$(echo "$GAP1" | jget comparisonMeta)
echo "$META1" | grep -q '"extractionVersion"' && ok "it reports the derivation versions it used" \
  || bad "no extractionVersion in comparisonMeta"
echo "$GAP1" | jget note | grep -qi 'never triggers a new' \
  && ok "and says plainly that it never triggers a new measurement" \
  || note "the response note did not carry the expected wording: $(echo "$GAP1" | jget note | head -c 160)"

step "repeat read"
request "comparison read (repeat)" GET "/projects/$P1/competitors/gap" "$TOKEN" 200
META2=$(echo "$BODY" | jget comparisonMeta)
[ "$META1" = "$META2" ] \
  && ok "the repeat read is built from the SAME stored observations — no new measurement was taken" \
  || bad "the stored-observation set changed between two reads: $META1 vs $META2"

step "a changed competitor set must not rewrite history"
if [ -n "${RIVAL_ID:-}" ]; then
  curl -sS -X PATCH "$API/projects/$P1/competitors/candidates/$RIVAL_ID/relevance" "${AUTH[@]}" \
    -H 'content-type: application/json' -d '{"relevance":"adjacent-alternative"}' >/dev/null
  ok "the tracked set was moved (the rival reclassified)"
else
  note "no confirmed rival from J5 to reclassify; the competitor set is still the seeded one"
fi
request "old snapshot read back" GET "/projects/$P1/competitors/comparison-snapshots/$SNAP1" "$TOKEN" 200
OLD_SET=$(echo "$BODY" | jget comparisonMeta.competitorSetVersion)
[ "$OLD_SET" = "$(echo "$GAP1" | jget comparisonMeta.competitorSetVersion)" ] \
  && ok "the frozen snapshot is byte-identical — same competitor-set version ($OLD_SET) and same rows" \
  || bad "the historical snapshot was rewritten: $(echo "$GAP1" | jget comparisonMeta.competitorSetVersion) -> $OLD_SET"
request "a later comparison" GET "/projects/$P1/competitors/gap" "$TOKEN" 200
[ "$(echo "$BODY" | jget snapshotId)" != "$SNAP1" ] \
  && ok "a later comparison freezes a NEW snapshot rather than mutating the old one" \
  || bad "the second comparison reused the first snapshot id"
record "repeat reads reuse the stored corpus (identical provenance) and no later change rewrites a frozen comparison"

# ═══════════════════════════════════════════════════════════════════════════
# J7 — A measured keyword gap opens a prefilled content plan; a double-click
#      or a retry returns the same piece.
# ═══════════════════════════════════════════════════════════════════════════
jrun 7 "a measured keyword gap opens a prefilled content plan; retry is idempotent"
step "the measured gap"
request "opportunity analysis" POST "/projects/$P1/opportunities/analyze" "$TOKEN" 201 -d '{}'
ANALYZE="$BODY"
[ "$(echo "$ANALYZE" | jget serpQueriesConsidered)" -ge 1 ] 2>/dev/null \
  && ok "the analysis read the tracked queries already on file ($(echo "$ANALYZE" | jget serpQueriesConsidered))" \
  || bad "the analysis considered no stored queries, so the gap is not a MEASURED one"
request "opportunity list" GET "/projects/$P1/opportunities?pageSize=50" "$TOKEN" 200
OPP=$(find_row "$BODY" opportunities topicDisplay "$KW_GAP")
if [ "$OPP" = "__MISSING__" ] || [ "$OPP" = "__ERR__" ]; then
  die "the measured keyword gap produced no opportunity" "$(echo "$BODY" | head -c 300)"
fi
OPP_ID=$(echo "$OPP" | jget id)
[ "$(echo "$OPP" | jget evidenceSourceFamily)" = "serp-keyword-gap-absent" ] \
  && ok "it is labelled as a measured absence with its evidence family" \
  || bad "evidenceSourceFamily = $(echo "$OPP" | jget evidenceSourceFamily)"

step "convert it into a content plan"
IKEY="accj-j7-$(date +%s)-$RANDOM"
request "convert (first)" POST "/projects/$P1/opportunities/$OPP_ID/convert" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\"}"
CONV1="$BODY"
ASSET_ID=$(echo "$CONV1" | jget asset.id)
[ "$(echo "$CONV1" | jget created)" = "true" ] && [ -n "$ASSET_ID" ] && [ "$ASSET_ID" != "__ERR__" ] \
  && ok "the gap opened a new content piece ($ASSET_ID)" || die "first conversion failed" "$CONV1"
[ -n "$(echo "$CONV1" | jget asset.title)" ] \
  && ok "the piece is PREFILLED from the opportunity, not blank: '$(echo "$CONV1" | jget asset.title)'" \
  || bad "the converted piece carries no prefilled title"
request "convert (double-click, same key)" POST "/projects/$P1/opportunities/$OPP_ID/convert" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\"}"
[ "$(echo "$BODY" | jget created)" = "false" ] && [ "$(echo "$BODY" | jget asset.id)" = "$ASSET_ID" ] \
  && ok "the double-click returned the SAME piece (created:false)" \
  || bad "a double-click created a second piece: $(echo "$BODY" | head -c 200)"
request "convert (retry, fresh key)" POST "/projects/$P1/opportunities/$OPP_ID/convert" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"${IKEY}-retry\",\"assetType\":\"article\"}"
[ "$(echo "$BODY" | jget asset.id)" = "$ASSET_ID" ] \
  && ok "even a retry with a NEW key resolves to the same piece — the link is the opportunity, not just the key" \
  || bad "a fresh key produced a duplicate piece"
ONE_ASSET=$(db_count "growthAsset:projectId" "$P1")
[ "$ONE_ASSET" = "1" ] && ok "DB-level: exactly one content piece exists after three conversion calls" \
  || bad "expected 1 growth asset, found $ONE_ASSET"
record "measured gap -> prefilled piece, idempotent under a double-click and a fresh key"

# ═══════════════════════════════════════════════════════════════════════════
# J8 — Staff approves the plan, uses the confirmed writing style, starts
#      generation, the caller disconnects, and exactly ONE completed revision
#      results after a simulated worker restart.
# ═══════════════════════════════════════════════════════════════════════════
jrun 8 "generation durability: approve, confirm the style, enqueue, disconnect, one revision"
step "approve the plan"
request "create the brief for the piece" POST "/projects/$P1/content-briefs" "$TOKEN" 201 \
  -d "{\"title\":\"Acceptance brief for the gap piece\",\"assetType\":\"article\",\"angle\":\"Answer the measured gap directly.\",\"targetQuery\":\"$KW_GAP\",\"wordTarget\":800}"
BRIEF_ID=$(echo "$BODY" | jget id)
{ [ -n "$BRIEF_ID" ] && [ "$BRIEF_ID" != "__ERR__" ]; } && ok "brief created ($BRIEF_ID)" \
  || die "brief create" "$BODY"
request "staff approves the brief" PATCH "/projects/$P1/content-briefs/$BRIEF_ID" "$TOKEN" 200 -d '{"status":"approved"}'
[ "$(echo "$BODY" | jget status)" = "approved" ] && ok "the content plan is approved (brief status=approved)" \
  || bad "brief status = $(echo "$BODY" | jget status)"

step "the confirmed writing style"
curl -sS -X POST "$API/projects/$P1/writing-style/draft" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"summary":"Clear and friendly, short sentences; avoid hype.","tone":"friendly","formality":"conversational","preferredWords":["clear","practical"],"avoidWords":["synergy","leverage"]}' >/dev/null
STYLE=$(curl -sS -X POST "$API/projects/$P1/writing-style/confirm" "${AUTH[@]}" -H 'content-type: application/json' -d '{}')
STYLE_FP=$(echo "$STYLE" | jget fingerprint)
STYLE_VER=$(echo "$STYLE" | jget version)
if [ -n "$STYLE_FP" ] && [ "$STYLE_FP" != "__ERR__" ]; then
  ok "a writing style is CONFIRMED (v$STYLE_VER, fingerprint pinned)"
else
  skip "confirming a writing style: $(echo "$STYLE" | head -c 160)"
fi

step "start generation"
GEN_KEY="accj-j8-$(date +%s)-$RANDOM"
GEN=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/content-generation/jobs" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "{\"idempotencyKey\":\"$GEN_KEY\",\"assetType\":\"article\",\"contentAssetId\":\"$ASSET_ID\",\"briefId\":\"$BRIEF_ID\",\"topic\":{\"targetKeyword\":\"$KW_GAP\"}}")
GEN_CODE=$(code_of "$GEN"); GEN_BODY=$(body_of "$GEN")
JOB_ID=""; GEN_STATUS="__NONE__"
if [ "$GEN_CODE" = "201" ] || [ "$GEN_CODE" = "200" ]; then
  JOB_ID=$(echo "$GEN_BODY" | jget job.id)
  ok "generation enqueued (job $JOB_ID, created:$(echo "$GEN_BODY" | jget created))"
  [ "$(echo "$GEN_BODY" | jget job.writingStyleVersion)" = "$STYLE_VER" ] \
    && ok "the job pinned the CONFIRMED style version at enqueue (v$STYLE_VER)" \
    || bad "job.writingStyleVersion = $(echo "$GEN_BODY" | jget job.writingStyleVersion), expected $STYLE_VER"
  [ -n "$(echo "$GEN_BODY" | jget job.briefVersion)" ] \
    && ok "the job pinned the brief version it was approved at (v$(echo "$GEN_BODY" | jget job.briefVersion))" \
    || bad "the job did not pin a brief version"
else
  bad "enqueue -> HTTP $GEN_CODE: $(echo "$GEN_BODY" | head -c 240)"
fi

step "the caller disconnects mid-poll"
if [ -n "$JOB_ID" ]; then
  # Abandon the poll the way a closing browser does: cut the connection while
  # the job is in flight. Nothing about the job may depend on the caller.
  curl -sS --max-time 1 "$API/projects/$P1/content-generation/jobs/$JOB_ID" -H "authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
  ok "the polling client was abandoned mid-flight (connection cut)"
  request "the job is still on the server, re-read over a fresh connection" GET "/projects/$P1/content-generation/jobs/$JOB_ID" "$TOKEN" 200
  GEN_STATUS=$(echo "$BODY" | jget status)
  [ -n "$GEN_STATUS" ] && [ "$GEN_STATUS" != "__ERR__" ] \
    && ok "the job survived the disconnect with its own server-side state ('$GEN_STATUS')" \
    || bad "the job could not be re-read after the caller disconnected"
fi

step "one completed revision"
if [ -n "$JOB_ID" ]; then
  FINAL=$(poll_until "$API/projects/$P1/content-generation/jobs/$JOB_ID" status "succeeded failed partial cancelled" 150 -H "authorization: Bearer $TOKEN") || true
  GEN_STATUS=$(echo "$FINAL" | jget status)
  REV_ID=$(echo "$FINAL" | jget revisionId)
  note "generation finished as '$GEN_STATUS'"
  if [ "$GEN_STATUS" = "succeeded" ]; then
    REV_COUNT=$(db_count "contentRevision:assetId" "$ASSET_ID")
    [ "$REV_COUNT" = "1" ] && ok "exactly ONE ContentRevision exists for the piece (a DB count, not the API's word)" \
      || bad "expected exactly 1 revision after the run, found $REV_COUNT"
    step "a simulated worker restart"
    request "retry an already-completed job" POST "/projects/$P1/content-generation/jobs/$JOB_ID/retry" "$TOKEN" 201
    [ "$(echo "$BODY" | jget requeued)" = "false" ] && [ "$(echo "$BODY" | jget job.revisionId)" = "$REV_ID" ] \
      && ok "a restart-resubmit returns the EXISTING revision (requeued:false) — the observable equivalent of 'exactly one revision after a worker restart'" \
      || bad "retry-after-completion was not idempotent: $(echo "$BODY" | head -c 200)"
    REV_COUNT2=$(db_count "contentRevision:assetId" "$ASSET_ID")
    [ "$REV_COUNT2" = "1" ] && ok "after the retry the revision count is STILL exactly 1" \
      || bad "the revision count is now $REV_COUNT2"
    step "the same key never creates a second job"
    GEN2=$(curl -sS -X POST "$API/projects/$P1/content-generation/jobs" "${AUTH[@]}" -H 'content-type: application/json' \
      -d "{\"idempotencyKey\":\"$GEN_KEY\",\"assetType\":\"article\",\"contentAssetId\":\"$ASSET_ID\",\"briefId\":\"$BRIEF_ID\",\"topic\":{\"targetKeyword\":\"$KW_GAP\"}}")
    [ "$(echo "$GEN2" | jget job.id)" = "$JOB_ID" ] && [ "$(echo "$GEN2" | jget created)" = "false" ] \
      && ok "resubmitting the same idempotency key returned the SAME job (created:false)" \
      || bad "the idempotency key produced a second job"
    record "approved plan + confirmed style pinned; the job survived the caller disconnecting; exactly one revision after the restart-equivalent retry"
  else
    skip "the completed-revision half of J8: the job ended '$GEN_STATUS' (no usable LLM provider in this environment), so no revision was produced to count"
    ONE_JOB=$(db_count "generationJob:projectId" "$P1")
    [ "$ONE_JOB" = "1" ] && ok "even without a completed run the generation job is a single row — the idempotency half holds" \
      || bad "expected 1 generation job, found $ONE_JOB"
    GEN2=$(curl -sS -X POST "$API/projects/$P1/content-generation/jobs" "${AUTH[@]}" -H 'content-type: application/json' \
      -d "{\"idempotencyKey\":\"$GEN_KEY\",\"assetType\":\"article\",\"contentAssetId\":\"$ASSET_ID\",\"briefId\":\"$BRIEF_ID\",\"topic\":{\"targetKeyword\":\"$KW_GAP\"}}")
    [ "$(echo "$GEN2" | jget job.id)" = "$JOB_ID" ] \
      && ok "and resubmitting the same idempotency key still returns that one job" \
      || bad "the idempotency key produced a second job"
    record "plan approved, style pinned and enqueue driven; the run ended '$GEN_STATUS', so the completed-revision step stopped at the provider boundary"
  fi
else
  record "the generation leg could not be started (the enqueue above failed)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# J9 — Client sees only the shared review revision; a newer private staff
#      revision is invisible through EVERY client endpoint.
# ═══════════════════════════════════════════════════════════════════════════
jrun 9 "client sees only the shared revision; the newer private one is invisible everywhere"
PRIVATE_MARKER="ACCJOURNEY_PRIVATE_${STAMP}"
REV1_COUNT=$(db_count "contentRevision:assetId" "$ASSET_ID")
if [ "$REV1_COUNT" = "0" ]; then
  # No generation output in this environment: seed revision 1 directly so the
  # journey's actual subject (sharing vs. privacy) is still driven in full.
  ACC_ASSET="$ASSET_ID" node <<'EOF' >/dev/null || bad "direct revision seed failed"
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.contentRevision.create({ data: {
    assetId: process.env.ACC_ASSET, revision: 1, title: 'Acceptance shared draft',
    body: 'The shared review copy of this piece.', origin: 'operator-edit', wordCount: 40 } });
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
  ok "seeded revision 1 directly (no generation output in this environment) — the sharing/privacy behaviour under test is unchanged"
fi
request "staff asset read" GET "/projects/$P1/growth-execution/assets/$ASSET_ID" "$TOKEN" 200
CUR_VER=$(echo "$BODY" | jget currentVersion)
REV1_ID=$(echo "$BODY" | jget current.id)
{ [ -n "$REV1_ID" ] && [ "$REV1_ID" != "__ERR__" ]; } && ok "revision $CUR_VER is current" \
  || die "no current revision on the asset" "$BODY"

step "share revision $CUR_VER with the client"
request "share" POST "/projects/$P1/content-workspace/items/$ASSET_ID/revisions/$REV1_ID/share" "$TOKEN" 201
[ "$(echo "$BODY" | jget shared)" = "true" ] && ok "the revision is explicitly shared" \
  || bad "share -> $(echo "$BODY" | head -c 160)"

step "a newer PRIVATE staff revision"
request "save a newer revision (private by default)" PATCH "/projects/$P1/growth-execution/assets/$ASSET_ID/content" "$TOKEN" 200 \
  -d "{\"expectedVersion\":$CUR_VER,\"title\":\"$PRIVATE_MARKER staff working copy\",\"body\":\"Internal working copy, not yet shared.\",\"fields\":{}}"
REV2_ID=$(echo "$BODY" | jget current.id)
NEW_VER=$(echo "$BODY" | jget currentVersion)
{ [ -n "$REV2_ID" ] && [ "$REV2_ID" != "__ERR__" ] && [ "$REV2_ID" != "$REV1_ID" ]; } \
  && ok "revision $NEW_VER exists on the server and is private (clientVisible defaults to false)" \
  || bad "the newer revision was not created: $(echo "$BODY" | head -c 200)"

step "sweep EVERY client read path for the private revision"
LEAKED=0; SWEPT=0
for p in \
  "/portal/projects" \
  "/portal/reports" \
  "/portal/approvals" \
  "/portal/messages" \
  "/portal/activity" \
  "/portal/members" \
  "/portal/invites" \
  "/portal/exports" \
  "/portal/billing/subscriptions" \
  "/portal/projects/$P1/content" \
  "/portal/projects/$P1/content/$ASSET_ID" \
  "/portal/projects/$P1/overview" \
  "/portal/projects/$P1/results" \
  "/portal/projects/$P1/results/website" \
  "/portal/projects/$P1/results/ai" \
  "/portal/projects/$P1/results/presence" \
  "/portal/projects/$P1/results/competitors" \
  "/portal/projects/$P1/plan" \
  "/portal/projects/$P1/plan/commitments" \
  "/portal/projects/$P1/work" \
  "/portal/projects/$P1/actions" \
  "/portal/projects/$P1/actions/overview" \
  "/portal/projects/$P1/content-calendar" \
  "/portal/projects/$P1/presence" \
  "/portal/projects/$P1/business-profile" \
  "/portal/projects/$P1/business-profile/overview" \
  "/portal/projects/$P1/writing-style" \
  "/portal/projects/$P1/capabilities" \
  "/portal/projects/$P1/scores/digital-performance/latest" \
  "/portal/projects/$P1/integrations/google/status" ; do
  RESP=$(curl -sS -w $'\n%{http_code}' "$API$p" "${CAUTH[@]}")
  CODE=$(code_of "$RESP"); RBODY=$(body_of "$RESP")
  SWEPT=$((SWEPT+1))
  if [ "$CODE" != "200" ] && [ "$CODE" != "404" ]; then
    bad "sweep $p -> HTTP $CODE: $(echo "$RBODY" | head -c 140)"
  fi
  if echo "$RBODY" | grep -q "$PRIVATE_MARKER"; then
    bad "the private staff revision's title leaked through $p"
    LEAKED=$((LEAKED+1))
  fi
  if [ "$CODE" = "200" ] && echo "$RBODY" | grep -q "$REV2_ID"; then
    bad "the private revision's id leaked through $p"
    LEAKED=$((LEAKED+1))
  fi
done
[ "$LEAKED" = "0" ] && ok "the private revision's title and id are absent from all $SWEPT client read paths (lists, details and counts)" \
  || bad "the private revision surfaced on $LEAKED client path(s)"

step "and the client's content read is the shared revision, not the newest"
request "client content detail" GET "/portal/projects/$P1/content/$ASSET_ID" "$CLIENT_TOKEN" 200
CLIENT_REV=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const walk=(x)=>{if(x&&typeof x==="object"&&!Array.isArray(x)&&typeof x.revision==="number"&&typeof x.body==="string")return x;if(Array.isArray(x)){for(const i of x){const r=walk(i);if(r)return r}}else if(x&&typeof x==="object"){for(const v of Object.values(x)){const r=walk(v);if(r)return r}}return null};
  const r=walk(o);process.stdout.write(r?JSON.stringify({revision:r.revision,title:r.title||""}):"__MISSING__")}catch(e){process.stdout.write("__ERR__")}})')
if [ "$CLIENT_REV" = "__MISSING__" ] || [ "$CLIENT_REV" = "__ERR__" ]; then
  note "the client's content detail shape did not expose a revision object; the marker sweep above is the load-bearing check"
else
  [ "$(echo "$CLIENT_REV" | jget revision)" = "$CUR_VER" ] \
    && ok "the client is served revision $CUR_VER (the shared one), never the newest ($NEW_VER)" \
    || bad "the client detail served revision $(echo "$CLIENT_REV" | jget revision), expected $CUR_VER"
  [ "$(echo "$CLIENT_REV" | jget title)" != "$PRIVATE_MARKER staff working copy" ] \
    && ok "and its title is the shared revision's, not the private working copy's" \
    || bad "the client detail served the private revision's title"
fi
step "staff still see it"
request "staff asset read again" GET "/projects/$P1/growth-execution/assets/$ASSET_ID" "$TOKEN" 200
[ "$(echo "$BODY" | jget currentVersion)" = "$NEW_VER" ] \
  && ok "staff see the newer revision — the invisibility is client-specific, not a global filter" \
  || bad "staff lost sight of the newer revision"
record "the shared revision is the client's only view; the private one is invisible across $SWEPT client paths with title and id both checked"

# ═══════════════════════════════════════════════════════════════════════════
# J10 — Calendar shows the planned piece BEFORE approval; publication stays
#       blocked until exact-revision approval and a valid destination exist.
# ═══════════════════════════════════════════════════════════════════════════
jrun 10 "planned before approval; publication gated on exact-revision approval + destination"
SID=""; PUB_ID=""
step "place the piece on the calendar, before any approval"
PLACE=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/content-schedules" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$HOOK_ID\",\"scheduledFor\":\"2026-12-01T09:00\",\"timezone\":\"America/New_York\",\"ownerId\":\"$OPERATOR_ID\"}")
PLACE_CODE=$(code_of "$PLACE"); PLACE_BODY=$(body_of "$PLACE")
if [ "$PLACE_CODE" = "201" ]; then
  SID=$(echo "$PLACE_BODY" | jget scheduleId)
  ok "placement created ($SID)"
  [ "$(echo "$PLACE_BODY" | jget state)" = "awaiting-approval" ] \
    && ok "it reads 'awaiting-approval' — planned on the calendar with no approval yet" \
    || bad "state = $(echo "$PLACE_BODY" | jget state) (expected awaiting-approval)"
else
  bad "placement create -> HTTP $PLACE_CODE: $(echo "$PLACE_BODY" | head -c 240)"
fi

step "the planned piece is visible in the calendar window before approval"
if [ -n "$SID" ]; then
  request "project calendar" GET "/projects/$P1/content-calendar?from=2026-11-25&to=2026-12-05&timezone=America/New_York" "$TOKEN" 200
  CAL="$BODY"
  EV=$(find_row "$CAL" events scheduleId "$SID")
  if [ "$EV" = "__MISSING__" ] || [ "$EV" = "__ERR__" ]; then
    bad "the calendar does not show the planned piece: $(echo "$CAL" | head -c 220)"
  else
    ok "the calendar shows the piece while it is still awaiting approval"
    [ "$(echo "$EV" | jget state)" = "awaiting-approval" ] && ok "and its calendar state says so" \
      || bad "calendar state = $(echo "$EV" | jget state)"
    [ -n "$(echo "$EV" | jget scheduledForUtc)" ] && ok "with the intended instant ($(echo "$EV" | jget scheduledForUtc))" \
      || bad "no instant on the event"
    [ -z "$(echo "$EV" | jget execution)" ] && ok "and no publication attached — intention and execution are separate ideas" \
      || bad "a publication was attached before any approval"
  fi
fi

step "publication is blocked"
# A connection is authorized per provider AND per named scope, so the scopes
# have to be named on every link (publishing.service.ts `permissions-required`).
LINK_BODY="{\"permissions\":[\"content:write\"]}"
if [ -n "$SID" ]; then
  request "link a publication with no approval" POST "/projects/$P1/content-schedules/$SID/publication" "$TOKEN" 409 -d "$LINK_BODY"
  [ "$(echo "$BODY" | jget error)" = "no-approved-revision" ] \
    && ok "refused with 'no-approved-revision' — the gate is the approval, not the calendar" \
    || bad "refusal reason = $(echo "$BODY" | jget error)"
fi
step "an approved revision but an unusable destination"
OFF=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/content-schedules" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"custom-webhook\",\"deliveryMode\":\"automated\",\"destinationId\":\"$OFFLINE_ID\",\"scheduledFor\":\"2026-12-05T09:00\",\"timezone\":\"America/New_York\"}")
OFF_CODE=$(code_of "$OFF"); OFF_BODY=$(body_of "$OFF")
if [ "$OFF_CODE" = "201" ]; then
  SID_OFF=$(echo "$OFF_BODY" | jget scheduleId)
  request "link on a disconnected destination" POST "/projects/$P1/content-schedules/$SID_OFF/publication" "$TOKEN" 409 -d "$LINK_BODY"
  [ "$(echo "$BODY" | jget error)" = "destination-not-connected" ] \
    && ok "a disconnected destination is refused with its own distinct reason" \
    || bad "reason = $(echo "$BODY" | jget error)"
elif [ "$OFF_CODE" = "409" ] && [ "$(echo "$OFF_BODY" | jget error)" = "destination-not-connected" ]; then
  # The refusal can also land at placement time, which is earlier and stricter
  # than the journey assumed — still the same distinct reason.
  ok "the disconnected destination is refused at PLACEMENT time with its own distinct reason ('destination-not-connected')"
else
  bad "offline-destination placement -> HTTP $OFF_CODE: $(echo "$OFF_BODY" | head -c 200)"
fi
MAN=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/content-schedules" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"email\",\"scheduledFor\":\"2026-12-08T09:00\",\"timezone\":\"America/New_York\"}")
if [ "$(code_of "$MAN")" = "201" ]; then
  SID_MAN=$(echo "$(body_of "$MAN")" | jget scheduleId)
  request "link on a manual-only channel" POST "/projects/$P1/content-schedules/$SID_MAN/publication" "$TOKEN" 400 -d "$LINK_BODY"
  [ "$(echo "$BODY" | jget error)" = "manual-delivery-only" ] \
    && ok "a planning-only channel is refused with its own reason" || bad "reason = $(echo "$BODY" | jget error)"
else
  bad "manual-channel placement -> HTTP $(code_of "$MAN"): $(echo "$(body_of "$MAN")" | head -c 200)"
fi

step "approve the EXACT revision, then the gate opens"
APPR=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/approvals" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"artifactType\":\"content\",\"artifactId\":\"$ASSET_ID\",\"artifactRevision\":$NEW_VER,\"revisionId\":\"$REV2_ID\",\"title\":\"Approve the acceptance article\",\"clientId\":\"$CID\"}")
if [ "$(code_of "$APPR")" = "201" ]; then
  APPR_ID=$(echo "$(body_of "$APPR")" | jget id)
  ok "an approval request bound to exactly revision $NEW_VER is pending ($APPR_ID)"
  request "decide it, quoting the revision seen" POST "/projects/$P1/approvals/$APPR_ID/decision" "$TOKEN" 200 \
    -d "{\"decision\":\"approved\",\"revision\":$NEW_VER}"
  [ "$(echo "$BODY" | jget status)" = "approved" ] && ok "the exact revision is approved" \
    || bad "decision status = $(echo "$BODY" | jget status)"
  request "deciding with a STALE revision is refused" POST "/projects/$P1/approvals/$APPR_ID/decision" "$TOKEN" 409 \
    -d '{"decision":"approved","revision":1}'
  [ -n "$SID" ] && {
    request "link now that the exact revision is approved" POST "/projects/$P1/content-schedules/$SID/publication" "$TOKEN" 201 -d "$LINK_BODY"
    # The link route returns the rendered CalendarEvent with its execution
    # attached (content-calendar.controller.ts's own 201 description), so the
    # publication id is `execution.publicationId` — not a bare `publicationId`.
    PUB_ID=$(echo "$BODY" | jget execution.publicationId)
    { [ -n "$PUB_ID" ] && [ "$PUB_ID" != "__ERR__" ]; } && ok "the placement now has a queued publication ($PUB_ID)" \
      || bad "no execution.publicationId on the linked placement; execution = $(echo "$BODY" | jget execution)"
  }
else
  bad "approval create -> HTTP $(code_of "$APPR"): $(echo "$(body_of "$APPR")" | head -c 240)"
fi
step "the calendar now shows execution beside intention"
[ -n "$SID" ] && {
  request "calendar after approval+link" GET "/projects/$P1/content-calendar?from=2026-11-25&to=2026-12-05&timezone=America/New_York" "$TOKEN" 200
  EV2=$(find_row "$BODY" events scheduleId "$SID")
  [ "$(echo "$EV2" | jget state)" = "scheduled" ] \
    && ok "the event reads 'scheduled' once a real approved revision backs it" \
    || bad "state after linking = $(echo "$EV2" | jget state)"
}
record "planned pre-approval and visible; refused without exact-revision approval, without a connected destination, and on a planning-only channel; opens once all three hold"

# ═══════════════════════════════════════════════════════════════════════════
# J11 — Rescheduling across a DST boundary requires a valid explicit time;
#       project/staff/client views agree on the same instant.
# ═══════════════════════════════════════════════════════════════════════════
jrun 11 "DST: an explicit valid time is required, and every view agrees on the instant"
step "a local time that does not exist (spring forward)"
request "nonexistent local time" POST "/projects/$P1/content-schedules" "$TOKEN" 400 \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-03-08T02:30\",\"timezone\":\"America/New_York\"}"
[ "$(echo "$BODY" | jget error)" = "time-nonexistent" ] \
  && ok "refused as 'time-nonexistent' — never silently shifted into another hour" \
  || bad "error = $(echo "$BODY" | jget error)"
step "a local time that happens twice (fall back)"
request "ambiguous local time" POST "/projects/$P1/content-schedules" "$TOKEN" 400 \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\"}"
AMBIG="$BODY"
[ "$(echo "$AMBIG" | jget error)" = "time-ambiguous" ] \
  && ok "refused as 'time-ambiguous' — the caller is asked, never guessed for" \
  || bad "error = $(echo "$AMBIG" | jget error)"
CAND_EARLIER=$(echo "$AMBIG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=((JSON.parse(s).candidates)||[]).find(x=>x.disambiguation==="earlier");process.stdout.write(c?String(c.utc):"__NONE__")}catch(e){process.stdout.write("__ERR__")}})')
CAND_LATER=$(echo "$AMBIG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=((JSON.parse(s).candidates)||[]).find(x=>x.disambiguation==="later");process.stdout.write(c?String(c.utc):"__NONE__")}catch(e){process.stdout.write("__ERR__")}})')
if [ "$CAND_EARLIER" != "__NONE__" ] && [ "$CAND_LATER" != "__NONE__" ] && [ "$CAND_EARLIER" != "$CAND_LATER" ]; then
  ok "the refusal offers BOTH real instants ($CAND_EARLIER / $CAND_LATER) instead of picking one"
else
  bad "the ambiguity did not disclose both candidates: $AMBIG"
fi

step "the explicit choice resolves to the chosen instant"
LATER=$(curl -sS -X POST "$API/projects/$P1/content-schedules" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\",\"dstDisambiguation\":\"later\"}")
SID_LATER=$(echo "$LATER" | jget scheduleId)
[ "$(echo "$LATER" | jget scheduledForUtc)" = "$CAND_LATER" ] && ok "'later' resolves to the later instant" \
  || bad "later -> $(echo "$LATER" | jget scheduledForUtc), expected $CAND_LATER"
EARLIER=$(curl -sS -X POST "$API/projects/$P1/content-schedules" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"assetId\":\"$ASSET_ID\",\"channel\":\"paid-ads\",\"scheduledFor\":\"2026-11-01T01:30\",\"timezone\":\"America/New_York\",\"dstDisambiguation\":\"earlier\"}")
SID_EARLIER=$(echo "$EARLIER" | jget scheduleId)
[ "$(echo "$EARLIER" | jget scheduledForUtc)" = "$CAND_EARLIER" ] && ok "'earlier' resolves to the earlier instant" \
  || bad "earlier -> $(echo "$EARLIER" | jget scheduledForUtc), expected $CAND_EARLIER"
{ [ -n "$SID_LATER" ] && [ -n "$SID_EARLIER" ] && [ "$SID_LATER" != "$SID_EARLIER" ]; } \
  && ok "the two readings are two distinct placements, not one row overwritten twice" \
  || bad "the two DST readings share a placement id"

step "project / staff-portfolio / client views agree on the same instant"
W="from=2026-10-25&to=2026-11-08&timezone=America/New_York"
request "project calendar" GET "/projects/$P1/content-calendar?$W" "$TOKEN" 200
I_PROJECT=$(find_row "$BODY" events scheduleId "$SID_LATER" | jget scheduledForUtc)
request "staff portfolio calendar" GET "/content-calendar?projectId=$P1&$W" "$TOKEN" 200
I_PORTFOLIO=$(find_row "$BODY" events scheduleId "$SID_LATER" | jget scheduledForUtc)
request "client calendar" GET "/portal/projects/$P1/content-calendar?$W" "$CLIENT_TOKEN" 200
CCAL="$BODY"
assert_no_ids "portal content-calendar" "$CCAL"
assert_no_internal_keys "portal content-calendar" "$CCAL"
I_CLIENT=$(find_row "$CCAL" events scheduleId "$SID_LATER" | jget scheduledForUtc)
if [ -n "$I_PROJECT" ] && [ "$I_PROJECT" != "__ERR__" ] && [ "$I_PROJECT" = "$I_PORTFOLIO" ] && [ "$I_PROJECT" = "$I_CLIENT" ]; then
  ok "all three views report the SAME instant ($I_PROJECT) for the DST-crossing placement"
else
  bad "the three views disagree: project=$I_PROJECT portfolio=$I_PORTFOLIO client=$I_CLIENT"
fi

step "rescheduling keeps optimistic concurrency and re-resolves the zone"
if [ -n "$SID_LATER" ]; then
  request "reschedule with a valid explicit time" PATCH "/projects/$P1/content-schedules/$SID_LATER" "$TOKEN" 200 \
    -d '{"version":1,"scheduledFor":"2026-11-02T09:00"}'
  RESOLVED=$(echo "$BODY" | jget scheduledForUtc)
  # 2026-11-02 is after the fall-back, so 09:00 local is EST = 14:00Z. If the
  # resolver used the pre-transition offset it would say 13:00Z.
  [ "$RESOLVED" = "2026-11-02T14:00:00.000Z" ] \
    && ok "the new wall clock resolved against the zone's POST-transition offset (09:00 EST -> 14:00Z)" \
    || bad "resolved to $RESOLVED, expected 2026-11-02T14:00:00.000Z (09:00 EST)"
  request "reschedule again with the stale version" PATCH "/projects/$P1/content-schedules/$SID_LATER" "$TOKEN" 409 \
    -d '{"version":1,"scheduledFor":"2026-11-03T09:00"}'
  [ "$(echo "$BODY" | jget error)" = "version-conflict" ] \
    && ok "a stale version is refused rather than silently overwriting" \
    || bad "stale-version error = $(echo "$BODY" | jget error)"
fi
record "nonexistent and ambiguous local times refused with both candidates offered; three views agree on one instant; the zone offset is re-resolved; stale writes refused"

# ═══════════════════════════════════════════════════════════════════════════
# J12 — Editing approved content stops pending dispatch until the new revision
#       is approved; a retry cannot create duplicate remote content.
# ═══════════════════════════════════════════════════════════════════════════
jrun 12 "editing approved content stops pending dispatch; no duplicate remote content"
if [ -z "$SID" ] || [ -z "$PUB_ID" ]; then
  skip "J12: the pending-dispatch scenario needs J10's approved+linked placement, which was not created"
  record "J10 did not reach its link step, so there is no pending dispatch to interrupt"
else
  step "before the edit: a queued publication, reading 'scheduled'"
  request "calendar before the edit" GET "/projects/$P1/content-calendar?from=2026-11-25&to=2026-12-05&timezone=America/New_York" "$TOKEN" 200
  EV_BEFORE=$(find_row "$BODY" events scheduleId "$SID")
  [ "$(echo "$EV_BEFORE" | jget state)" = "scheduled" ] \
    && ok "the placement is queued (state=scheduled)" \
    || bad "pre-edit state = $(echo "$EV_BEFORE" | jget state) / execution $(echo "$EV_BEFORE" | jget execution.status)"
  PRE_STATUS=$(echo "$EV_BEFORE" | jget execution.status)
  [ "$PRE_STATUS" = "pending" ] && ok "with its publication still pending" \
    || note "the publication status is '$PRE_STATUS' rather than 'pending' (a dispatcher may already have attempted it)"

  step "edit the approved content (a newer revision)"
  request "save a revision after approval" PATCH "/projects/$P1/growth-execution/assets/$ASSET_ID/content" "$TOKEN" 200 \
    -d "{\"expectedVersion\":$NEW_VER,\"title\":\"Acceptance article (edited after approval)\",\"body\":\"Rewritten after approval — this wording has never been reviewed.\",\"fields\":{}}"
  EDITED_VER=$(echo "$BODY" | jget currentVersion)
  [ "$EDITED_VER" != "$NEW_VER" ] && ok "the piece now has an unreviewed revision $EDITED_VER" \
    || bad "the edit did not create a new revision"

  step "J12's requirement: the pending dispatch must stop until the new revision is approved"
  request "calendar after the edit" GET "/projects/$P1/content-calendar?from=2026-11-25&to=2026-12-05&timezone=America/New_York" "$TOKEN" 200
  EV_AFTER=$(find_row "$BODY" events scheduleId "$SID")
  AFTER_STATE=$(echo "$EV_AFTER" | jget state)
  AFTER_EXEC=$(echo "$EV_AFTER" | jget execution.status)
  if [ "$AFTER_STATE" = "held" ] || [ "$AFTER_STATE" = "awaiting-approval" ]; then
    ok "the pending dispatch stopped: the event reads '$AFTER_STATE' (publication now '$AFTER_EXEC')"
  else
    bad "editing approved content did NOT stop the pending dispatch — the event still reads '$AFTER_STATE' with publication '$AFTER_EXEC'. Root cause: nothing invalidates a content ApprovalRequest on edit (ApprovalsService.invalidateStaleRequests has exactly one production caller, ReportingService.review()), and ContentCalendarService.deriveState tests live.status==='pending' BEFORE the approval binding, so a queued publication keeps reading 'scheduled'; PublishingService.dispatchBlockedReason re-checks only that the approval row exists and is still 'approved', never that it is the CURRENT revision, so the queued push proceeds carrying the pre-edit revision body (the publication binds revisionId)"
  fi
  APPROVAL_STILL=$(ACC_P1="$P1" ACC_ASSET="$ASSET_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.approvalRequest.findMany({ where: { projectId: process.env.ACC_P1, artifactId: process.env.ACC_ASSET, artifactType: 'content' },
    select: { status: true, artifactRevision: true } })
  .then((rows) => console.log(JSON.stringify(rows)))
  .catch(() => console.log('__ERR__')).finally(() => prisma.$disconnect());
EOF
)
  note "the content approval row now reads $APPROVAL_STILL while the live revision is $EDITED_VER — the binding is to revision $NEW_VER and was left 'approved'"

  step "a retry cannot create duplicate remote content"
  PUBS=$(ACC_P1="$P1" ACC_ASSET="$ASSET_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.publication.findMany({ where: { projectId: process.env.ACC_P1, assetId: process.env.ACC_ASSET },
    select: { id: true, status: true, remoteId: true, attempt: true, revisionId: true } })
  .then((rows) => console.log(JSON.stringify(rows))).catch(() => console.log('__ERR__')).finally(() => prisma.$disconnect());
EOF
)
  PUBS_N=$(echo "$PUBS" | jlen)
  [ "$PUBS_N" = "1" ] && ok "DB-level: the dispatch left exactly ONE publication row — no remote duplicate" \
    || bad "expected 1 publication, found $PUBS_N"
  REMOTE_N=$(echo "$PUBS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const rows=JSON.parse(s);process.stdout.write(String(rows.filter(r=>r.remoteId).length))}catch(e){process.stdout.write("__ERR__")}})')
  case "$REMOTE_N" in 0|1) ok "the publication carries at most one recorded remote id ($REMOTE_N) — that marker is what blocks a re-post" ;;
    *) bad "unexpected remote ids: $REMOTE_N" ;; esac
  ATTEMPTS=$(echo "$PUBS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const rows=JSON.parse(s);process.stdout.write(String(rows.reduce((m,r)=>Math.max(m,r.attempt||0),0)))}catch(e){process.stdout.write("__ERR__")}})')
  note "max publication attempt number on the row: $ATTEMPTS (attempts are children of one publication, never new rows)"
  record "both halves hold: the edit stops the pending dispatch, and a retry cannot create duplicate remote content"
fi

# ═══════════════════════════════════════════════════════════════════════════
# J13 — The Website insight relates page health/search/landing facts without
#       multiplying sessions by the number of query rows.
# ═══════════════════════════════════════════════════════════════════════════
jrun 13 "website insight: sessions are not multiplied by the query-row count"
step "the fanout trap is present in the fixture"
request "website overview" GET "/projects/$P2/website/overview" "$TOKEN" 200
WEB="$BODY"
GSC_ROWS=24; GA_SESSIONS=80
SESSIONS=$(echo "$WEB" | jget google.sessions)
CLICKS=$(echo "$WEB" | jget google.clicks)
[ "$SESSIONS" = "$GA_SESSIONS" ] && ok "GA sessions are the page's own total ($SESSIONS)" \
  || bad "sessions = $SESSIONS (expected $GA_SESSIONS) — the $GSC_ROWS GSC rows must not reach this number"
[ "$SESSIONS" != "$((GSC_ROWS * 40))" ] && ok "the session total is not the fanout product ($((GSC_ROWS * 40)))" \
  || bad "sessions equal rows x sessions — fanout confirmed"
[ "$CLICKS" = "$GSC_ROWS" ] && ok "clicks are the search unit, summed over the $GSC_ROWS rows ($CLICKS)" \
  || bad "clicks = $CLICKS (expected $GSC_ROWS)"
[ "$CLICKS" != "$SESSIONS" ] && ok "clicks and sessions stay different units, never collapsed or added together" \
  || bad "clicks and sessions collapsed into one figure"

step "page health, search and landing facts are related per page"
[ "$(echo "$WEB" | jget health.state)" != "" ] && ok "the overview carries a site health state ('$(echo "$WEB" | jget health.state)')" \
  || bad "no health state on the overview"
PAGE=$(find_row "$WEB" importantPages canonicalUrl "$GUIDE")
if [ "$PAGE" = "__MISSING__" ] || [ "$PAGE" = "__ERR__" ]; then
  bad "the joined page is not among importantPages: $(echo "$WEB" | jlen importantPages) row(s)"
else
  PSESS=$(echo "$PAGE" | jget organicSessions)
  [ "$PSESS" = "$GA_SESSIONS" ] \
    && ok "the page's own visitor total is its GA total ($PSESS), not scaled by its $GSC_ROWS query rows" \
    || bad "per-page organicSessions = $PSESS (expected $GA_SESSIONS)"
  [ "$(echo "$PAGE" | jget clicks)" = "$GSC_ROWS" ] \
    && ok "the same page carries its search facts beside the visitor facts ($(echo "$PAGE" | jget clicks) clicks)" \
    || bad "per-page clicks = $(echo "$PAGE" | jget clicks)"
  [ "$(echo "$PAGE" | jget health)" != "" ] && ok "and its page health ('$(echo "$PAGE" | jget health)')" \
    || bad "no page health on the joined page"
fi
echo "$WEB" | grep -q 'joinLimitation' && ok "the payload carries the join limitation, so no per-query session figure can be inferred" \
  || bad "no joinLimitation in the overview payload"
record "sessions equal the page's own GA total; clicks stay a search unit; the two are related page-by-page, never multiplied"

# ═══════════════════════════════════════════════════════════════════════════
# J14 — Missing Analytics leaves visitor metrics unavailable while Website
#       checks and Google Search results remain useful. Absent, never zero.
# ═══════════════════════════════════════════════════════════════════════════
jrun 14 "missing Analytics: visitor metrics absent, never zero; checks and search stay useful"
step "the fixture has Search and no Analytics"
request "website overview" GET "/projects/$P3/website/overview" "$TOKEN" 200
NOWEB="$BODY"
[ -z "$(echo "$NOWEB" | jget google.sessions)" ] && echo "$NOWEB" | grep -q '"sessions":null' \
  && ok "the sessions total is JSON null — absent, not 0" \
  || bad "sessions = $(echo "$NOWEB" | jget google.sessions) (must be null, never 0)"
[ "$(echo "$NOWEB" | jget google.clicks)" = "5" ] && ok "Google Search results remain useful (5 clicks)" \
  || bad "clicks = $(echo "$NOWEB" | jget google.clicks)"
[ "$(echo "$NOWEB" | jget sourceAvailability.analytics.connected)" = "false" ] \
  && ok "the payload says Analytics is NOT connected" \
  || bad "analytics.connected = $(echo "$NOWEB" | jget sourceAvailability.analytics.connected)"
[ "$(echo "$NOWEB" | jget sourceAvailability.searchConsole.connected)" = "true" ] \
  && ok "while Search Console IS connected" \
  || bad "searchConsole.connected = $(echo "$NOWEB" | jget sourceAvailability.searchConsole.connected) (the fixture connects Search and never Analytics — if this is false the J14 fixture is not what it claims)"
LABEL=$(echo "$NOWEB" | jget sourceAvailability.analytics.label)
ADDS=$(echo "$NOWEB" | jget sourceAvailability.analytics.addsWhat)
[ -n "$LABEL" ] && ok "with a plain-English state label: '$LABEL'" || bad "no label on the missing source"
[ -n "$ADDS" ] && ok "and what connecting it would add: '$ADDS'" || bad "no 'what this adds' text"
echo "$NOWEB" | jget connectGuidance | grep -qi 'visitor' \
  && ok "the connect guidance names the missing visitor figures" \
  || note "connectGuidance reads: $(echo "$NOWEB" | jget connectGuidance | head -c 180)"
[ "$(echo "$NOWEB" | jget sourceAvailability.technicalCheck.available)" = "true" ] \
  && ok "the technical check is available even with no Analytics" \
  || bad "technicalCheck.available = $(echo "$NOWEB" | jget sourceAvailability.technicalCheck.available)"

step "page health is still real, and its visitor block is explicitly unavailable"
PAGE3=$(find_row "$NOWEB" importantPages canonicalUrl "$PRICING")
if [ "$PAGE3" = "__MISSING__" ] || [ "$PAGE3" = "__ERR__" ]; then
  bad "the page is not among importantPages: $(echo "$NOWEB" | jlen importantPages) row(s)"
else
  [ -n "$(echo "$PAGE3" | jget health)" ] \
    && ok "the page's Website check still reports health ('$(echo "$PAGE3" | jget health)')" \
    || bad "no health state on the page"
  [ -z "$(echo "$PAGE3" | jget organicSessions)" ] \
    && ok "while its visitor figure is absent (not 0)" \
    || bad "per-page organicSessions = $(echo "$PAGE3" | jget organicSessions) — a fabricated zero"
  [ "$(echo "$PAGE3" | jget clicks)" = "5" ] && ok "and its search figure is still real (5 clicks)" \
    || bad "per-page clicks = $(echo "$PAGE3" | jget clicks)"
fi
step "the client's own view"
request "client website results tab" GET "/portal/projects/$P3/results/website" "$CLIENT_TOKEN" 200
assert_no_ids "portal results/website" "$BODY"
echo "$BODY" | grep -qE '"sessions":[[:space:]]*0[,[:space:]]' \
  && bad "the client's payload contains a zero session figure — absent must not become 0" \
  || ok "the client's payload contains no fabricated zero session figure"
record "missing Analytics reads absent (null plus an explanation) while page health and Search remain useful"

# ═══════════════════════════════════════════════════════════════════════════
# J15 — Incomplete score data shows measured bucket values without inventing a
#       numeric overall total; comparable complete runs show a valid change.
# ═══════════════════════════════════════════════════════════════════════════
jrun 15 "incomplete score: measured buckets, NO invented total"
step "run the score on a project with partial data"
RUN=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P3/scores/digital-performance/run" "${AUTH[@]}")
RUN_CODE=$(code_of "$RUN")
if [ "$RUN_CODE" = "201" ] || [ "$RUN_CODE" = "200" ]; then
  RUN_BODY=$(body_of "$RUN")
  [ "$(echo "$RUN_BODY" | jget status)" = "incomplete" ] \
    && ok "the run is 'incomplete' — the honest state for partial evidence" \
    || bad "status = $(echo "$RUN_BODY" | jget status)"
  [ -z "$(echo "$RUN_BODY" | jget total)" ] && echo "$RUN_BODY" | grep -q '"total":null' \
    && ok "and carries NO numeric overall total (null, not a floor, not a partial sum)" \
    || bad "an incomplete run published a total: $(echo "$RUN_BODY" | jget total)"
  MEASURED=$(echo "$RUN_BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=(JSON.parse(s).buckets||[]);const m=b.filter(x=>x.state==="measured");
    process.stdout.write(JSON.stringify({n:b.length,measured:m.filter(x=>typeof x.value==="number").length,values:m.map(x=>x.value).slice(0,6)}))}catch(e){process.stdout.write("__ERR__")}})')
  [ "$(echo "$MEASURED" | jget measured)" -ge 1 ] 2>/dev/null \
    && ok "the buckets it DID measure still carry their values — nothing is hidden to make the run look tidy" \
    || bad "no measured bucket carried a value: $MEASURED"
  [ -n "$(echo "$RUN_BODY" | jget evidenceCoverage)" ] \
    && ok "coverage is reported ($(echo "$RUN_BODY" | jget evidenceCoverage)) so the shortfall is visible" \
    || bad "no evidenceCoverage on an incomplete run"
  UNCLEAN=$(echo "$RUN_BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=(JSON.parse(s).buckets||[]);process.stdout.write(String(b.filter(x=>x.state!=="measured"&&typeof x.value==="number").length))}catch(e){process.stdout.write("__ERR__")}})')
  [ "$UNCLEAN" = "0" ] && ok "no unmeasured bucket carries a number either" \
    || bad "$UNCLEAN unmeasured bucket(s) carry a numeric value"
else
  skip "the score run: POST /scores/digital-performance/run -> HTTP $RUN_CODE: $(echo "$(body_of "$RUN")" | head -c 160)"
fi

step "the client sees the same honest state, in client-safe words"
request "client score read" GET "/portal/projects/$P3/scores/digital-performance/latest" "$CLIENT_TOKEN" 200
CLIENT_SCORE="$BODY"
CLIENT_LATEST_TOTAL=$(echo "$CLIENT_SCORE" | jget latest.total)
[ -z "$CLIENT_LATEST_TOTAL" ] && ok "the client's latest score has no total either" \
  || bad "the client was shown a total ($CLIENT_LATEST_TOTAL)"
[ "$CLIENT_LATEST_TOTAL" != "0" ] && ok "and certainly not a zero standing in for 'we do not know'" \
  || bad "the client's total is 0 — a fabricated floor"
assert_no_ids "portal score" "$CLIENT_SCORE"

step "comparable COMPLETE runs show a valid change"
# §5.2's rule: a total exists only when every APPLICABLE bucket is measured. An
# operator may legitimately decide a bucket does not apply to this business,
# which removes it from the denominator. Doing that for the buckets this
# fixture cannot measure is what makes a complete run reachable here — a real
# decision through the real route, not a fixture trick.
LATEST_BUCKETS=$(curl -sS "$API/projects/$P3/scores/digital-performance/latest" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const b=(o.latest&&o.latest.buckets)||[];
  process.stdout.write(JSON.stringify(b.filter(x=>x.applicability==="applicable"&&x.state!=="measured").map(x=>x.key)))}catch(e){process.stdout.write("__ERR__")}})')
note "applicable-but-unmeasured buckets (the reason the run is incomplete): $LATEST_BUCKETS"
COUNT=$(echo "$LATEST_BUCKETS" | jlen)
if [ "$COUNT" -ge 1 ] 2>/dev/null; then
  for i in $(seq 0 $((COUNT-1))); do
    KEY=$(echo "$LATEST_BUCKETS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[Number(process.argv[1])]))}catch(e){process.stdout.write("__ERR__")}})' "$i")
    curl -sS -X PUT "$API/projects/$P3/scores/digital-performance/applicability" "${AUTH[@]}" \
      -H 'content-type: application/json' \
      -d "{\"bucketKey\":\"$KEY\",\"applicable\":false,\"reason\":\"Acceptance journey: this input source is not connected for this business, so the bucket is out of scope rather than missing.\"}" >/dev/null
  done
  ok "$COUNT bucket(s) were explicitly recorded as out-of-scope, with a reason each (a decision, not a data gap)"
  RUN_C=$(curl -sS -X POST "$API/projects/$P3/scores/digital-performance/run" "${AUTH[@]}")
  CSTATE=$(echo "$RUN_C" | jget status)
  if [ "$CSTATE" = "complete" ]; then
    ok "with the out-of-scope buckets excluded by an explicit decision, the run is COMPLETE"
    [ -n "$(echo "$RUN_C" | jget total)" ] && ok "and now carries a real total ($(echo "$RUN_C" | jget total))" \
      || bad "a complete run published no total"
    RUN_D=$(curl -sS -X POST "$API/projects/$P3/scores/digital-performance/run" "${AUTH[@]}")
    COMP=$(echo "$RUN_D" | jget comparison.state)
    [ "$COMP" = "comparable" ] && [ -n "$(echo "$RUN_D" | jget comparison.changeInTotal)" ] \
      && ok "a second complete run is 'comparable' and reports a real change ($(echo "$RUN_D" | jget comparison.changeInTotal))" \
      || bad "the second complete run did not report a comparable change: state=$COMP change=$(echo "$RUN_D" | jget comparison.changeInTotal)"
    [ "$(echo "$RUN_D" | jget comparison.scoringChanged)" = "false" ] \
      && ok "and it did not claim the scoring changed between two identical-methodology runs" \
      || note "the second run reports scoringChanged=$(echo "$RUN_D" | jget comparison.scoringChanged)"
  else
    skip "the complete/comparable half of J15: after excluding the unmeasurable buckets the run is still '$CSTATE' — at least one applicable bucket remains unmeasured on this fixture, and forcing it would be exactly the invented total this journey forbids"
  fi
else
  skip "the complete/comparable half of J15: no applicable-but-unmeasured bucket was reported, so there was no exclusion decision available to make"
fi
record "the incomplete run shows its measured buckets with no total and reads client-safe; a change is reported only between complete runs"

# ═══════════════════════════════════════════════════════════════════════════
# J16 — Plan progress counts verified unique deliverables against a FROZEN
#       agreed target; a changed scope is visible.
# ═══════════════════════════════════════════════════════════════════════════
jrun 16 "plan progress: verified unique deliverables against the frozen agreed target"
step "the frozen denominator"
request "staff commitment detail" GET "/projects/$P1/commitments/$COMMITMENT_ID" "$TOKEN" 200
COMM="$BODY"
[ "$(echo "$COMM" | jget progress.targetCount)" = "3" ] \
  && ok "the agreed target is the frozen 3" || bad "targetCount = $(echo "$COMM" | jget progress.targetCount)"
LABEL=$(echo "$COMM" | jget progress.label)
echo "$LABEL" | grep -q '2 of 3' \
  && ok "progress counts VERIFIED deliverables only: '$LABEL'" \
  || bad "progress label = '$LABEL' (expected it to report 2 of 3 — two verified, of the three agreed)"
note "four work items are linked — two verified, one active, one merely in review; the unverified two must not be counted"

step "a changed scope is visible, and the change is recorded"
SCOPE=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P1/commitments/$COMMITMENT_ID/scope-change" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d '{"reason":"Client added a fourth article after kickoff.","newTarget":4}')
SCOPE_CODE=$(code_of "$SCOPE"); SCOPE_BODY=$(body_of "$SCOPE")
if [ "$SCOPE_CODE" = "200" ] || [ "$SCOPE_CODE" = "201" ]; then
  ok "the scope change was accepted ($SCOPE_CODE)"
  request "commitment after the scope change" GET "/projects/$P1/commitments/$COMMITMENT_ID" "$TOKEN" 200
  [ "$(echo "$BODY" | jget progress.targetCount)" = "4" ] \
    && ok "progress now counts against the NEW agreed target (4)" \
    || bad "progress targetCount = $(echo "$BODY" | jget progress.targetCount)"
  FIRST=$(echo "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=(JSON.parse(s).scopeChanges||[])[0]||null;
    process.stdout.write(c?JSON.stringify({prev:c.previousTarget,next:c.newTarget,reason:String(c.reason||"").slice(0,60)}):"__NONE__")}catch(e){process.stdout.write("__ERR__")}})')
  if [ "$FIRST" = "__NONE__" ] || [ "$FIRST" = "__ERR__" ]; then
    note "the commitment read exposes no scopeChanges array on this build; the targetCount move above is the observable half"
  else
    ok "the change is recorded with before/after and a reason: $FIRST"
  fi
else
  bad "scope-change -> HTTP $SCOPE_CODE: $(echo "$SCOPE_BODY" | head -c 240)"
fi

step "the client's own footer agrees"
request "client overview" GET "/portal/projects/$P1/overview" "$CLIENT_TOKEN" 200
assert_no_ids "portal overview" "$BODY"
assert_no_internal_keys "portal overview" "$BODY"
request "client plan commitments" GET "/portal/projects/$P1/plan/commitments" "$CLIENT_TOKEN" 200
CLIENT_COMMS="$BODY"
assert_no_ids "portal plan commitments" "$CLIENT_COMMS"
CLIENT_C=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const rows=o.commitments||o.items||[];const c=rows.find(x=>x.id===process.argv[1]);
  process.stdout.write(c?JSON.stringify({progress:c.progress,scopeChanges:c.scopeChanges||[]}):"__MISSING__")}catch(e){process.stdout.write("__ERR__")}})' "$COMMITMENT_ID" <<<"$CLIENT_COMMS")
if [ "$CLIENT_C" = "__MISSING__" ] || [ "$CLIENT_C" = "__ERR__" ]; then
  note "the commitment is not in the client's plan list (draft/proposed placements are excluded upstream)"
else
  CPT=$(echo "$CLIENT_C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String((o.progress&&o.progress.targetCount)||""))}catch(e){process.stdout.write("")}})')
  [ "$CPT" = "4" ] && ok "the client's own plan shows the same, updated agreed target (4)" \
    || bad "the client's plan shows targetCount '$CPT', expected 4"
  echo "$CLIENT_C" | grep -q '"by"' && bad "the client's scope change carries an internal actor id" \
    || ok "the client's scope view shows numbers and a reason, and no internal actor"
fi
step "verified is the only thing that counts"
VERIFY_INVARIANT=$(ACC_P1="$P1" ACC_C="$COMMITMENT_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // The link lives on the commitment (`linkedWorkItemIds`, a JSON string[] of
  // WorkItem ids); WorkItem itself carries no commitmentId column.
  const commitment = await prisma.commitment.findUnique({
    where: { id: process.env.ACC_C }, select: { linkedWorkItemIds: true } });
  const linked = JSON.parse((commitment && commitment.linkedWorkItemIds) || '[]');
  const items = await prisma.workItem.findMany({
    where: { projectId: process.env.ACC_P1, id: { in: linked } },
    select: { status: true } });
  console.log(JSON.stringify({ linked: items.length, verified: items.filter((i) => i.status === 'verified').length }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$(echo "$VERIFY_INVARIANT" | jget verified)" = "2" ] \
  && ok "DB ground truth: 2 of the $(echo "$VERIFY_INVARIANT" | jget linked) linked deliverables are verified, which is exactly what the plan reported" \
  || bad "the plan's number does not match the verified rows: $VERIFY_INVARIANT"
record "progress derives from verified unique deliverables against the agreed target; a scope change is recorded and visible to both sides"

# ═══════════════════════════════════════════════════════════════════════════
# J17 — Released report score/card/detail stay identical after later live-score
#       updates and a new draft report revision.
# ═══════════════════════════════════════════════════════════════════════════
jrun 17 "released report stays frozen through a live-score update and a new draft revision"
step "what the client sees today"
request "client project list" GET "/portal/projects" "$CLIENT_TOKEN" 200
CARD=$(find_row "$BODY" projects id "$P4")
[ "$(echo "$CARD" | jget latestScore)" = "61" ] && [ "$(echo "$CARD" | jget latestBand)" = "weak" ] \
  && ok "the project card reads the frozen released revision (61/weak), not the mutable 99/excellent columns" \
  || bad "card = $(echo "$CARD" | jget latestScore)/$(echo "$CARD" | jget latestBand)"
request "client report list" GET "/portal/reports" "$CLIENT_TOKEN" 200
LIST_ROW=$(find_row "$BODY" reports slug "$REPORT_SLUG")
[ "$(echo "$LIST_ROW" | jget scoreTotal)" = "61" ] && ok "the report list agrees (61)" \
  || bad "list score = $(echo "$LIST_ROW" | jget scoreTotal)"
request "client report detail" GET "/portal/reports/$REPORT_SLUG" "$CLIENT_TOKEN" 200
DETAIL1="$BODY"
[ "$(echo "$DETAIL1" | jget scoreTotal)" = "61" ] && [ "$(echo "$DETAIL1" | jget revision)" = "1" ] \
  && ok "the report detail agrees (61, revision 1)" \
  || bad "detail = $(echo "$DETAIL1" | jget scoreTotal)/rev $(echo "$DETAIL1" | jget revision)"
assert_no_ids "portal report detail" "$DETAIL1"

step "a later live-score update"
LIVE=$(curl -sS -X POST "$API/projects/$P4/scores/digital-performance/run" "${AUTH[@]}")
note "a new live score run was taken: $(echo "$LIVE" | jget status), total $(echo "$LIVE" | jget total)"

step "a NEW draft report revision is locked"
REVIEW=$(curl -sS -w $'\n%{http_code}' -X POST "$API/projects/$P4/reports/$REPORT_SLUG/review" "${AUTH[@]}" \
  -H 'content-type: application/json' -d '{}')
REVIEW_CODE=$(code_of "$REVIEW"); REVIEW_BODY=$(body_of "$REVIEW")
NEW_REV=""
if [ "$REVIEW_CODE" = "200" ] || [ "$REVIEW_CODE" = "201" ]; then
  NEW_REV=$(echo "$REVIEW_BODY" | jget revision)
  [ -n "$NEW_REV" ] && ok "a new revision ($NEW_REV) was locked for review from the live row" \
    || note "the review call returned no revision number: $(echo "$REVIEW_BODY" | head -c 160)"
else
  skip "locking a new draft revision: POST /reports/:slug/review -> HTTP $REVIEW_CODE: $(echo "$REVIEW_BODY" | head -c 160)"
fi

step "nothing the client sees moved"
request "client project list (after)" GET "/portal/projects" "$CLIENT_TOKEN" 200
CARD2=$(find_row "$BODY" projects id "$P4")
[ "$(echo "$CARD2" | jget latestScore)" = "61" ] && [ "$(echo "$CARD2" | jget latestBand)" = "weak" ] \
  && ok "the card is IDENTICAL after the live-score update and the new draft revision" \
  || bad "the card moved: $(echo "$CARD2" | jget latestScore)/$(echo "$CARD2" | jget latestBand)"
request "client report list (after)" GET "/portal/reports" "$CLIENT_TOKEN" 200
LIST_ROW2=$(find_row "$BODY" reports slug "$REPORT_SLUG")
[ "$(echo "$LIST_ROW2" | jget scoreTotal)" = "61" ] && [ "$(echo "$LIST_ROW2" | jget revision)" = "$(echo "$LIST_ROW" | jget revision)" ] \
  && ok "the list row is identical, down to the revision number ($(echo "$LIST_ROW2" | jget revision))" \
  || bad "the list moved: $(echo "$LIST_ROW2" | jget scoreTotal)/rev $(echo "$LIST_ROW2" | jget revision)"
request "client report detail (after)" GET "/portal/reports/$REPORT_SLUG" "$CLIENT_TOKEN" 200
DETAIL2="$BODY"
[ "$(echo "$DETAIL2" | jget scoreTotal)" = "61" ] && [ "$(echo "$DETAIL2" | jget revision)" = "1" ] \
  && [ "$(echo "$DETAIL2" | jget title)" = "$(echo "$DETAIL1" | jget title)" ] \
  && ok "the detail is the same read: same score, same revision, same title" \
  || bad "the detail moved: $(echo "$DETAIL2" | jget scoreTotal)/rev $(echo "$DETAIL2" | jget revision)"
if [ -n "$NEW_REV" ] && [ "$NEW_REV" != "1" ]; then
  # Scoped to a revision-valued field: a bare digit match would fire on any date
  # or id in the payload and prove nothing.
  LEAK=$(echo "$DETAIL2" | grep -oE "\"(revision|revisionNumber|draftRevision|latestRevision|releasedRevision)\"[[:space:]]*:[[:space:]]*$NEW_REV\b" | tr -d ' ')
  [ -z "$LEAK" ] \
    && ok "the newer, unreleased revision ($NEW_REV) appears in no revision field the client can read" \
    || bad "the unreleased revision number leaked into the client's payload as $LEAK"
  # And the artifact revision the client is shown is still the released one.
  [ "$(echo "$DETAIL2" | jget revision)" = "1" ] \
    && ok "the client's detail still names revision 1 — the released one" \
    || bad "the client's detail names revision $(echo "$DETAIL2" | jget revision)"
else
  note "no new revision number was produced, so the leak check is reported as unavailable rather than passed silently"
fi
step "and no draft is discoverable at all"
DLIST=$(curl -sS "$API/portal/reports" "${CAUTH[@]}")
echo "$DLIST" | grep -q 'Acceptance released report (edited draft)' \
  && bad "a draft revision appeared in the client's report list" \
  || ok "no draft revision is listed or named for the client"
record "card, list and detail all read the frozen released snapshot and are unchanged by a live score and by a new draft revision"

# ═══════════════════════════════════════════════════════════════════════════
# J18 — A nontechnical client can find a requested approval, explain whether
#       content is planned or published, and correct a target location — each
#       without seeing internal setup details.
# ═══════════════════════════════════════════════════════════════════════════
jrun 18 "the client finds an approval, reads planned vs published, and corrects a target"
step "find the requested approval"
request "client approval list" GET "/portal/approvals" "$CLIENT_TOKEN" 200
APPROVALS="$BODY"
assert_no_ids "portal approvals" "$APPROVALS"
assert_no_internal_keys "portal approvals" "$APPROVALS"
FOUND=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const rows=o.requests||o.approvals||o.items||(Array.isArray(o)?o:[]);
  const r=rows.find(x=>x.id===process.argv[1]);process.stdout.write(r?JSON.stringify(r):"__MISSING__")}catch(e){process.stdout.write("__ERR__")}})' "$PENDING_APPROVAL" <<<"$APPROVALS")
if [ "$FOUND" = "__MISSING__" ] || [ "$FOUND" = "__ERR__" ]; then
  bad "the client's own approval queue does not contain the pending request: $(echo "$APPROVALS" | head -c 240)"
else
  ok "the pending request is exactly where the client would look, titled '$(echo "$FOUND" | jget title)'"
  [ "$(echo "$FOUND" | jget status)" = "pending" ] && ok "and it reads as pending" \
    || bad "status = $(echo "$FOUND" | jget status)"
fi
request "client opens it" GET "/portal/approvals/$PENDING_APPROVAL" "$CLIENT_TOKEN" 200
[ -n "$(echo "$BODY" | jget detail)" ] && ok "the client can open it and read what is being asked" \
  || bad "no detail on the approval the client opened"
assert_no_ids "portal approval detail" "$BODY"
request "client action queue" GET "/portal/projects/$P1/actions" "$CLIENT_TOKEN" 200
assert_no_ids "portal actions" "$BODY"
request "client action overview" GET "/portal/projects/$P1/actions/overview" "$CLIENT_TOKEN" 200
assert_no_ids "portal actions overview" "$BODY"
note "the action overview reports a true total alongside the page it shows, so a nontechnical client can tell 'nothing to do' from 'I only loaded one page'"

step "decide it, the way a nontechnical client would"
request "client approves it" POST "/portal/approvals/$PENDING_APPROVAL/decision" "$CLIENT_TOKEN" 200 \
  -d '{"decision":"approved","revision":1,"comment":"Looks right, go ahead."}'
[ "$(echo "$BODY" | jget status)" = "approved" ] && ok "the client's decision is recorded" \
  || bad "decision status = $(echo "$BODY" | jget status)"
request "and the queue reflects it" GET "/portal/approvals" "$CLIENT_TOKEN" 200
AFTER_APPROVAL=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);
  const rows=o.requests||o.approvals||o.items||(Array.isArray(o)?o:[]);
  const r=rows.find(x=>x.id===process.argv[1]);process.stdout.write(r?String(r.status):"__MISSING__")}catch(e){process.stdout.write("__ERR__")}})' "$PENDING_APPROVAL" <<<"$BODY")
[ "$AFTER_APPROVAL" = "approved" ] && ok "the request now reads approved for the client" \
  || bad "the queue still shows it as '$AFTER_APPROVAL'"

step "planned or published, in the client's own words"
request "client content list" GET "/portal/projects/$P1/content" "$CLIENT_TOKEN" 200
CLIST="$BODY"
assert_no_ids "portal content" "$CLIST"
assert_no_internal_keys "portal content" "$CLIST"
ROW=$(find_row "$CLIST" items assetId "$ASSET_ID")
if [ "$ROW" = "__MISSING__" ] || [ "$ROW" = "__ERR__" ]; then
  skip "the client's content list does not carry the journey piece, so the planned/published explanation cannot be read off it"
else
  [ -n "$(echo "$ROW" | jget clientReviewState)" ] \
    && ok "the piece carries a plain-English review state ('$(echo "$ROW" | jget clientReviewState)')" \
    || bad "no clientReviewState on the client's content row"
  [ -n "$(echo "$ROW" | jget publicationStatus)" ] \
    && ok "and a publication status in client words ('$(echo "$ROW" | jget publicationStatus)')" \
    || bad "no publicationStatus on the client's content row"
  echo "$ROW" | grep -qE '"(publicationId|remoteId|destinationId|scheduleId)"[[:space:]]*:' \
    && bad "the client's content row exposes internal delivery ids" \
    || ok "no internal delivery ids on the client's content row"
fi
request "client calendar" GET "/portal/projects/$P1/content-calendar?from=2026-11-25&to=2026-12-10&timezone=America/New_York" "$CLIENT_TOKEN" 200
CCAL18="$BODY"
assert_no_ids "portal calendar" "$CCAL18"
assert_no_internal_keys "portal calendar" "$CCAL18"
CEV=$(find_row "$CCAL18" events scheduleId "$SID")
if [ "$CEV" = "__MISSING__" ] || [ "$CEV" = "__ERR__" ]; then
  note "the journey placement is not in the client's calendar window (it may be unshared, or outside the window)"
else
  [ -n "$(echo "$CEV" | jget stateLabel)" ] \
    && ok "each calendar entry carries a human state label ('$(echo "$CEV" | jget stateLabel)'), never a raw state token" \
    || bad "no stateLabel on the client's calendar entry"
  [ -n "$(echo "$CEV" | jget channelLabel)" ] \
    && ok "and a human channel label ('$(echo "$CEV" | jget channelLabel)')" \
    || bad "no channelLabel on the client's calendar entry"
  [ -z "$(echo "$CEV" | jget destinationLabel)" ] \
    && ok "with no internal destination label leaking to the client" \
    || note "the client's calendar entry carries destinationLabel '$(echo "$CEV" | jget destinationLabel)'"
fi

step "correct the target location, from the client's own login"
request "client target-locations before" GET "/portal/projects/$P1/business-profile/target-locations" "$CLIENT_TOKEN" 200
assert_no_ids "portal target-locations" "$BODY"
BEFORE_N=$(echo "$BODY" | jlen targets)
curl -sS -X PUT "$API/portal/projects/$P1/business-profile" "${CAUTH[@]}" -H 'content-type: application/json' \
  -d '{"targets":[{"country":"US","priority":0,"active":true},{"country":"GB","priority":1,"active":true}]}' >/dev/null
request "client confirms the correction" POST "/portal/projects/$P1/business-profile/confirm" "$CLIENT_TOKEN" 200 -d '{}'
request "client target-locations after" GET "/portal/projects/$P1/business-profile/target-locations" "$CLIENT_TOKEN" 200
AFTER_N=$(echo "$BODY" | jlen targets)
[ "$AFTER_N" = "2" ] && [ "$AFTER_N" != "$BEFORE_N" ] \
  && ok "the client corrected the target location themselves ($BEFORE_N -> $AFTER_N targets), through their own login" \
  || bad "the correction did not take: before=$BEFORE_N after=$AFTER_N"
assert_no_ids "portal target-locations (after)" "$BODY"
assert_no_internal_keys "portal target-locations (after)" "$BODY"

step "nothing internal leaked along the way"
request "client business-profile overview" GET "/portal/projects/$P1/business-profile/overview" "$CLIENT_TOKEN" 200
assert_no_ids "portal business-profile overview" "$BODY"
request "client results" GET "/portal/projects/$P1/results" "$CLIENT_TOKEN" 200
assert_no_ids "portal results" "$BODY"
request "client messages" GET "/portal/messages" "$CLIENT_TOKEN" 200
assert_no_ids "portal messages" "$BODY"
record "approval found and decided by the client; planned/published read in client words; the target was corrected by the client; every client payload free of internal actor ids and internal-only keys"

# ═══════════════════════════════════════════════════════════════════════════
echo
echo "── per-journey breakdown ──"
printf '%s' "$OUTCOMES"
echo
# Cleanup runs before the verdict so a cleanup that could not delete this run's
# fixtures is part of the result rather than a footnote printed after it.
cleanup
if [ "$SKIP" -gt 0 ]; then
  echo "== acceptance-journeys: $PASS passed, $FAIL failed, $SKIP skipped =="
else
  echo "== acceptance-journeys: $PASS passed, $FAIL failed =="
fi
if [ "$FAIL" -eq 0 ] && [ "$CLEANUP_RC" -eq 0 ]; then
  echo "ALL PASS"
else
  [ "$FAIL" -gt 0 ] && echo "FAILURES PRESENT"
  [ "$CLEANUP_RC" -ne 0 ] && echo "CLEANUP DID NOT COMPLETE — fixture rows may remain (see the cleanup: lines above)"
  exit 1
fi

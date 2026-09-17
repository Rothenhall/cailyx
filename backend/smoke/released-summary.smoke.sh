#!/usr/bin/env bash
# E2E smoke — P01b released-summary consistency (G05).
#
# Contract under test: GET /portal/projects must read the client's project
# card score from the **frozen released ReportRevision snapshot**, never from
# the mutable Report.scoreTotal columns. An operator editing a draft revision
# after release must not change what the client sees on their card.
#
# Seeds the operator, client, project, client login and report revisions
# directly via Prisma (the Day-1 pipeline always runs on POST /clients/:id/
# projects, so HTTP staging would spawn real background jobs), then drives
# the real HTTP surface with a real client-type login. No API keys, no live
# spend. Cleans up on exit.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== released-summary smoke =="

SEED=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const stamp = `relsum-${Date.now()}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-x`;

  // Shared smoke operator (rule 1 in _common.sh: never change its role).
  const passwordHash = await bcryptjs.hash('smoke-cailyx-pw-1234567890', 10);
  await prisma.user.upsert({
    where: { email: 'smoke@cailyx.test' },
    update: {},
    create: { email: 'smoke@cailyx.test', passwordHash, name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });

  const client = await prisma.client.create({ data: { name: `ReleasedSummary ${stamp}` } });
  const project = await prisma.project.create({
    data: { name: `RelSum Project ${stamp}`, domain: `${stamp}.example`, clientId: client.id, onboardingStatus: 'pending' },
  });
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcryptjs.hash(password, 10), name: 'RelSum Client', type: 'client', clientId: client.id },
  });

  const slug = `${stamp}-report`;
  // ReportRevision has no Prisma relation back to Report (plain `reportId`
  // String, no @relation), so nested `revisions.create` is unavailable —
  // create the rows separately.
  // Mutable columns deliberately WRONG (99/"excellent"): if the portal reads
  // these, the assertions below fail. The frozen released revision is truth.
  const report = await prisma.report.create({
    data: {
      projectId: project.id, slug,
      title: 'RelSum seed report', targetUrl: `https://${stamp}.example`,
      executiveSummary: 'Seed report for released-summary smoke.',
      scoreTotal: 99, scoreBand: 'excellent',
      subScores: '[]', findingsSnapshot: '[]', roadmapSnapshot: '[]',
      status: 'released', releasedRevision: 1, releasedAt: new Date(),
    },
  });
  await prisma.reportRevision.createMany({ data: [
          { revision: 1, status: 'released', snapshot: JSON.stringify({
            title: 'RelSum seed report', scoreTotal: 61, scoreBand: 'weak',
            subScores: [], findings: [], roadmap: [], growthPlan: null, backlinks: null,
            presence: null, competitors: null, branding: null,
            contentCreatedAt: new Date().toISOString(), contentUpdatedAt: new Date().toISOString(),
            snapshotAt: new Date().toISOString() }) },
          { revision: 2, status: 'draft', snapshot: JSON.stringify({
            title: 'RelSum seed report (edited draft)', scoreTotal: 42, scoreBand: 'weak',
            subScores: [], findings: [], roadmap: [], growthPlan: null, backlinks: null,
            presence: null, competitors: null, branding: null,
            contentCreatedAt: new Date().toISOString(), contentUpdatedAt: new Date().toISOString(),
            snapshotAt: new Date().toISOString() }) },
        ].map((r) => ({ ...r, reportId: report.id })),
      });

  console.log(JSON.stringify({ clientId: client.id, projectId: project.id, userId: user.id, email, password, slug }));
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
) || die "seed failed" "$SEED"

CID=$(echo "$SEED" | jget clientId)
PID=$(echo "$SEED" | jget projectId)
EMAIL=$(echo "$SEED" | jget email)
PW=$(echo "$SEED" | jget password)
RSLUG=$(echo "$SEED" | jget slug)
[ -n "$CID" ] && [ -n "$PID" ] && ok "seeded client/project/report (rev1 released=61/weak, rev2 draft=42, mutable cols=99)" || die "seed" "$SEED"

# Real client login through the real auth surface.
CAUTH_JSON=$(smoke_login "$EMAIL" "$PW")
CAUTH=(-H "authorization: Bearer $(echo "$CAUTH_JSON" | jget accessToken)")
[ -n "$(echo "$CAUTH_JSON" | jget accessToken)" ] && ok "client portal login works" || die "client login" "$CAUTH_JSON"

# ── The contract ────────────────────────────────────────────────────────────
PROJECTS=$(curl -s "$API/portal/projects" "${CAUTH[@]}")
CARD=$(echo "$PROJECTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).projects.find(x=>x.id===process.argv[1]);process.stdout.write(JSON.stringify(p||{}))})' "$PID")
[ "$(echo "$CARD" | jget latestScore)" = "61" ] && ok "card latestScore = 61 (frozen snapshot, not mutable 99)" || bad "latestScore = $(echo "$CARD" | jget latestScore), expected 61"
[ "$(echo "$CARD" | jget latestBand)" = "weak" ] && ok "card latestBand = weak (frozen snapshot)" || bad "latestBand = $(echo "$CARD" | jget latestBand), expected weak"

# Report list/detail agree with the card (same frozen revision).
REPORTS=$(curl -s "$API/portal/reports" "${CAUTH[@]}")
[ "$(echo "$REPORTS" | jget reports.0.scoreTotal)" = "61" ] && ok "report list score = 61 (card/list agree)" || bad "report list score = $(echo "$REPORTS" | jget reports.0.scoreTotal)"
DETAIL=$(curl -s "$API/portal/reports/$RSLUG" "${CAUTH[@]}")
[ "$(echo "$DETAIL" | jget scoreTotal)" = "61" ] && ok "report detail score = 61" || bad "detail score = $(echo "$DETAIL" | jget scoreTotal)"

# Draft revision must be invisible on every client read path.
echo "$DETAIL" | grep -q 'edited draft' && bad "detail leaked draft revision title" || ok "detail does not leak draft revision"
echo "$REPORTS" | grep -q 'edited draft' && bad "report list leaked draft revision" || ok "report list does not leak draft revision"
echo "$PROJECTS" | grep -q 'excellent' && bad "mutable-column score leaked into projects payload" || ok "projects payload carries no mutable-column value"

# Another client must not see this project at all.
OTHER=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');
const prisma = new PrismaClient();
(async () => {
  const email = `other-${Date.now()}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const client = await prisma.client.create({ data: { name: `Other ${Date.now()}` } });
  await prisma.user.create({
    data: { email, passwordHash: await bcryptjs.hash(password, 10), name: 'Other Client', type: 'client', clientId: client.id },
  });
  console.log(JSON.stringify({ email, password, clientId: client.id }));
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
)
OEMAIL=$(echo "$OTHER" | jget email); OPW=$(echo "$OTHER" | jget password)
OLOGIN=$(smoke_login "$OEMAIL" "$OPW")
OTOKEN=$(echo "$OLOGIN" | jget accessToken)
[ -n "$OTOKEN" ] && [ "$OTOKEN" != "__ERR__" ] && ok "other client login works" || die "other client login" "$OLOGIN"
OAUTH=(-H "authorization: Bearer $OTOKEN")
# Defensive against an error-shaped body: an undefined projects array is a
# failure, not a crash in the assertion itself.
[ "$(curl -s "$API/portal/projects" "${OAUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(Array.isArray(o.projects)&&o.projects.some(x=>x.id===process.argv[1])))})' "$PID")" = "false" ] && ok "other client sees none of this project" || bad "cross-client leak on /portal/projects"
OCID=$(echo "$OTHER" | jget clientId)

# ── Cleanup ─────────────────────────────────────────────────────────────────
cleanup() {
  node - <<EOF >/dev/null 2>&1
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.report.deleteMany({ where: { projectId: { in: ['$PID'] } } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: { in: ['$PID'] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { clientId: { in: ['$CID', '$OCID'] } } }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: ['$CID', '$OCID'] } } }).catch(() => {});
  await prisma.\$disconnect();
})();
EOF
  echo "(smoke rows deleted)"
}
trap cleanup EXIT

echo
echo "released-summary smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

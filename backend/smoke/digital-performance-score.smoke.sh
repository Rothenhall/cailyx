#!/usr/bin/env bash
# E2E smoke — P14 the Cailyx digital-performance score family
# (platform_improvement_plan.md §5.2–§5.5).
#
# The P14 exit gate is "Fixture-calculated scores match exactly; incomplete data
# has no fake total", so every number below is HAND-COMPUTED in the comments and
# asserted with exact equality — never approximately, never "> 0".
#
# Three projects are seeded with an IDENTICAL six-bucket fixture and then
# perturbed one at a time, so each scenario differs from the valid baseline in
# exactly one way:
#
#   P1  fixture A (all six buckets valid)      -> complete, 78, coverage 100
#       then fixture C (social rows removed)   -> incomplete, NO total, coverage 90
#   P2  fixture B (social recorded N/A)        -> complete, 79, coverage 100
#   P3  fixture D (social stale + AI failed)   -> incomplete, NO total, coverage 70
#       then re-run (determinism) / decision   -> "Scoring changed", new segment
#
# Fixture A arithmetic, by hand, from the six bucket formulas:
#   website-health   retrievability 5/5 = 100 ; quality 4/5 (scores 92,85,78,64
#                    clear the 60 floor) = 80        -> mean 90
#   google-visibility  positions 3,9,14,19,26 ; 4 of 5 are <= 20 -> 80
#   ai-visibility    stances primary, alt, alt, neutral, absent
#                    mention 4/5 = 80 ; recommendation 3/5 = 60  -> mean 70
#   online-profiles  2 confirmed of 5 = 40 ; 2 of 2 confirmed carry evidence
#                    (verifiedAt + HTTP 200) = 100               -> mean 70
#   social-activity  linkedin 2/wk agreed, 4 posts in 28d = 1/wk -> 50 (capped
#                    below 100) ; instagram 3/wk agreed, 12 -> 3/wk = 100
#                                                               -> mean 75
#   content-quality  4 of 5 approved briefs covered = 80 ; 3 of the 4 revisions
#                    reach 0.8 x 1000 words (900, 850, 800 met; 700 missed)
#                    = 75      -> mean 77.5 -> half-up 78
#
#   sum(weight x value) = 25*90 + 20*80 + 20*70 + 15*70 + 10*75 + 10*78
#                       = 2250 + 1600 + 1400 + 1050 + 750 + 780 = 7830
#   sum(applicable weights) = 100
#   total = roundHalfUp(7830 / 100) = 78          coverage = 100
#
#   Fixture B: social is NOT APPLICABLE, so it leaves the denominator:
#     7830 - 750 = 7080 over 90  -> roundHalfUp(78.666…) = 79
#   Fixture C: social is merely UNMEASURED, so it KEEPS its full weight:
#     still 7080 points measured, denominator still 100, coverage 90, no total
#   Fixture D: social stale (outdated) and AI refresh broken (failed):
#     measured weight 25+20+15+10 = 70 of 100 -> coverage 70, no total
#
# Every fixture row is created through Prisma and removed by the cleanup trap.
# API="${API:-…}" from _common.sh is honoured, so this can run against a
# private instance without disturbing a shared dev server.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== digital-performance-score smoke =="

# Install cleanup before any write so an early failure still removes fixtures.
SEED='{}'
cleanup() {
  DPS_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.DPS_SEED);
  if (!s.projectIds) return;
  const ids = s.projectIds;
  await prisma.$transaction(async (tx) => {
    // The new family's own rows. Buckets are deleted explicitly as well as by
    // the run cascade, so a partially written fixture cannot leave orphans.
    await tx.scoreBucketRun.deleteMany({ where: { run: { projectId: { in: ids } } } });
    await tx.scoreFamilyRun.deleteMany({ where: { projectId: { in: ids } } });
    await tx.scoreApplicabilityDecision.deleteMany({ where: { projectId: { in: ids } } });
    // Source fixtures.
    await tx.presencePost.deleteMany({ where: { projectId: { in: ids } } });
    await tx.presenceAccount.deleteMany({ where: { projectId: { in: ids } } });
    await tx.presenceDiscovery.deleteMany({ where: { projectId: { in: ids } } });
    const assets = await tx.growthAsset.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
    await tx.contentRevision.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
    await tx.growthAsset.deleteMany({ where: { projectId: { in: ids } } });
    await tx.contentBrief.deleteMany({ where: { projectId: { in: ids } } });
    const audits = await tx.aeoAudit.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
    await tx.aeoStance.deleteMany({ where: { auditId: { in: audits.map((a) => a.id) } } });
    await tx.aeoAudit.deleteMany({ where: { projectId: { in: ids } } });
    await tx.googleDataSnapshot.deleteMany({ where: { projectId: { in: ids } } });
    const techAudits = await tx.technicalAudit.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
    await tx.auditPage.deleteMany({ where: { auditId: { in: techAudits.map((a) => a.id) } } });
    await tx.auditFinding.deleteMany({ where: { auditId: { in: techAudits.map((a) => a.id) } } });
    await tx.technicalAudit.deleteMany({ where: { projectId: { in: ids } } });
    await tx.businessProfile.deleteMany({ where: { projectId: { in: ids } } });
    // The legacy family: this run must still be present and unchanged after the
    // new family has been written, read and compared.
    await tx.scoreRun.deleteMany({ where: { projectId: { in: ids } } });
    await tx.project.deleteMany({ where: { id: { in: ids } } });
    if (s.createdRubric) {
      const left = await tx.scoreRun.count({ where: { rubricVersion: 999001 } });
      if (left === 0) await tx.scoreRubric.deleteMany({ where: { version: 999001 } });
    }
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
const DAY = 86400000;

// The hand-computed fixture inputs. Keep these in step with the header comment.
const PAGE_SCORES = [92, 85, 78, 64, 40];
const QUERY_POSITIONS = [3, 9, 14, 19, 26];
const STANCES = ['recommended-primary', 'recommended-alternative', 'recommended-alternative', 'mentioned-neutral', 'absent'];
const ACCOUNTS = [
  ['linkedin', 'confirmed'],
  ['instagram', 'confirmed'],
  ['facebook', 'unverified'],
  ['twitter', 'unverified'],
  ['youtube', 'unverified'],
];
const REVISION_WORDS = [900, 850, 800, 700];

async function fixture(tx, projectId, tag, stamp, opts) {
  const now = Date.now();

  // 1. website health — 5 sitemap pages, all HTTP 200, one below the score floor
  const auditId = `${stamp}-tech-${tag}`;
  await tx.technicalAudit.create({ data: {
    id: auditId, projectId, targetUrl: `https://${tag}.example.test`, triggeredBy: 'smoke',
    createdAt: new Date(now - DAY), pagesCrawled: PAGE_SCORES.length, score: 72,
  }});
  for (let i = 0; i < PAGE_SCORES.length; i++) {
    await tx.auditPage.create({ data: {
      auditId, url: `https://${tag}.example.test/p${i}`, status: 200, score: PAGE_SCORES[i],
    }});
  }

  // 2. google visibility — 5 stored queries, 4 inside the position-20 target
  await tx.googleDataSnapshot.create({ data: {
    projectId, service: 'search-console', kind: 'page-query-date',
    windowStart: '2026-08-19', windowEnd: '2026-09-15', timezoneNote: 'GSC dates are Pacific',
    rows: JSON.stringify(QUERY_POSITIONS.map((p, i) => ({ query: `${tag}-q${i}`, impressions: 100, position: p }))),
    rowCount: QUERY_POSITIONS.length, complete: true, fetchedAt: new Date(now - DAY),
  }});

  // 3. ai visibility — one completed audit with 5 judged stances
  const completed = await tx.aeoAudit.create({ data: {
    projectId, status: 'completed', surface: 'chatgpt-browser',
    surfaces: JSON.stringify(['chatgpt-browser', 'perplexity-browser']),
    markets: JSON.stringify(['US']), tier: 'standard', runCount: 5,
    promptCount: 5, observations: 5, stanceJudged: 5,
    createdAt: new Date(now - 2 * DAY), finishedAt: new Date(now - 2 * DAY + 300000),
  }});
  for (let i = 0; i < STANCES.length; i++) {
    await tx.aeoStance.create({ data: {
      auditId: completed.id, observationId: `${stamp}-obs-${tag}-${i}`,
      surface: 'chatgpt-browser', dimension: 'brand', stance: STANCES[i], judgeModel: 'smoke-judge',
    }});
  }
  // Fixture D adds a NEWER audit that reports its own failure: the completed
  // sample must not be scored as if it were current.
  if (opts.failAi) {
    await tx.aeoAudit.create({ data: {
      projectId, status: 'failed', surface: 'chatgpt-browser',
      surfaces: JSON.stringify(['chatgpt-browser']), markets: JSON.stringify(['US']),
      error: 'SMOKE_FIXTURE_AI_REFRESH_FAILED',
      startedAt: new Date(now - 3600000), createdAt: new Date(now - 3600000),
    }});
  }

  // 4/5. online profiles + social activity share ONE account inventory: two
  // confirmed channels (linkedin, instagram) and three unverified ones.
  for (const [platform, state] of ACCOUNTS) {
    await tx.presenceAccount.create({ data: {
      projectId, platform, url: `https://${platform}.example.test/${tag}`, source: 'manual',
      entity: 'company', state,
      statusCode: state === 'confirmed' ? 200 : null,
      verifiedAt: state === 'confirmed' ? new Date(now - 3 * DAY) : null,
      reason: state === 'confirmed' ? null : 'Login wall or bot protection returned no readable page',
    }});
  }
  const socialFetchedAt = new Date(now - (opts.socialAgeDays || 1) * DAY);
  for (let i = 0; i < 4; i++) {
    await tx.presencePost.create({ data: {
      projectId, platform: 'linkedin', kind: 'post',
      postedAt: new Date(socialFetchedAt.getTime() - (i + 1) * 2 * DAY),
      likeCount: 10 + i, commentCount: i, shareCount: 0, followerCount: 1200,
      fetchedAt: socialFetchedAt,
    }});
  }
  for (let i = 0; i < 12; i++) {
    await tx.presencePost.create({ data: {
      projectId, platform: 'instagram', kind: 'post',
      postedAt: new Date(socialFetchedAt.getTime() - (i + 1) * 2 * DAY),
      likeCount: 20 + i, commentCount: i, shareCount: 0, followerCount: 3400,
      fetchedAt: socialFetchedAt,
    }});
  }

  // 6. content quality — 5 approved briefs, 4 with content written against them
  const briefIds = [];
  for (let i = 0; i < 5; i++) {
    const brief = await tx.contentBrief.create({ data: {
      projectId, title: `Smoke brief ${i} ${tag}`, assetType: 'article', status: 'approved',
      wordTarget: 1000, language: 'en', approvedBy: 'smoke', approvedAt: new Date(now - 5 * DAY),
    }});
    briefIds.push(brief.id);
  }
  for (let i = 0; i < REVISION_WORDS.length; i++) {
    const asset = await tx.growthAsset.create({ data: {
      projectId, assetType: 'article', title: `Smoke asset ${i} ${tag}`, brief: 'smoke fixture', status: 'in-progress',
    }});
    await tx.contentRevision.create({ data: {
      assetId: asset.id, revision: 1, briefId: briefIds[i], briefVersion: 1,
      wordCount: REVISION_WORDS[i], origin: 'generation',
    }});
  }

  // A CONFIRMED business profile gives every run the same market set. The
  // legacy flat `markets` and the structured `targets` both say US, so the
  // uppercase + de-duplicate path is exercised.
  await tx.businessProfile.create({ data: {
    projectId, version: 1, brandName: `Smoke ${tag}`,
    markets: JSON.stringify(['us']),
    targets: JSON.stringify([{ country: 'us', active: true }]),
    confirmedBy: 'smoke', confirmedAt: new Date(now - 6 * DAY),
  }});
}

(async () => {
  const stamp = `dps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // _common.sh rule 1: upsert with an EMPTY update. Never alter the shared
  // smoke operator's role, password, type, or any other existing field.
  await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });

  const projects = await prisma.$transaction(async (tx) => {
    const out = {};
    const specs = [
      { tag: 'a', opts: {} },
      { tag: 'b', opts: {} },
      { tag: 'c', opts: { socialAgeDays: 60, failAi: true } },
    ];
    for (const spec of specs) {
      const project = await tx.project.create({ data: {
        name: `Digital performance ${spec.tag} ${stamp}`,
        domain: `${stamp}-${spec.tag}.example.test`,
      }});
      await fixture(tx, project.id, spec.tag, stamp, spec.opts);
      out[spec.tag] = project.id;
    }
    return out;
  });

  // A legacy-family score run that the new family must leave completely alone.
  let rubric = await prisma.scoreRubric.findUnique({ where: { version: 999001 } });
  let createdRubric = false;
  if (!rubric) {
    rubric = await prisma.scoreRubric.create({ data: {
      version: 999001, weights: JSON.stringify({ machineAccess: 25, entityClarity: 20, shortlistPresence: 20, extractability: 20, authority: 15 }),
      bands: JSON.stringify([{ max: 39, band: 'weak' }, { max: 100, band: 'strong' }]),
      active: false, note: 'P14 smoke fixture — a legacy rubric the new family must not touch',
    }});
    createdRubric = true;
  }
  const legacy = await prisma.scoreRun.create({ data: {
    projectId: projects.a, rubricVersion: 999001, total: 42, band: 'weak', status: 'complete',
    subScores: JSON.stringify([{ dimension: 'machineAccess', weight: 25, value: 42, contribution: 10.5, evidence: ['smoke'], partial: false }]),
  }});

  console.log(JSON.stringify({
    projectIds: [projects.a, projects.b, projects.c],
    p1: projects.a, p2: projects.b, p3: projects.c,
    legacyRunId: legacy.id, createdRubric,
  }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

P1=$(echo "$SEED" | jget p1)
P2=$(echo "$SEED" | jget p2)
P3=$(echo "$SEED" | jget p3)
LEGACY_ID=$(echo "$SEED" | jget legacyRunId)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ "$P1" != "__ERR__" ] && ok "seeded three projects with an identical six-bucket fixture plus one legacy ScoreRun" || die "seed" "$SEED"

request() {
  local label="$1" method="$2" path="$3" token="$4" expected="$5" response attempt=0
  shift 5
  # Building a run is an explicit, throttled action (10 per minute). A second
  # back-to-back run of this suite can land inside the previous run's window, so
  # a 429 is waited out rather than reported as a wrong answer: it is a rate
  # limit, not a disagreement about the score.
  while :; do
    response=$(curl -sS -w $'\n%{http_code}' -X "$method" "$API$path" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' "$@") || die "$label transport failed" "$response"
    HTTP_CODE="${response##*$'\n'}"
    BODY="${response%$'\n'*}"
    if [ "$HTTP_CODE" = "429" ] && [ "$expected" != "429" ] && [ "$attempt" -lt 2 ]; then
      attempt=$((attempt+1))
      echo "  ....  $label rate limited; waiting 61s for the throttle window (retry $attempt)"
      sleep 61
      continue
    fi
    break
  done
  [ "$HTTP_CODE" = "$expected" ] && ok "$label HTTP $expected" || bad "$label HTTP $HTTP_CODE (expected $expected): $BODY"
}
login() {
  # `smoke_login` retries through the /auth/login rate limit. A suite signs in
  # several accounts in quick succession, so one 429 here used to abort the
  # whole run at "client login" — a failure that says nothing about the module
  # under test.
  smoke_login "$1" "$2"
}
# One bucket's field, from a run payload — "bget <json> <bucketKey> <dotted.path>".
# Prints "" for null, __ERR__ on bad JSON.
bget() {
  echo "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const b=(o.buckets||[]).find(x=>x.key===process.argv[1]);let p=b;for(const k of process.argv.slice(2).join(".").split("."))p=p==null?undefined:p[k];process.stdout.write(p==null?"":String(p))}catch(e){process.stdout.write("__ERR__")}})' "$2" "${@:3}"
}
# Every bucket value in one line, in canonical order, for an exact comparison.
bvalues() {
  echo "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const order=o.bucketOrder||[];process.stdout.write(order.map(k=>{const b=(o.buckets||[]).find(x=>x.key===k);return k+"="+(b&&b.value!=null?b.value:(b?b.state:"missing"))}).join(" "))}catch(e){process.stdout.write("__ERR__")}})'
}
run_count() {
  DPS_PROJECT="$1" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.scoreFamilyRun.count({where:{projectId:process.env.DPS_PROJECT,family:"digital-performance"}}).then(n=>process.stdout.write(String(n))).catch(()=>process.stdout.write("__ERR__")).finally(()=>p.$disconnect())'
}

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "$TOKEN"

# ── §5.7: a READ is a read. No GET may build a score, start an audit or create
# a job. P3 has fixtures but no run yet — reading it must leave it run-less.
request "P3 latest before any run" GET "/projects/$P3/scores/digital-performance/latest" "$TOKEN" 200
[ -z "$(echo "$BODY" | jget latest)" ] && [ -z "$(echo "$BODY" | jget lastComplete)" ] && ok "a project with no run reports no latest and no last-complete run" || bad "empty-project latest payload"
[ "$(run_count "$P3")" = "0" ] && ok "GET /latest created no run (§5.7: loading never builds a score)" || bad "GET /latest wrote a run"
request "P3 trend before any run" GET "/projects/$P3/scores/digital-performance/trend" "$TOKEN" 200
[ "$(echo "$BODY" | jlen segments)" = "0" ] && [ "$(run_count "$P3")" = "0" ] && ok "GET /trend created no run and reports no segments" || bad "GET /trend wrote a run"
request "score-methodologies list" GET "/score-methodologies" "$TOKEN" 200
echo "$BODY" | grep -q '"family":"digital-performance"' && ok "the digital-performance methodology is registered" || bad "methodology list missing the family"
request "unknown project run" POST "/projects/does-not-exist-p14/scores/digital-performance/run" "$TOKEN" 404

# ── Fixture A on P1: every applicable bucket measured -> an exact total.
request "P1 run (fixture A, all valid)" POST "/projects/$P1/scores/digital-performance/run" "$TOKEN" 201
RUN_A="$BODY"
RUN_A_ID=$(echo "$RUN_A" | jget id)
[ -n "$RUN_A_ID" ] && ok "run carries an id" || die "run id" "$RUN_A"
[ "$(echo "$RUN_A" | jget status)" = "complete" ] && ok "all six buckets valid -> status complete" || bad "status is $(echo "$RUN_A" | jget status)"
[ "$(echo "$RUN_A" | jget total)" = "78" ] && ok "hand-computed total is exactly 78" || bad "total is $(echo "$RUN_A" | jget total) (expected 78)"
[ "$(echo "$RUN_A" | jget weightedPointsTotal)" = "7830" ] && ok "weighted points total is exactly 7830 (2250+1600+1400+1050+750+780)" || bad "weightedPointsTotal is $(echo "$RUN_A" | jget weightedPointsTotal) (expected 7830)"
[ "$(echo "$RUN_A" | jget applicableWeightTotal)" = "100" ] && ok "applicable weight total is 100" || bad "applicableWeightTotal is $(echo "$RUN_A" | jget applicableWeightTotal)"
[ "$(echo "$RUN_A" | jget evidenceCoverage)" = "100" ] && ok "evidence coverage is 100 when every bucket is measured" || bad "evidenceCoverage is $(echo "$RUN_A" | jget evidenceCoverage)"

# Each bucket value, hand-computed from its own formula.
for pair in "website-health=90" "google-visibility=80" "ai-visibility=70" "online-profiles=70" "social-activity=75" "content-quality=78"; do
  key="${pair%%=*}"; want="${pair##*=}"
  got=$(bget "$RUN_A" "$key" value)
  [ "$got" = "$want" ] && ok "bucket $key is exactly $want" || bad "bucket $key is $got (expected $want)"
  [ "$(bget "$RUN_A" "$key" state)" = "measured" ] || bad "bucket $key state is $(bget "$RUN_A" "$key" state), expected measured"
done
ok "all six buckets report state measured"

# The per-bucket weighted points, so the sum above is not taken on trust.
for pair in "website-health=2250" "google-visibility=1600" "ai-visibility=1400" "online-profiles=1050" "social-activity=750" "content-quality=780"; do
  key="${pair%%=*}"; want="${pair##*=}"
  got=$(bget "$RUN_A" "$key" weightedPoints)
  [ "$got" = "$want" ] && ok "bucket $key contributes exactly $want weighted points" || bad "bucket $key weightedPoints is $got (expected $want)"
done
[ "$(echo "$RUN_A" | jlen buckets)" = "6" ] && [ "$(echo "$RUN_A" | jlen bucketOrder)" = "6" ] && ok "the payload carries all six buckets, nothing dropped" || bad "bucket count"

# 77.5 must round half-up to 78 — the only place a .5 occurs, and it is the
# bucket mean, not an intermediate contribution.
[ "$(bget "$RUN_A" content-quality metricInputs.1 value)" = "75" ] && [ "$(bget "$RUN_A" content-quality metricInputs.1 numerator)" = "3" ] && [ "$(bget "$RUN_A" content-quality metricInputs.1 denominator)" = "4" ] && ok "content-quality half-up: 3/4 = 75, bucket mean 77.5 rounds to 78" || bad "content-quality submetric arithmetic"

# §5.4: a bucket carries its formula, thresholds, sources, source ages, window,
# methodology version and a client-safe detail destination with the period.
[ "$(bget "$RUN_A" website-health metricVersion)" = "website-health/1" ] && [ "$(bget "$RUN_A" website-health maxAgeDays)" = "30" ] && [ "$(bget "$RUN_A" website-health minSample)" = "3" ] && ok "bucket carries its metric version, maximum age and minimum sample" || bad "bucket metric metadata"
echo "$RUN_A" | grep -q '"ageDays":1' && ok "bucket source references carry a computed source age" || bad "source ages missing"
[ "$(bget "$RUN_A" google-visibility detail.path)" = "/results/website" ] && [ "$(bget "$RUN_A" google-visibility detail.query)" = "tab=google" ] && [ "$(bget "$RUN_A" google-visibility detail.period.start)" = "2026-08-19T00:00:00.000Z" ] && [ "$(bget "$RUN_A" google-visibility detail.period.end)" = "2026-09-15T00:00:00.000Z" ] && ok "bucket detail destination carries path, query and the measured period" || bad "bucket detail destination"
[ "$(bget "$RUN_A" social-activity thresholds.channelPostsPerWeek.linkedin)" = "2" ] && ok "the agreed per-channel cadence is stored on the bucket from the methodology version" || bad "channel cadence thresholds"
echo "$RUN_A" | grep -q 'scope' && [ "$(echo "$RUN_A" | jget scope.marketSet.0)" = "US" ] && ok "the run records the confirmed market set it was measured against" || bad "run scope market set"
[ "$(echo "$RUN_A" | jget comparison.state)" = "new-segment" ] && [ "$(echo "$RUN_A" | jget comparison.segmentIndex)" = "1" ] && ok "the first run opens a new comparison segment" || bad "first-run comparison state"

# §5.3 rule 6: coverage is returned AS coverage, never as confidence.
echo "$RUN_A" | grep -q 'not statistical confidence' && echo "$RUN_A" | grep -q 'not business performance' && ok "coverage is labelled as coverage, not statistical confidence or performance" || bad "coverage meaning is missing its disclaimer"

# §5.7 again: reading the run must not write another one.
BEFORE=$(run_count "$P1")
request "P1 run by id" GET "/projects/$P1/scores/$RUN_A_ID" "$TOKEN" 200
[ "$(echo "$BODY" | jget total)" = "78" ] && ok "a stored run reads back with the same total" || bad "run read-back total"
request "another project's run id" GET "/projects/$P2/scores/$RUN_A_ID" "$TOKEN" 404
[ "$(run_count "$P1")" = "$BEFORE" ] && ok "reading a run created no new run" || bad "a GET wrote a run"

request "P1 latest after the complete run" GET "/projects/$P1/scores/digital-performance/latest" "$TOKEN" 200
LATEST_A="$BODY"
[ "$(echo "$LATEST_A" | jget latest.id)" = "$RUN_A_ID" ] && [ "$(echo "$LATEST_A" | jget latest.total)" = "78" ] && ok "latest run is the complete one with total 78" || bad "latest run payload"
[ "$(echo "$LATEST_A" | jget lastComplete.id)" = "$RUN_A_ID" ] && [ "$(echo "$LATEST_A" | jget lastCompleteIsLatest)" = "true" ] && ok "last complete run is flagged as the latest, so it is not shown twice" || bad "lastComplete flags"
[ "$(echo "$LATEST_A" | jget methodology.weightsApproved)" = "false" ] && [ -n "$(echo "$LATEST_A" | jget methodology.approvalNote)" ] && ok "the read model states the bucket weights are NOT approved (plan §22 D01)" || bad "weights approval flag"
[ "$(echo "$LATEST_A" | jget methodology.version)" = "1" ] && ok "the active methodology version is reported with every read" || bad "methodology version"

# ── Fixture C on P1: one applicable bucket unmeasured -> incomplete, NO total.
DPS_PROJECT="$P1" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.presencePost.deleteMany({where:{projectId:process.env.DPS_PROJECT}}).then(r=>console.log("removed "+r.count+" social rows")).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect())' >/dev/null \
  && ok "removed every social-activity row, leaving the bucket unmeasured" || bad "could not remove the social rows"
request "P1 run (fixture C, social unmeasured)" POST "/projects/$P1/scores/digital-performance/run" "$TOKEN" 201
RUN_C="$BODY"
[ "$(echo "$RUN_C" | jget status)" = "incomplete" ] && ok "one applicable bucket unmeasured -> status incomplete" || bad "status is $(echo "$RUN_C" | jget status)"
[ -z "$(echo "$RUN_C" | jget total)" ] && echo "$RUN_C" | grep -q '"total":null' && ok "an incomplete run has NO numeric total — not a 0, not a partial sum" || bad "incomplete run published a total"
[ -z "$(echo "$RUN_C" | jget weightedPointsTotal)" ] && ok "the partial weighted-points sum is withheld too" || bad "weightedPointsTotal leaked a partial sum"
[ "$(echo "$RUN_C" | jget evidenceCoverage)" = "90" ] && ok "coverage drops to exactly 90 while measuring 90 of 100 applicable weight" || bad "coverage is $(echo "$RUN_C" | jget evidenceCoverage) (expected 90)"
[ "$(bget "$RUN_C" social-activity state)" = "not-measured" ] && [ -z "$(bget "$RUN_C" social-activity value)" ] && ok "the unmeasured bucket reports state not-measured with no value" || bad "social bucket state"
[ "$(bget "$RUN_C" social-activity effectiveWeight)" = "10" ] && [ "$(echo "$RUN_C" | jget applicableWeightTotal)" = "100" ] && ok "an UNMEASURED bucket keeps its full effective weight — it is not silently treated as not-applicable" || bad "unmeasured bucket redistributed weight"
[ "$(bget "$RUN_C" social-activity missingReasons.0)" != "" ] && ok "the unmeasured bucket states why it could not be measured" || bad "missing reason absent"
# The valid buckets still show their values beside the absent one.
for pair in "website-health=90" "google-visibility=80" "ai-visibility=70" "online-profiles=70" "content-quality=78"; do
  key="${pair%%=*}"; want="${pair##*=}"
  got=$(bget "$RUN_C" "$key" value)
  [ "$got" = "$want" ] && ok "incomplete run still shows $key = $want" || bad "incomplete run lost $key (got $got, expected $want)"
done
[ "$(echo "$RUN_C" | jget comparison.state)" = "comparable" ] && [ -z "$(echo "$RUN_C" | jget comparison.changeInTotal)" ] && [ -n "$(echo "$RUN_C" | jget comparison.changeUnavailableReason)" ] && ok "no change is shown against a complete run: one of the two has no total to subtract" || bad "comparison against an incomplete run"

# §5.3 rule 7: the old complete score stays visible, separately, unblended.
request "P1 latest after the incomplete run" GET "/projects/$P1/scores/digital-performance/latest" "$TOKEN" 200
LATEST_C="$BODY"
[ "$(echo "$LATEST_C" | jget latest.status)" = "incomplete" ] && [ -z "$(echo "$LATEST_C" | jget latest.total)" ] && ok "latest is the incomplete run and carries no total" || bad "latest after incomplete run"
[ "$(echo "$LATEST_C" | jget lastComplete.id)" = "$RUN_A_ID" ] && [ "$(echo "$LATEST_C" | jget lastComplete.total)" = "78" ] && ok "the earlier complete score is still shown as last complete, total 78" || bad "lastComplete payload"
[ "$(echo "$LATEST_C" | jget latest.id)" != "$(echo "$LATEST_C" | jget lastComplete.id)" ] && [ "$(echo "$LATEST_C" | jget lastCompleteIsLatest)" = "false" ] && ok "latest and last-complete are distinct runs, so their numbers can never be blended" || bad "latest/lastComplete collapsed"
[ -n "$(echo "$LATEST_C" | jget note)" ] && ok "the read model says plainly that the latest run has no total" || bad "no note on an incomplete latest"

# ── Fixture B on P2: an explicit not-applicable decision redistributes weight.
request "P2 N/A without a reason" PUT "/projects/$P2/scores/digital-performance/applicability" "$TOKEN" 400 \
  -d '{"bucketKey":"social-activity","applicable":false}'
request "P2 N/A on an unknown bucket" PUT "/projects/$P2/scores/digital-performance/applicability" "$TOKEN" 400 \
  -d '{"bucketKey":"not-a-bucket","applicable":false,"reason":"This bucket does not exist in the methodology"}'
request "P2 N/A with a reason" PUT "/projects/$P2/scores/digital-performance/applicability" "$TOKEN" 200 \
  -d '{"bucketKey":"social-activity","applicable":false,"reason":"Operator confirmed the client runs no social channels; social cadence is outside the agreed scope."}'
request "P2 applicability read-back" GET "/projects/$P2/scores/digital-performance/applicability" "$TOKEN" 200
echo "$BODY" | grep -q '"key":"social-activity","label":"Social activity","weight":10,"applicability":"not-applicable"' && ok "the not-applicable decision is recorded against the bucket" || bad "applicability read-back"
echo "$BODY" | grep -q 'outside the agreed scope' && ok "the decision keeps its reason, not just its verdict" || bad "applicability reason lost"
request "P2 run (fixture B, social not applicable)" POST "/projects/$P2/scores/digital-performance/run" "$TOKEN" 201
RUN_B="$BODY"
[ "$(echo "$RUN_B" | jget status)" = "complete" ] && ok "a not-applicable bucket leaves five applicable buckets, all measured -> complete" || bad "fixture B status"
[ "$(echo "$RUN_B" | jget total)" = "79" ] && ok "hand-computed redistributed total is exactly 79" || bad "total is $(echo "$RUN_B" | jget total) (expected 79)"
[ "$(echo "$RUN_B" | jget weightedPointsTotal)" = "7080" ] && [ "$(echo "$RUN_B" | jget applicableWeightTotal)" = "90" ] && ok "7830 minus the 750 social points, over 90 applicable weight" || bad "fixture B arithmetic"
[ "$(echo "$RUN_B" | jget evidenceCoverage)" = "100" ] && ok "coverage is 100 of the APPLICABLE weight, not of all six buckets" || bad "fixture B coverage"
[ "$(bget "$RUN_B" social-activity state)" = "not-applicable" ] && [ -z "$(bget "$RUN_B" social-activity value)" ] && [ "$(bget "$RUN_B" social-activity effectiveWeight)" = "0" ] && ok "the not-applicable bucket is a recorded state with zero effective weight, not a zero score" || bad "fixture B social bucket"
[ "$(bget "$RUN_B" social-activity weightedPoints)" = "0" ] && [ -n "$(bget "$RUN_B" social-activity applicabilityReason)" ] && ok "the exclusion carries its reason into the run itself" || bad "fixture B exclusion reason"
for pair in "website-health=90" "google-visibility=80" "ai-visibility=70" "online-profiles=70" "content-quality=78"; do
  key="${pair%%=*}"; want="${pair##*=}"
  got=$(bget "$RUN_B" "$key" value)
  [ "$got" = "$want" ] && ok "excluding social did not disturb $key = $want" || bad "fixture B changed $key (got $got)"
done

# ── Fixture D on P3: a stale source and a broken refresh are distinct states.
request "P3 run (fixture D, stale social + failed AI)" POST "/projects/$P3/scores/digital-performance/run" "$TOKEN" 201
RUN_D="$BODY"
RUN_D_ID=$(echo "$RUN_D" | jget id)
[ "$(echo "$RUN_D" | jget status)" = "incomplete" ] && [ -z "$(echo "$RUN_D" | jget total)" ] && ok "a stale bucket and a failed bucket both leave the run incomplete with no total" || bad "fixture D status/total"
[ "$(echo "$RUN_D" | jget evidenceCoverage)" = "70" ] && ok "coverage is exactly 70: only 70 of 100 applicable weight was measured" || bad "fixture D coverage is $(echo "$RUN_D" | jget evidenceCoverage)"
[ "$(bget "$RUN_D" social-activity state)" = "outdated" ] && [ -z "$(bget "$RUN_D" social-activity value)" ] && [ "$(bget "$RUN_D" social-activity effectiveWeight)" = "10" ] && ok "the 60-day-old social data is OUTDATED, not scored and not zeroed" || bad "fixture D social state"
[ "$(bget "$RUN_D" ai-visibility state)" = "failed" ] && [ -z "$(bget "$RUN_D" ai-visibility value)" ] && [ "$(bget "$RUN_D" ai-visibility effectiveWeight)" = "20" ] && ok "the broken AI refresh is FAILED rather than scored from the older sample" || bad "fixture D ai state"
[ "$(bget "$RUN_D" social-activity state)" != "$(bget "$RUN_D" ai-visibility state)" ] && ok "outdated and failed render as two distinct states in the same run" || bad "bucket states collapsed"
echo "$RUN_D" | grep -q 'days old, past the 30-day maximum age' && ok "the outdated bucket says how old the source is and what the limit was" || bad "outdated reason missing"
echo "$RUN_D" | grep -q 'reported failure' && ok "the failed bucket reports the source's own failure" || bad "failed reason missing"
for pair in "website-health=90" "google-visibility=80" "online-profiles=70" "content-quality=78"; do
  key="${pair%%=*}"; want="${pair##*=}"
  got=$(bget "$RUN_D" "$key" value)
  [ "$got" = "$want" ] && ok "the four healthy buckets still show $key = $want beside the two absent ones" || bad "fixture D lost $key (got $got)"
done

# ── Boundary: the same inputs twice must give the same answer, and the first
# run must be byte-identical afterwards (runs are immutable).
request "P3 run again (same inputs)" POST "/projects/$P3/scores/digital-performance/run" "$TOKEN" 201
RUN_D2="$BODY"
[ "$(echo "$RUN_D2" | jget status)" = "incomplete" ] && [ -z "$(echo "$RUN_D2" | jget total)" ] && [ "$(echo "$RUN_D2" | jget evidenceCoverage)" = "70" ] && ok "re-running identical fixtures reproduces the same verdict and coverage exactly" || bad "re-run is not deterministic"
[ "$(bvalues "$RUN_D2")" = "$(bvalues "$RUN_D")" ] && ok "re-running reproduces every bucket value and state exactly: $(bvalues "$RUN_D")" || bad "bucket values differ on re-run: $(bvalues "$RUN_D2")"
[ "$(echo "$RUN_D2" | jget comparison.state)" = "comparable" ] && [ "$(echo "$RUN_D2" | jget comparison.segmentIndex)" = "$(echo "$RUN_D" | jget comparison.segmentIndex)" ] && ok "nothing changed, so the run stays in the same comparison segment" || bad "comparison segment drift"
[ -z "$(echo "$RUN_D2" | jget comparison.changeInTotal)" ] && ok "two incomplete runs report no change — there is no total to subtract" || bad "delta published between two incomplete runs"
request "P3 first run re-read" GET "/projects/$P3/scores/$RUN_D_ID" "$TOKEN" 200
[ "$(echo "$BODY" | jget fingerprint)" = "$(echo "$RUN_D" | jget fingerprint)" ] && [ "$(echo "$BODY" | jget status)" = "incomplete" ] && [ -z "$(echo "$BODY" | jget total)" ] && ok "the earlier run is unchanged after a newer one was written: runs are immutable" || bad "an earlier run was rewritten"
request "P3 trend inside one segment" GET "/projects/$P3/scores/digital-performance/trend" "$TOKEN" 200
[ "$(echo "$BODY" | jlen segments)" = "1" ] && [ "$(echo "$BODY" | jlen segments.0.runs)" = "2" ] && ok "comparable runs group into one segment" || bad "trend segment grouping"

# ── §5.5: an applicability change starts a NEW segment — "Scoring changed".
request "P3 N/A decision changes the segment" PUT "/projects/$P3/scores/digital-performance/applicability" "$TOKEN" 200 \
  -d '{"bucketKey":"social-activity","applicable":false,"reason":"The operator confirmed this client has no social channels in scope."}'
request "P3 run after the decision" POST "/projects/$P3/scores/digital-performance/run" "$TOKEN" 201
RUN_D3="$BODY"
[ "$(echo "$RUN_D3" | jget comparison.state)" = "scoring-changed" ] && [ "$(echo "$RUN_D3" | jget comparison.scoringChanged)" = "true" ] && ok "a changed applicability decision reports \"Scoring changed\"" || bad "scoring-changed not reported"
[ "$(echo "$RUN_D3" | jget comparison.segmentIndex)" -gt "$(echo "$RUN_D" | jget comparison.segmentIndex)" ] && ok "the comparison segment index advanced, so old and new scores cannot be averaged" || bad "segment index did not advance"
[ -z "$(echo "$RUN_D3" | jget comparison.changeInTotal)" ] && [ -n "$(echo "$RUN_D3" | jget comparison.changeUnavailableReason)" ] && ok "no delta is published across a segment boundary" || bad "delta published across a segment boundary"
[ "$(echo "$RUN_D3" | jget applicableWeightTotal)" = "90" ] && [ "$(echo "$RUN_D3" | jget evidenceCoverage)" = "78" ] && ok "weight redistribution moved the denominator to 90 and coverage to 70/90 = 78" || bad "post-decision arithmetic (coverage $(echo "$RUN_D3" | jget evidenceCoverage))"
[ "$(bget "$RUN_D3" ai-visibility state)" = "failed" ] && [ -z "$(echo "$RUN_D3" | jget total)" ] && ok "the run is still incomplete and still has no total" || bad "post-decision run published a total"
request "P3 trend across two segments" GET "/projects/$P3/scores/digital-performance/trend" "$TOKEN" 200
TREND="$BODY"
[ "$(echo "$TREND" | jlen segments)" = "2" ] && [ -n "$(echo "$TREND" | jget segments.1.scoringChangedAt)" ] && ok "the trend splits into two segments and marks when scoring changed" || bad "trend segments are $(echo "$TREND" | jlen segments)"
[ "$(echo "$TREND" | jlen changes)" = "1" ] && [ "$(echo "$TREND" | jget changes.0.comparable)" = "false" ] && [ -z "$(echo "$TREND" | jget changes.0.delta)" ] && ok "changes are offered only inside a segment, and a change with no total on both sides is withheld" || bad "trend change list"
echo "$TREND" | grep -q 'never averaged across segments' && ok "the trend states that scores are never averaged across segments" || bad "trend note missing"

# ── Preservation: the new family must not have touched the legacy one.
LEGACY_CHECK=$(DPS_LEGACY="$LEGACY_ID" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.scoreRun.findUnique({where:{id:process.env.DPS_LEGACY}}).then(r=>{if(!r){process.stdout.write("__MISSING__");return}process.stdout.write([r.total,r.band,r.status,r.rubricVersion,r.subScores].join(" "))}).catch(()=>process.stdout.write("__ERR__")).finally(()=>p.$disconnect())')
echo "$LEGACY_CHECK" | grep -q '^42 weak complete 999001 ' && ok "the legacy ScoreRun is untouched by the new family's runs" || bad "legacy ScoreRun changed: $LEGACY_CHECK"
LEGACY_RUBRICS=$(node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.scoreRubric.count({where:{version:999001}}).then(n=>process.stdout.write(String(n))).catch(()=>process.stdout.write("__ERR__")).finally(()=>p.$disconnect())')
[ "$LEGACY_RUBRICS" = "1" ] && ok "the legacy ScoreRubric version still exists, unrewritten" || bad "legacy rubric count is $LEGACY_RUBRICS"
FAMILY_RUNS=$(run_count "$P1")
[ "$FAMILY_RUNS" = "2" ] && ok "P1 holds exactly the two new-family runs, in its own table" || bad "P1 family run count is $FAMILY_RUNS"

echo
echo "digital-performance-score smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

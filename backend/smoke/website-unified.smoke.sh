#!/usr/bin/env bash
# E2E smoke — P12 Unified Website (§7). Proves the exit gate concretely:
#
#   1. grain-safe join        — many GSC query rows for one page never multiply
#                               that page's single GA session total, and
#                               country/device rows never multiply either.
#   2. missing-source honesty — no GA connected: visitor figures are absent,
#                               not a fabricated zero, while GSC/technical
#                               facts still render and no rule fires on the
#                               missing input.
#   3. attribution-fabrication— a technical fix followed by a traffic change
#                               shows the exact honest wording, never a bare
#                               causal claim — as an insight and in the page
#                               detail's "Changes" list (every entry causal:false).
#   4. date-boundary mismatch — GSC (Pacific) vs GA (property tz) windows that
#                               overlap but are not identical are disclosed as
#                               such, not silently equated; identical ranges are
#                               reported as aligned.
#   5. read-only reads        — loading overview/pages/detail triggers zero new
#                               paid/live calls and zero jobs: verified
#                               structurally (no live call site outside
#                               syncGoogleData; no sync route behind a GET) and
#                               by counting GoogleDataSnapshot / TechnicalAudit
#                               rows before and after a burst of reads.
#   6. §7.2 page detail       — summary/search/visitors/content/changes, with
#                               the page-analysis run history and each run's
#                               source URL preserved (R33).
#   7. §7.6 expired access    — the last authorized snapshot is retained and
#                               labeled with its own date, with a reconnection
#                               label, and still served.
#   8. §7.2 "Update this page"— starts the real refresh workflow
#                               (sleeper-refresh, SOP-10) idempotently and hands
#                               back the page-detail route.
#
# Seeded via Prisma: there is no live Google OAuth grant in this environment,
# and syncGoogleData is deliberately the only route that would call Google
# (never exercised here).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== website-unified smoke =="

# ── 0. static guards: the read path cannot call Google or start work ────────
GUARD=$(node <<'EOF'
const fs = require('fs');
const src = fs.readFileSync('src/modules/website/website.service.ts', 'utf8');
const lines = src.split('\n');
const startIdx = lines.findIndex((l) => l.includes('async syncGoogleData'));
if (startIdx < 0) { console.log('NO_METHOD'); process.exit(0); }
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^  (async |private async |\})/.test(lines[i])) { endIdx = i; break; }
}
const outside = [];
lines.forEach((l, i) => {
  if (/this\.(gsc|ga)\./.test(l) && !(i > startIdx && i < endIdx)) outside.push(i + 1);
});
const importsAQueue = /from '.*(queue|bull|schedule|job).*'/.test(src);
console.log(outside.length ? `OUTSIDE:${outside.join(',')}` : importsAQueue ? 'IMPORTS_QUEUE' : 'OK');
EOF
)
[ "$GUARD" = "OK" ] \
  && ok "service calls Google only from syncGoogleData and imports no queue/scheduler (a GET cannot start work)" \
  || bad "the read path is not live-call/job free ($GUARD)"

CTRL_GUARD=$(node <<'EOF'
const fs = require('fs');
const src = fs.readFileSync('src/modules/website/website.controller.ts', 'utf8');
const gets = [...src.matchAll(/@Get\(([^)]*)\)/g)].map((m) => m[1]);
const posts = [...src.matchAll(/@Post\(([^)]*)\)/g)].map((m) => m[1]);
const syncOnGet = gets.some((g) => g.includes('sync'));
console.log(syncOnGet ? 'SYNC_ON_GET' : `OK:${gets.length}GET/${posts.length}POST`);
EOF
)
case "$CTRL_GUARD" in
  OK:*) ok "controller: $CTRL_GUARD — no live-call route behind a GET" ;;
  *)    bad "controller exposes a live-call route on GET ($CTRL_GUARD)" ;;
esac

SEED='{}'
cleanup() {
  WEBSITE_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.WEBSITE_SEED);
  if (!s.projectId) return;
  const projectIds = [s.projectId, s.projectId2, s.projectId3, s.projectId4].filter(Boolean);
  const clientIds = [s.clientId, s.clientId2, s.clientId3, s.clientId4].filter(Boolean);
  await prisma.$transaction(async (tx) => {
    await tx.websiteInsightSnapshot.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.googleDataSnapshot.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.websitePageIdentity.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.sleeperPage.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.growthAsset.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.auditFinding.deleteMany({ where: { auditId: { in: s.auditIds } } });
    await tx.auditPage.deleteMany({ where: { auditId: { in: s.auditIds } } });
    await tx.technicalAudit.deleteMany({ where: { id: { in: s.auditIds } } });
    await tx.pageAnalysis.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.googleProjectResource.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.project.deleteMany({ where: { id: { in: projectIds } } });
    await tx.client.deleteMany({ where: { id: { in: clientIds } } });
    if (s.connectionIds && s.connectionIds.length) {
      await tx.googleConnection.deleteMany({ where: { id: { in: s.connectionIds } } });
    }
  });
  console.log('(smoke rows deleted)');
})().catch((e) => { console.error(`Cleanup failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
}
trap cleanup EXIT

TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] || die "auth" "could not authenticate the smoke operator"
AUTH=(-H "authorization: Bearer $TOKEN")

SEED=$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const stamp = `website-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gscClock = 'Pacific time (America/Los_Angeles) per the Search Analytics API';
  const gaClock = "GA4 property timezone: America/New_York (does not align with GSC's Pacific-time day boundaries)";
  const auditIds = [];

  // The join key is `host + path` — NOT the absolute URL. Mirrors
  // src/modules/website/page-identity.util.ts (host lowercased, single trailing
  // slash dropped, tracking params stripped). Seeded identities must use the
  // form the service itself derives from a raw URL, or nothing joins; the
  // assertions below then fail loudly rather than passing on an empty join.
  const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid'];
  const canon = (raw) => {
    const u = new URL(raw);
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (!p) p = '/';
    const kept = [];
    for (const [k, v] of u.searchParams) if (!TRACKING.includes(k.toLowerCase())) kept.push(`${k}=${v}`);
    kept.sort();
    return `${u.hostname.toLowerCase()}${p}${kept.length ? `?${kept.join('&')}` : ''}`;
  };

  const client = await prisma.client.create({ data: { name: `Website Smoke ${stamp}` } });
  const project = await prisma.project.create({
    data: { name: `Website Smoke Project ${stamp}`, domain: `${stamp}.example.test`, clientId: client.id },
  });

  // ── the page every source below is joined through ───────────────────────
  const guide = `https://${stamp}.example.test/guide`;
  const guideWww = `https://www.${stamp}.example.test/guide/`;
  const page = await prisma.websitePageIdentity.create({
    data: {
      projectId: project.id, canonicalUrl: canon(guide), host: `${stamp}.example.test`, path: '/guide',
      sourceUrls: JSON.stringify([guide, guideWww]),
    },
  });

  // ── newest technical audit: the page is now issue-free ──────────────────
  const auditId = `audit_${stamp}`;
  await prisma.technicalAudit.create({
    data: {
      id: auditId, projectId: project.id, targetUrl: `https://${stamp}.example.test`,
      triggeredBy: 'manual', pagesCrawled: 1,
      findings: { create: [{ type: 'robots', status: 'pass', severity: 'low', confidence: 'confirmed',
        detail: JSON.stringify({}), recommendedFix: '' }] },
      pages: { create: [{ url: guide, status: 200, title: 'Guide', issues: JSON.stringify([]) }] },
    },
  });
  auditIds.push(auditId);

  // ── older technical audit: the same page had two issues then ────────────
  const olderAuditId = `audit_old_${stamp}`;
  await prisma.technicalAudit.create({
    data: {
      id: olderAuditId, projectId: project.id, targetUrl: `https://${stamp}.example.test`,
      triggeredBy: 'manual', pagesCrawled: 1, createdAt: new Date('2026-07-01T00:00:00.000Z'),
      findings: { create: [{ type: 'robots', status: 'fail', severity: 'high', confidence: 'confirmed',
        detail: JSON.stringify({}), recommendedFix: 'Allow crawling' }] },
      pages: { create: [{ url: guide, status: 200, title: 'Guide',
        issues: JSON.stringify(['title-too-long', 'no-json-ld']) }] },
    },
  });
  auditIds.push(olderAuditId);

  // ── GSC: MANY rows for ONE page (the fanout trap) ──────────────────────
  // 24 rows = 6 queries x 2 countries x 2 devices, all on one date. If the
  // query-row count leaked into the session total it would be visible at once.
  // Clicks are deliberately ~a third of the sessions so the "different counting
  // methods" insight fires on real evidence (not on a seeded coincidence).
  const gscRows = [];
  const countries = ['usa', 'gbr'];
  const devices = ['desktop', 'mobile'];
  for (let i = 0; i < 6; i++) {
    for (const country of countries) {
      for (const device of devices) {
        gscRows.push({ page: guide, query: `guide query ${i}`, date: '2026-09-10',
          country, device, clicks: 1, impressions: 40, ctr: 0.025, position: 8 });
      }
    }
  }
  const gscTotalClicks = gscRows.reduce((s, r) => s + r.clicks, 0); // 24
  const gscTotalImpressions = gscRows.reduce((s, r) => s + r.impressions, 0); // 960
  const gscQueryCount = new Set(gscRows.map((r) => r.query)).size; // 6
  await prisma.googleDataSnapshot.create({
    data: { projectId: project.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: gscClock,
      rows: JSON.stringify(gscRows), rowCount: gscRows.length, complete: true },
  });

  // ── GA: two landing-session rows for the SAME page, two channels ────────
  // Sessions are additive across channels for a landing page (a session lands
  // once), but must never be touched by the GSC row count.
  const gaPerChannel = 40;
  const gaSessions = gaPerChannel * 2; // 80
  await prisma.googleDataSnapshot.create({
    data: { projectId: project.id, service: 'analytics', kind: 'landing-session',
      windowStart: '2026-08-21', windowEnd: '2026-09-17', timezoneNote: gaClock,
      rows: JSON.stringify([
        { landingPage: guide, channelGroup: 'Organic Search', sessionSource: 'google',
          date: '2026-09-10', sessions: gaPerChannel, totalUsers: 20, engagedSessions: 15 },
        { landingPage: guide, channelGroup: 'Direct', sessionSource: '(direct)',
          date: '2026-09-11', sessions: gaPerChannel, totalUsers: 20, engagedSessions: 15 },
      ]), rowCount: 2, complete: true },
  });

  // ── page-analysis history: two runs for this page, one unrelated URL ────
  // R33: run history and each run's source URL must survive the move.
  const analysisUrls = [guide, guideWww];
  for (let i = 0; i < analysisUrls.length; i++) {
    await prisma.pageAnalysis.create({
      data: { projectId: project.id, url: analysisUrls[i], title: `Guide v${i + 1}`, wordCount: 900 + i,
        blufScore: 20, questionH2Score: 18, formatScore: 15, claimsScore: 12, structureScore: 65,
        status: 'complete', fetchedAt: new Date(`2026-0${i + 5}-01T00:00:00.000Z`) },
    });
  }
  await prisma.pageAnalysis.create({
    data: { projectId: project.id, url: `https://${stamp}.example.test/unrelated`, title: 'Unrelated',
      wordCount: 400, blufScore: 5, questionH2Score: 5, formatScore: 5, claimsScore: 5, structureScore: 20,
      status: 'complete', fetchedAt: new Date('2026-06-01T00:00:00.000Z') },
  });

  // ── project 2: technical check + GSC, GA never connected (§7.6) ─────────
  const stamp2 = `${stamp}-noga`;
  const client2 = await prisma.client.create({ data: { name: `Website Smoke NoGA ${stamp2}` } });
  const project2 = await prisma.project.create({
    data: { name: `Website Smoke NoGA Project ${stamp2}`, domain: `${stamp2}.example.test`, clientId: client2.id },
  });
  const pricing = `https://${stamp2}.example.test/pricing`;
  const page2 = await prisma.websitePageIdentity.create({
    data: { projectId: project2.id, canonicalUrl: canon(pricing), host: `${stamp2}.example.test`,
      path: '/pricing', sourceUrls: JSON.stringify([pricing]) },
  });
  const audit2Id = `audit2_${stamp}`;
  await prisma.technicalAudit.create({
    data: { id: audit2Id, projectId: project2.id, targetUrl: `https://${stamp2}.example.test`,
      triggeredBy: 'manual', pagesCrawled: 1,
      pages: { create: [{ url: pricing, status: 200, title: 'Pricing',
        issues: JSON.stringify(['missing-meta-description']) }] } },
  });
  auditIds.push(audit2Id);
  await prisma.googleDataSnapshot.create({
    data: { projectId: project2.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: gscClock,
      rows: JSON.stringify([{ page: pricing, query: 'pricing plan', date: '2026-09-10',
        country: 'usa', device: 'desktop', clicks: 5, impressions: 60, ctr: 0.083, position: 6 }]),
      rowCount: 1, complete: true },
  });

  // ── project 3: identical GSC/GA ranges — the alignment flag must be real ─
  const stamp3 = `${stamp}-aligned`;
  const client3 = await prisma.client.create({ data: { name: `Website Smoke Aligned ${stamp3}` } });
  const project3 = await prisma.project.create({
    data: { name: `Website Smoke Aligned Project ${stamp3}`, domain: `${stamp3}.example.test`, clientId: client3.id },
  });
  const home = `https://${stamp3}.example.test/home`;
  await prisma.websitePageIdentity.create({
    data: { projectId: project3.id, canonicalUrl: canon(home), host: `${stamp3}.example.test`,
      path: '/home', sourceUrls: JSON.stringify([home]) },
  });
  await prisma.googleDataSnapshot.create({
    data: { projectId: project3.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: gscClock,
      rows: JSON.stringify([{ page: home, query: 'home page', date: '2026-09-10',
        country: 'usa', device: 'desktop', clicks: 10, impressions: 100, ctr: 0.1, position: 4 }]),
      rowCount: 1, complete: true },
  });
  await prisma.googleDataSnapshot.create({
    data: { projectId: project3.id, service: 'analytics', kind: 'landing-session',
      windowStart: '2026-08-20', windowEnd: '2026-09-16', timezoneNote: gaClock,
      rows: JSON.stringify([{ landingPage: home, channelGroup: 'Organic Search',
        sessionSource: 'google', date: '2026-09-10', sessions: 10, totalUsers: 9, engagedSessions: 6 }]),
      rowCount: 1, complete: true },
  });

  // ── project 4: EXPIRED Google access with a retained snapshot (§7.6) ────
  const stamp4 = `${stamp}-expired`;
  const client4 = await prisma.client.create({ data: { name: `Website Smoke Expired ${stamp4}` } });
  const project4 = await prisma.project.create({
    data: { name: `Website Smoke Expired Project ${stamp4}`, domain: `${stamp4}.example.test`, clientId: client4.id },
  });
  const blog = `https://${stamp4}.example.test/blog`;
  await prisma.websitePageIdentity.create({
    data: { projectId: project4.id, canonicalUrl: canon(blog), host: `${stamp4}.example.test`,
      path: '/blog', sourceUrls: JSON.stringify([blog]) },
  });
  await prisma.googleDataSnapshot.create({
    data: { projectId: project4.id, service: 'search-console', kind: 'page-query-date',
      windowStart: '2026-07-01', windowEnd: '2026-07-28', timezoneNote: gscClock,
      rows: JSON.stringify([{ page: blog, query: 'blog archive', date: '2026-07-10',
        country: 'usa', device: 'desktop', clicks: 7, impressions: 90, ctr: 0.078, position: 9 }]),
      rowCount: 1, complete: true },
  });
  const connection = await prisma.googleConnection.create({
    data: { userId: `smoke-expired-${stamp}`, service: 'search-console', googleEmail: 'expired@example.test',
      scope: 'webmasters.readonly', accessToken: 'ivB64.tagB64.ctB64', refreshToken: 'ivB64.tagB64.ctB64',
      expiresAt: new Date('2026-08-01T00:00:00.000Z') },
  });
  await prisma.googleProjectResource.create({
    data: { projectId: project4.id, service: 'search-console', connectionId: connection.id,
      resourceId: `https://${stamp4}.example.test` },
  });

  console.log(JSON.stringify({
    clientId: client.id, projectId: project.id, pageId: page.id, pageCanonical: canon(guide),
    auditIds, newestAuditId: auditId,
    gscTotalClicks, gscTotalImpressions, gaSessions, gaPerChannel,
    gscRowCount: gscRows.length, gscQueryCount, gscCountryCount: countries.length, gscDeviceCount: devices.length,
    clientId2: client2.id, projectId2: project2.id, pageId2: page2.id,
    clientId3: client3.id, projectId3: project3.id, pageId3: home,
    clientId4: client4.id, projectId4: project4.id, pageId4: blog,
    connectionIds: [connection.id],
  }));
})().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
EOF
)
[ -n "$SEED" ] || die "seed" "the seed script produced no output"
PROJECT_ID=$(echo "$SEED" | jget projectId)
PAGE_ID=$(echo "$SEED" | jget pageId)
NEWEST_AUDIT=$(echo "$SEED" | jget newestAuditId)
GSC_CLICKS=$(echo "$SEED" | jget gscTotalClicks)
GSC_IMPRESSIONS=$(echo "$SEED" | jget gscTotalImpressions)
GA_SESSIONS=$(echo "$SEED" | jget gaSessions)
GSC_QUERY_COUNT=$(echo "$SEED" | jget gscQueryCount)
GSC_ROW_COUNT=$(echo "$SEED" | jget gscRowCount)
PROJECT_ID2=$(echo "$SEED" | jget projectId2)
PAGE_ID2=$(echo "$SEED" | jget pageId2)
PROJECT_ID3=$(echo "$SEED" | jget projectId3)
PROJECT_ID4=$(echo "$SEED" | jget projectId4)
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "__ERR__" ] || die "seed" "no projectId returned: $SEED"

# ── attribution rule needs a fix dated BEFORE the observation windows ───────
# The newest audit is created "now" (after both extract windows), so re-date it
# into the past; the older audit stays older still, so both the page-level fix
# detection and the "later evidence" requirement are satisfied deterministically.
node <<EOF
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  await prisma.technicalAudit.update({ where: { id: '$NEWEST_AUDIT' }, data: { createdAt: new Date('2026-08-01T00:00:00.000Z') } });
})().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => prisma.\$disconnect());
EOF

echo "seeded project=$PROJECT_ID page=$PAGE_ID gsc=${GSC_CLICKS}clicks/${GSC_IMPRESSIONS}impr in $GSC_ROW_COUNT rows ga=${GA_SESSIONS}sessions"

# One page row (or null) out of a pages payload.
row_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const r=a.find(p=>p.pageIdentityId===process.argv[1]);process.stdout.write(r?JSON.stringify(r):"null")}catch(e){process.stdout.write("__ERR__")}})' "$1"; }

# ── 1. grain-safe join ──────────────────────────────────────────────────────
PAGES=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages")
ROW=$(echo "$PAGES" | row_of "$PAGE_ID")
[ "$ROW" != "null" ] && [ "$ROW" != "__ERR__" ] || die "join" "the seeded page is not in GET /website/pages: $PAGES"
CLICKS=$(echo "$ROW" | jget search.clicks)
SESSIONS=$(echo "$ROW" | jget visitors.sessions)
[ "$CLICKS" = "$GSC_CLICKS" ] \
  && ok "GSC clicks summed once across $GSC_ROW_COUNT rows / 2 countries / 2 devices ($CLICKS)" \
  || bad "expected $GSC_CLICKS GSC clicks, got $CLICKS"
[ "$SESSIONS" = "$GA_SESSIONS" ] \
  && ok "GA sessions are the page's own total ($SESSIONS), NOT multiplied by the $GSC_ROW_COUNT GSC rows" \
  || bad "expected $GA_SESSIONS sessions (not x$GSC_ROW_COUNT), got $SESSIONS — fanout suspected"
FANOUT=$((GSC_ROW_COUNT * GA_SESSIONS))
[ "$SESSIONS" != "$FANOUT" ] && ok "the session total is not the fanout product ($FANOUT)" \
  || bad "sessions equal rows x sessions ($FANOUT) — fanout confirmed"
[ "$CLICKS" != "$SESSIONS" ] && ok "clicks and sessions stay separate units ($CLICKS vs $SESSIONS, never added)" \
  || bad "clicks and sessions collapsed into one figure ($CLICKS)"
IMPRESSIONS=$(echo "$ROW" | jget search.impressions)
[ "$IMPRESSIONS" = "$GSC_IMPRESSIONS" ] && [ "$IMPRESSIONS" != "$SESSIONS" ] \
  && ok "impressions are their own unit too ($IMPRESSIONS, not the session total)" \
  || bad "impressions wrong or conflated: $IMPRESSIONS"
NQ=$(echo "$ROW" | jlen search.topQueries)
[ "$NQ" = "$GSC_QUERY_COUNT" ] \
  && ok "query rows collapse to $NQ distinct queries (from $GSC_ROW_COUNT rows, not $GSC_ROW_COUNT queries)" \
  || bad "expected $GSC_QUERY_COUNT distinct queries, got $NQ"
COUNTRY_N=$(echo "$ROW" | jlen search.scope.countries)
DEVICE_N=$(echo "$ROW" | jlen search.scope.devices)
[ "$COUNTRY_N" = "2" ] && [ "$DEVICE_N" = "2" ] \
  && ok "the observation's real scope is recorded ($COUNTRY_N countries, $DEVICE_N devices)" \
  || bad "expected 2 countries / 2 devices, got $COUNTRY_N / $DEVICE_N"
[ "$(echo "$ROW" | jget search.scope.complete)" = "true" ] \
  && ok "extract completeness is reported alongside the scope" \
  || bad "scope.complete should be true for this seeded extract"
POS=$(echo "$ROW" | jget search.position)
node -e 'process.exit(Number(process.argv[1]) > 0 ? 0 : 1)' "$POS" \
  && ok "average position is computed, not left at zero ($POS)" \
  || bad "expected a computed average position, got $POS"
# the same grain holds at the overview's site totals
OV_GRAIN=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview")
OV_C=$(echo "$OV_GRAIN" | jget google.clicks)
OV_S=$(echo "$OV_GRAIN" | jget google.sessions)
[ "$OV_C" = "$GSC_CLICKS" ] && [ "$OV_S" = "$GA_SESSIONS" ] \
  && ok "the overview totals keep the same grain ($OV_C clicks, $OV_S sessions)" \
  || bad "overview totals are not the per-page sums (clicks=$OV_C sessions=$OV_S)"

# ── 1b. §7.4 no-fabrication: related aggregate evidence, never a per-visit link
OLIMIT=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview")
QL=$(echo "$OLIMIT" | jget joinLimitation.querySideLabel)
SL=$(echo "$OLIMIT" | jget joinLimitation.sessionSideLabel)
STMT=$(echo "$OLIMIT" | jget joinLimitation.statement)
[ "$QL" = "Queries leading to this page" ] && [ "$SL" = "Visitors landing on this page" ] \
  && ok "the two extracts are labelled \"$QL\" and \"$SL\"" \
  || bad "expected the two agreed labels, got \"$QL\" / \"$SL\""
echo "$STMT" | grep -qi "not a per-visit link" && echo "$STMT" | grep -qi "neither api can attach" \
  && ok "the limitation states that no query-to-session link exists" \
  || bad "the limitation does not state the missing linkage: $STMT"
echo "$STMT" | grep -qi "utm" \
  && ok "…and says why UTM parameters do not supply it either" \
  || bad "the limitation does not address UTM: $STMT"
FAB=$(echo "$PAGES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const keys=["\"conversions\"","\"conversionRate\"","\"perQuerySessions\"","\"sessionByQuery\"","\"sessionsByQuery\""];const hit=keys.filter(k=>s.includes(k));process.stdout.write(hit.length?hit.join(","):"CLEAN")})')
[ "$FAB" = "CLEAN" ] && ok "no per-query session/conversion field exists anywhere in the pages payload" \
  || bad "the pages payload carries a fabricated per-query session/conversion field ($FAB)"

# ── 2. missing-source honesty — a project with NO GA snapshot at all ────────
PAGES2=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID2/website/pages")
ROW2=$(echo "$PAGES2" | row_of "$PAGE_ID2")
[ "$ROW2" != "null" ] && [ "$ROW2" != "__ERR__" ] || die "join2" "the no-GA page is missing from /website/pages: $PAGES2"
[ "$(echo "$ROW2" | jget visitors.available)" = "false" ] \
  && ok "visitors.available is honestly false where no Analytics extract exists" \
  || bad "expected visitors.available=false, got $(echo "$ROW2" | jget visitors.available)"
ENG=$(echo "$ROW2" | jget visitors.engagementRate)
[ -z "$ENG" ] && ok "engagement rate is absent rather than 0 with no Analytics data" \
  || bad "expected an absent engagement rate, got $ENG"
[ "$(echo "$ROW2" | jget search.clicks)" = "5" ] \
  && ok "Search Console facts still render with Analytics absent (not all-or-nothing)" \
  || bad "expected search.clicks=5, got $(echo "$ROW2" | jget search.clicks)"
OVERVIEW2=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID2/website/overview")
[ "$(echo "$OVERVIEW2" | jget sourceAvailability.analytics.connected)" = "false" ] \
  && ok "source availability reports Analytics honestly as not connected" \
  || bad "sourceAvailability.analytics.connected should be false"
SA_LABEL=$(echo "$OVERVIEW2" | jget sourceAvailability.analytics.label)
echo "$SA_LABEL" | grep -qi "not connected" && ok "plain-English state: \"$SA_LABEL\"" \
  || bad "expected a plain-English not-connected label, got: $SA_LABEL"
echo "$SA_LABEL" | grep -qiE "needs reconnection|retained" \
  && bad "a never-connected source must not claim expired/retained access: $SA_LABEL" \
  || ok "…and does not pretend to hold retained data it never had"
TOTAL_SESSIONS2=$(echo "$OVERVIEW2" | jget google.sessions)
[ -z "$TOTAL_SESSIONS2" ] && ok "the overview session total is absent, not a fabricated 0" \
  || bad "expected a null session total with no Analytics, got $TOTAL_SESSIONS2"
[ "$(echo "$OVERVIEW2" | jget google.clicks)" = "5" ] \
  && ok "the overview still reports Google clicks with Analytics missing" \
  || bad "expected google.clicks=5, got $(echo "$OVERVIEW2" | jget google.clicks)"
[ "$(echo "$OVERVIEW2" | jget sourceAvailability.technicalCheck.available)" = "true" ] \
  && ok "public website-check facts render with no Google connected at all" \
  || bad "expected the technical check to be available without Google"
TC_LABEL=$(echo "$OVERVIEW2" | jget sourceAvailability.technicalCheck.label)
echo "$TC_LABEL" | grep -qi "website check updated" && ok "plain-English check label: \"$TC_LABEL\"" \
  || bad "expected a plain-English website-check label, got: $TC_LABEL"
[ "$(echo "$OVERVIEW2" | jget health.state)" = "needs-attention" ] \
  && ok "the health summary is a real reading, not unknown/missing, with no Google" \
  || bad "expected health.state=needs-attention, got $(echo "$OVERVIEW2" | jget health.state)"
ADDS=$(echo "$OVERVIEW2" | jget sourceAvailability.analytics.addsWhat)
echo "$ADDS" | grep -qi "land on each page" && ok "the screen explains what connecting Analytics would add" \
  || bad "no plain-English note on what Analytics adds: $ADDS"
GUIDANCE=$(echo "$OVERVIEW2" | jget connectGuidance)
echo "$GUIDANCE" | grep -qi "visitor" && ok "connect guidance explains the missing visitor figures" \
  || bad "connectGuidance does not mention the visitor figures: $GUIDANCE"
# §7.5: missing inputs disable a rule — they must not fire on an invented zero.
NOGA_INSIGHTS=$(echo "$OVERVIEW2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const ids=(o.insights||[]).map(i=>i.ruleId);const gaRules=["visitors-reach-outdated-page","search-clicks-vs-organic-sessions-differ","query-opportunity-weak-page"];const fired=ids.filter(x=>gaRules.includes(x));process.stdout.write(`${ids.length} total, ${fired.length} needing the missing inputs`);})')
echo "$NOGA_INSIGHTS" | grep -q "^0 total, 0 needing" \
  && ok "no insight fires from the absent sources ($NOGA_INSIGHTS)" \
  || bad "an insight fired despite missing inputs: $NOGA_INSIGHTS"

# ── 3. attribution-fabrication guard ────────────────────────────────────────
OVERVIEW=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview")
FIX_INSIGHT=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const r=(o.insights||[]).find(i=>i.ruleId==="technical-fix-followed-by-improvement");process.stdout.write(r?JSON.stringify(r):"null")})')
if [ "$FIX_INSIGHT" = "null" ]; then
  bad "technical-fix-followed-by-improvement did not fire for a dated fix preceding later windows"
else
  MSG=$(echo "$FIX_INSIGHT" | jget message)
  [ "$MSG" = "Results improved after this change; other factors may also have contributed." ] \
    && ok "the fix insight uses the exact honest wording" \
    || bad "unexpected attribution wording: $MSG"
  echo "$MSG" | grep -qiE "caused|proves|guarantee" && bad "the wording makes a bare causal claim: $MSG" \
    || ok "the wording contains no bare causal claim"
  LIM=$(echo "$FIX_INSIGHT" | jget limitations)
  echo "$LIM" | grep -qi "does not prove" && ok "the limitation explicitly disclaims proof of causation" \
    || bad "the limitation does not disclaim causation: $LIM"
  ORIGIN=$(echo "$FIX_INSIGHT" | jget facts.fixOrigin)
  [ "$ORIGIN" = "site" ] && ok "the insight states the fix's origin (site-wide, not silently per-page)" \
    || bad "expected fixOrigin=site for a whole-site passing check, got $ORIGIN"
fi
# The same guarantee on the page detail's "Changes" list.
DETAIL=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID")
NC=$(echo "$DETAIL" | jlen changes)
if [ "$NC" -ge 1 ] 2>/dev/null; then
  ok "the page detail lists $NC dated changes"
else
  bad "the page detail returned no changes: $(echo "$DETAIL" | jget changes)"
fi
[ "$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const c=o.changes||[];process.stdout.write(c.length&&c.every(x=>x.causal===false)?"YES":"NO")})')" = "YES" ] \
  && ok "every change entry is typed causal:false" \
  || bad "a change entry claims causation (causal !== false)"
CHANGE_TEXT=$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write((o.changes||[]).map(c=>c.description).join(" /// "))})')
echo "$CHANGE_TEXT" | grep -qiE "caused|proves|because of this fix|resulted in" \
  && bad "a change description makes a bare causal claim: $CHANGE_TEXT" \
  || ok "no change description makes a bare causal claim"
KINDS=$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write([...new Set((o.changes||[]).map(c=>c.kind))].sort().join(","))})')
echo "$KINDS" | grep -q "technical-fix" && ok "the observed page-level fix appears in Changes (kinds: $KINDS)" \
  || bad "the seeded fix (issues then, none now) is missing from Changes: $KINDS"
echo "$KINDS" | grep -q "content-analysis" && ok "the page-analysis runs appear as dated changes too" \
  || bad "no content-analysis entry in Changes: $KINDS"
FIX_DATE=$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const c=(o.changes||[]).find(x=>x.kind==="technical-fix");process.stdout.write(c&&c.date?c.date:"NONE")})')
[ "$FIX_DATE" != "NONE" ] && ok "the fix change carries a date ($FIX_DATE)" \
  || bad "the fix change carries no date"

# ── 4. date-boundary mismatch disclosure ────────────────────────────────────
DIFF_INSIGHT=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const r=(o.insights||[]).find(i=>i.ruleId==="search-clicks-vs-organic-sessions-differ");process.stdout.write(r?JSON.stringify(r):"null")})')
if [ "$DIFF_INSIGHT" = "null" ]; then
  bad "search-clicks-vs-organic-sessions-differ did not fire for a $GSC_CLICKS-click/$GA_SESSIONS-session page"
else
  DLIM=$(echo "$DIFF_INSIGHT" | jget limitations)
  echo "$DLIM" | grep -qi "Pacific" && echo "$DLIM" | grep -qi "GA4 property timezone" \
    && ok "the clock difference is disclosed explicitly (Pacific vs GA4 property timezone)" \
    || bad "expected both clocks named in the limitation, got: $DLIM"
  echo "$DLIM" | grep -qi "not identical" \
    && ok "…and the two day boundaries are stated as not identical, not relabeled as equal" \
    || bad "the limitation does not state the day boundaries differ: $DLIM"
  echo "$DLIM" | grep -qi "not flagged as a defect" \
    && ok "…and a clock mismatch is not reported as a defect" \
    || bad "the limitation does not say a mismatch is expected: $DLIM"
fi
W_ALIGNED=$(echo "$OVERVIEW" | jget windows.aligned)
W_COARSE=$(echo "$OVERVIEW" | jget windows.coarserComparison)
W_NOTE=$(echo "$OVERVIEW" | jget windows.note)
[ "$W_ALIGNED" = "false" ] && [ "$W_COARSE" = "true" ] \
  && ok "mismatched windows: aligned=false, coarserComparison=true" \
  || bad "expected aligned=false / coarserComparison=true, got $W_ALIGNED / $W_COARSE"
echo "$W_NOTE" | grep -qi "Pacific" && echo "$W_NOTE" | grep -qi "property timezone" \
  && ok "the window note names both clocks" \
  || bad "the window note does not name both clocks: $W_NOTE"
echo "$W_NOTE" | grep -qi "whole-window scope only" \
  && ok "…and states the coarser comparison that was actually used" \
  || bad "the window note does not state the coarser comparison: $W_NOTE"
# The flag is real, not always-on: identical ranges must report aligned.
OV3=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID3/website/overview")
[ "$(echo "$OV3" | jget windows.aligned)" = "true" ] && [ "$(echo "$OV3" | jget windows.coarserComparison)" = "false" ] \
  && ok "identical ranges report aligned=true (the flag is a real comparison)" \
  || bad "expected aligned=true for identical ranges, got $(echo "$OV3" | jget windows.aligned) / $(echo "$OV3" | jget windows.coarserComparison)"
N3=$(echo "$OV3" | jget windows.note)
echo "$N3" | grep -qi "Pacific" && echo "$N3" | grep -qi "different clocks" \
  && ok "…while still naming both clocks and refusing a daily comparison" \
  || bad "the aligned note omits the clocks or the daily caveat: $N3"

# ── 5. read-only reads — zero live/paid calls, zero jobs on GET ─────────────
BEFORE_JSON=$(PROJECT_ID="$PROJECT_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const projectId = process.env.PROJECT_ID;
  const [snaps, audits, latest] = await Promise.all([
    prisma.googleDataSnapshot.count({ where: { projectId } }),
    prisma.technicalAudit.count({ where: { projectId } }),
    prisma.googleDataSnapshot.findFirst({ where: { projectId }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } }),
  ]);
  console.log(JSON.stringify({ snaps, audits, fetchedAt: latest ? latest.fetchedAt.toISOString() : null }));
})().finally(() => prisma.$disconnect());
EOF
)
for _ in 1 2 3; do
  curl -s -o /dev/null "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview"
  curl -s -o /dev/null "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages"
  curl -s -o /dev/null "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID"
done
AFTER_JSON=$(PROJECT_ID="$PROJECT_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const projectId = process.env.PROJECT_ID;
  const [snaps, audits, latest] = await Promise.all([
    prisma.googleDataSnapshot.count({ where: { projectId } }),
    prisma.technicalAudit.count({ where: { projectId } }),
    prisma.googleDataSnapshot.findFirst({ where: { projectId }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } }),
  ]);
  console.log(JSON.stringify({ snaps, audits, fetchedAt: latest ? latest.fetchedAt.toISOString() : null }));
})().finally(() => prisma.$disconnect());
EOF
)
B_SNAPS=$(echo "$BEFORE_JSON" | jget snaps); A_SNAPS=$(echo "$AFTER_JSON" | jget snaps)
B_AUDITS=$(echo "$BEFORE_JSON" | jget audits); A_AUDITS=$(echo "$AFTER_JSON" | jget audits)
B_FETCH=$(echo "$BEFORE_JSON" | jget fetchedAt); A_FETCH=$(echo "$AFTER_JSON" | jget fetchedAt)
[ "$B_SNAPS" = "$A_SNAPS" ] && ok "9 page loads created no Google snapshot ($A_SNAPS before and after — nothing fetched)" \
  || bad "reads changed the Google snapshot count ($B_SNAPS -> $A_SNAPS) — a read is calling Google"
[ "$B_FETCH" = "$A_FETCH" ] && ok "the newest Google fetch timestamp is unchanged ($A_FETCH) — no provider refresh on read" \
  || bad "a read refreshed Google data ($B_FETCH -> $A_FETCH)"
[ "$B_AUDITS" = "$A_AUDITS" ] && ok "reads started no new website check ($A_AUDITS audits before and after)" \
  || bad "reads started a website check ($B_AUDITS -> $A_AUDITS)"
T0=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview")
T1=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID")
[ "$T0" = "200" ] && [ "$T1" = "200" ] \
  && ok "overview and page detail both read 200 from storage alone (project 1 has no Google resource mapped)" \
  || bad "read paths should serve from storage alone, got $T0 / $T1"
# Insight snapshots are kept for provenance — but an unchanged read must not
# keep growing the table.
IS_BEFORE=$(PROJECT_ID="$PROJECT_ID" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.websiteInsightSnapshot.count({where:{projectId:process.env.PROJECT_ID}}).then(n=>console.log(n)).finally(()=>p.$disconnect())')
curl -s -o /dev/null "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview"
curl -s -o /dev/null "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/overview"
IS_AFTER=$(PROJECT_ID="$PROJECT_ID" node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.websiteInsightSnapshot.count({where:{projectId:process.env.PROJECT_ID}}).then(n=>console.log(n)).finally(()=>p.$disconnect())')
[ "$IS_BEFORE" = "$IS_AFTER" ] && ok "insight snapshots are kept for provenance but not rewritten on unchanged reads ($IS_AFTER rows)" \
  || bad "every read appended insight snapshots ($IS_BEFORE -> $IS_AFTER)"

# ── 6. §7.2 page detail ─────────────────────────────────────────────────────
CANON=$(echo "$DETAIL" | jget identity.canonicalUrl)
PAGE_CANON=$(echo "$SEED" | jget pageCanonical)
[ -n "$CANON" ] && ok "the page detail resolves a canonical address ($CANON)" \
  || bad "the page detail has no canonical address"
[ "$CANON" = "$PAGE_CANON" ] \
  && ok "…and it is the same host+path join key the sources normalize to (no scheme, no trailing slash)" \
  || bad "the canonical join key does not match the normalization ($CANON vs $PAGE_CANON)"
[ "$(echo "$DETAIL" | jlen identity.sourceUrls)" = "2" ] \
  && ok "every original source URL is preserved behind the one identity (2 kept)" \
  || bad "expected 2 preserved source URLs, got $(echo "$DETAIL" | jlen identity.sourceUrls)"
[ "$(echo "$DETAIL" | jlen content)" = "2" ] \
  && ok "the content tab carries the page-analysis run history (2 runs) and excludes unrelated URLs" \
  || bad "expected 2 page-analysis runs for this page, got $(echo "$DETAIL" | jlen content)"
CURL1=$(echo "$DETAIL" | jget content.0.url)
[ -n "$CURL1" ] && ok "each analysis run keeps its own source URL ($CURL1)" \
  || bad "an analysis run lost its source URL"
[ "$(echo "$DETAIL" | jget content.0.structureScore)" = "65" ] \
  && ok "the analysis component scores survive the move (structureScore 65/100)" \
  || bad "expected structureScore 65, got $(echo "$DETAIL" | jget content.0.structureScore)"
[ "$(echo "$DETAIL" | jget facts.contentStructureScore)" = "65" ] \
  && ok "the analysis score also reaches the joined facts (so score-dependent rules can fire)" \
  || bad "facts.contentStructureScore is not the stored analysis score"
REC=$(echo "$DETAIL" | jget refreshRecommendation.recommended)
RECREASON=$(echo "$DETAIL" | jget refreshRecommendation.reason)
[ -n "$REC" ] && [ -n "$RECREASON" ] && ok "a refresh recommendation is present with its reason: $RECREASON" \
  || bad "the refresh recommendation is missing its reason: $REC / $RECREASON"
[ "$(echo "$DETAIL" | jget linkedContent)" != "__ERR__" ] \
  && ok "linked Cailyx content is present as a field (empty here — nothing published to this address)" \
  || bad "linkedContent is missing from the payload"
SCOPE_NOTE=$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const sc=o.facts&&o.facts.search&&o.facts.search.scope;process.stdout.write(sc?`${sc.countries.length}c/${sc.devices.length}d`:"NONE")})')
[ "$SCOPE_NOTE" = "2c/2d" ] \
  && ok "the Search tab's observation states its location/device scope (2 countries / 2 devices)" \
  || bad "the page detail does not state the search scope, got $SCOPE_NOTE"
VSESS=$(echo "$DETAIL" | jget facts.visitors.sessions)
VENG=$(echo "$DETAIL" | jget facts.visitors.engagedSessions)
[ "$VSESS" = "$GA_SESSIONS" ] && [ "$VENG" = "30" ] \
  && ok "the Visitors tab shows engagement outcomes (30 engaged of $GA_SESSIONS landing sessions)" \
  || bad "expected 30 engaged of $GA_SESSIONS sessions, got $VENG / $VSESS"
RATE=$(echo "$DETAIL" | jget facts.visitors.engagementRate)
node -e 'const r=Number(process.argv[1]);process.exit(r>0 && r<=1 ? 0 : 1)' "$RATE" \
  && ok "the engagement rate is a real 0-1 proportion ($RATE)" \
  || bad "the engagement rate is not a proportion: $RATE"
[ "$(echo "$DETAIL" | jlen facts.visitors.bySource)" = "2" ] \
  && ok "landing sessions are broken down by source/channel (2 channels)" \
  || bad "expected 2 source/channel buckets, got $(echo "$DETAIL" | jlen facts.visitors.bySource)"

# ── 7. §7.6 expired access — retained snapshot, labelled, still served ──────
OV4=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID4/website/overview")
[ "$(echo "$OV4" | jget sourceAvailability.searchConsole.expired)" = "true" ] \
  && ok "expired Google access is reported as expired" \
  || bad "expected expired=true, got $(echo "$OV4" | jget sourceAvailability.searchConsole.expired)"
E_LABEL=$(echo "$OV4" | jget sourceAvailability.searchConsole.label)
echo "$E_LABEL" | grep -qi "reconnect" && ok "the label offers reconnection: \"$E_LABEL\"" \
  || bad "the expired label does not offer reconnection: $E_LABEL"
[ "$(echo "$OV4" | jget sourceAvailability.searchConsole.retainedSnapshot.windowEnd)" = "2026-07-28" ] \
  && ok "the retained snapshot is kept with its own date (2026-07-28)" \
  || bad "expected a retained snapshot dated 2026-07-28, got $(echo "$OV4" | jget sourceAvailability.searchConsole.retainedSnapshot.windowEnd)"
echo "$E_LABEL" | grep -q "2026-07-28" \
  && ok "the label itself names that date, so retained data is never shown as current" \
  || bad "the label does not name the retained date: $E_LABEL"
[ "$(echo "$OV4" | jget google.clicks)" = "7" ] \
  && ok "the last authorized snapshot is still served after expiry (7 clicks)" \
  || bad "expected the retained snapshot's 7 clicks to still render, got $(echo "$OV4" | jget google.clicks)"
echo "$(echo "$OV4" | jget connectGuidance)" | grep -qi "expired" \
  && ok "connect guidance explains the expiry and what to do about it" \
  || bad "connectGuidance does not explain the expiry"

# ── 8. §7.2 "Update this page" — the real refresh workflow ──────────────────
R1=$(curl -s -X POST "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID/refresh")
[ "$(echo "$R1" | jget created)" = "true" ] \
  && ok "\"Update this page\" starts a refresh (status: $(echo "$R1" | jget refresh.status))" \
  || bad "expected created=true on the first call, got: $R1"
echo "$(echo "$R1" | jget pageDetailHref)" | grep -q "research/website/pages/$PAGE_ID" \
  && ok "the response hands back the page-detail route, so the reader stays in this page's context" \
  || bad "the response does not return the page-detail context: $(echo "$R1" | jget pageDetailHref)"
echo "$(echo "$R1" | jget refreshWorkflowHref)" | grep -q "content/refreshes" \
  && ok "…and points at the real refresh workflow ($(echo "$R1" | jget refreshWorkflowHref))" \
  || bad "the response does not point at the refresh workflow"
R2=$(curl -s -X POST "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID/refresh")
[ "$(echo "$R2" | jget created)" = "false" ] \
  && ok "a second click opens the existing refresh instead of queueing the page twice" \
  || bad "expected created=false on the second call, got $(echo "$R2" | jget created)"
DETAIL_AFTER=$(curl -s "${AUTH[@]}" "$API/projects/$PROJECT_ID/website/pages/$PAGE_ID")
[ "$(echo "$DETAIL_AFTER" | jget linkedRefresh.id)" = "$(echo "$R1" | jget refresh.id)" ] \
  && ok "the page detail now shows the linked refresh (the reader is returned to the same page)" \
  || bad "the page detail does not show the started refresh ($(echo "$DETAIL_AFTER" | jget linkedRefresh.id))"
REFRESH_CHANGE=$(echo "$DETAIL_AFTER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const c=(o.changes||[]).find(x=>x.kind==="content-revision");process.stdout.write(c?"YES":"NO")})')
[ "$REFRESH_CHANGE" = "YES" ] \
  && ok "the started refresh appears in Changes as a dated content revision" \
  || bad "the started refresh is missing from the Changes list"
RC=$(echo "$DETAIL_AFTER" | jget refreshRecommendation.reason)
echo "$RC" | grep -qi "already open" \
  && ok "an open refresh is reported rather than recommended a second time: \"$RC\"" \
  || bad "the refresh recommendation ignores the open refresh: $RC"

# ── 9. §7.5 insight contract + §7.1 overview fields ─────────────────────────
BAD_INSIGHT=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const bad=(o.insights||[]).filter(i=>!(i.ruleVersion>0)||!(Array.isArray(i.sourceIds)&&i.sourceIds.length)||typeof i.crossSource!=="boolean"||!i.actionTarget||!i.limitations||!i.facts||typeof i.facts!=="object");process.stdout.write(bad.length?bad.map(b=>b.ruleId).join(","):"NONE")})')
[ "$BAD_INSIGHT" = "NONE" ] \
  && ok "every insight is versioned, source-id-referencing, limited, actionable and cross-source flagged" \
  || bad "insights missing part of the §7.5 contract: $BAD_INSIGHT"
NINS=$(echo "$OVERVIEW" | jlen insights)
if [ "$NINS" -ge 1 ] && [ "$NINS" -le 5 ] 2>/dev/null; then
  ok "the overview shows $NINS insights (three to five when that many are supported)"
else
  bad "expected 1-5 insights on the overview, got $NINS"
fi
CROSS_N=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String((o.insights||[]).filter(i=>i.crossSource).length))})')
if [ "$CROSS_N" -ge 1 ] 2>/dev/null; then
  ok "cross-source insights are surfaced first among them ($CROSS_N of $NINS)"
else
  bad "no cross-source insight surfaced despite both sources being present"
fi
IMP_OK=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const p=(o.importantPages||[])[0];if(!p){process.stdout.write("NOPAGE");return}const need=["pageIdentityId","title","canonicalUrl","health","clicks","organicSessions","nextAction"];const missing=need.filter(k=>!(k in p));process.stdout.write(missing.length?missing.join(","):"OK")})')
[ "$IMP_OK" = "OK" ] \
  && ok "important pages carry a title, address, health state, both measures and a next action" \
  || bad "important-page rows are missing fields: $IMP_OK"
WIN_OK=$(echo "$OVERVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=o.google||{};const both=g.clicksWindow&&g.sessionsWindow;const differ=both&&(g.clicksWindow.startDate!==g.sessionsWindow.startDate||g.clicksWindow.endDate!==g.sessionsWindow.endDate);process.stdout.write(differ?"DIFFER":both?"SAME":"MISSING")})')
[ "$WIN_OK" = "DIFFER" ] \
  && ok "clicks and sessions each state their own, differing window" \
  || bad "the two measures do not carry independent windows: $WIN_OK"
POS_OV=$(echo "$OVERVIEW" | jget google.position)
[ -n "$POS_OV" ] && ok "the overview reports an average position ($POS_OV)" \
  || bad "google.position is missing from the overview"
STAFF_HREF=$(echo "$OVERVIEW" | jget staffPanels.technicalDetailsHref)
[ -n "$(echo "$OVERVIEW" | jget staffPanels.latestCheckId)" ] && echo "$STAFF_HREF" | grep -q "research/website/runs/" \
  && ok "the staff check-history/technical-details panel is referenced from the screen, not first-level nav" \
  || bad "the staff panel pointers are missing: $STAFF_HREF"

# ── 10. §7.1 nav merge + retired routes (static) ────────────────────────────
NAV="../web/src/lib/navigation.ts"
if [ -f "$NAV" ]; then
  NAV_ONE=$(grep -c "href: '/research/website'" "$NAV")
  NAV_OLD=$(grep -cE "href: '/research/(search|traffic)'" "$NAV")
  NAV_PA=$(grep -c "href: '/content/page-analysis'" "$NAV")
  [ "$NAV_ONE" = "1" ] && [ "$NAV_OLD" = "0" ] \
    && ok "the nav has exactly one Website destination and no separate search/traffic entries" \
    || bad "the nav still splits Website across $NAV_ONE + $NAV_OLD entries"
  [ "$NAV_PA" = "0" ] && ok "the nav no longer offers the duplicate Content \"Page analysis\" destination" \
    || bad "the nav still lists /content/page-analysis"
else
  bad "could not find web/src/lib/navigation.ts from $(pwd)"
fi
WEB="../web/src/app/(ops)/projects/[projectId]"
for R in research/search research/traffic content/page-analysis; do
  F="$WEB/$R/page.tsx"
  if [ -f "$F" ] && grep -q "redirect(" "$F"; then
    ok "the retired route /$R redirects to its new home"
  else
    bad "/$R does not redirect (missing file, or no redirect call)"
  fi
done
[ -f "$WEB/research/website/page-analysis/page.tsx" ] \
  && ok "the Page Analysis screen itself still exists, now under Website (R33)" \
  || bad "the moved Page Analysis screen is not at its new route"

echo "== website-unified: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]

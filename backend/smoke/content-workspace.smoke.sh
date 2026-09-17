#!/usr/bin/env bash
# E2E smoke — P08 content workspace (platform_improvement_plan.md §13.1-13.5,
# §13.9-13.11). Exercises: rename-safe ContentBrief version lineage
# (briefFamilyId, decoupled from title), idempotent opportunity->content
# conversion (P07's existing mechanism, reused unchanged), explicit
# client-sharing state on ContentRevision (default private, only an
# explicitly shared revision is ever client-readable), and the four
# independent §13.4 state axes on a piece that is simultaneously published
# (an older revision) and mid-revision (a newer unpublished draft).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== content-workspace smoke =="

SEED='{}'
cleanup() {
  CW_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.CW_SEED);
  if (!s.projectId) return;
  await prisma.$transaction(async (tx) => {
    const assets = await tx.growthAsset.findMany({ where: { projectId: s.projectId }, select: { id: true } });
    const assetIds = assets.map((a) => a.id);
    await tx.publication.deleteMany({ where: { projectId: s.projectId } });
    await tx.publishDestination.deleteMany({ where: { projectId: s.projectId } });
    const approvals = await tx.approvalRequest.findMany({ where: { projectId: s.projectId }, select: { id: true } });
    await tx.approvalDecision.deleteMany({ where: { approvalRequestId: { in: approvals.map((a) => a.id) } } });
    await tx.approvalRequest.deleteMany({ where: { projectId: s.projectId } });
    await tx.contentRevision.deleteMany({ where: { assetId: { in: assetIds } } });
    await tx.contentBrief.deleteMany({ where: { projectId: s.projectId } });
    await tx.growthAsset.deleteMany({ where: { projectId: s.projectId } });
    await tx.opportunity.deleteMany({ where: { projectId: s.projectId } });
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
  const stamp = `cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-cw`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `CW ${stamp}` } });
    await tx.user.create({ data: { email, passwordHash, name: 'CW Client', type: 'client', clientId: client.id } });
    const project = await tx.project.create({ data: {
      name: `CW Project ${stamp}`, domain: `${stamp}.example`, clientId: client.id, onboardingStatus: 'active',
    } });
    const opportunity = await tx.opportunity.create({ data: {
      projectId: project.id, origin: 'editorial-idea', topic: `cw topic ${stamp}`, topicDisplay: `CW topic ${stamp}`,
      evidenceSourceFamily: 'manual-lookup', reason: 'Smoke fixture opportunity', measuredAt: new Date(),
    } });
    return { clientId: client.id, projectId: project.id, opportunityId: opportunity.id, email, password };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
OPP_ID=$(echo "$SEED" | jget opportunityId)
EMAIL=$(echo "$SEED" | jget email)
PW=$(echo "$SEED" | jget password)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "seeded project + client + editorial-idea opportunity" || die "seed" "$SEED"

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

# ── 1. Idempotent opportunity -> content conversion (P07's mechanism, reused) ──
IKEY="cw-idem-key-$(date +%s%N)"
request "convert opportunity (1st)" POST "/projects/$PID/opportunities/$OPP_ID/convert" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\"}"
CONVERT1="$BODY"
CREATED1=$(echo "$CONVERT1" | jget created)
ASSET_ID=$(echo "$CONVERT1" | jget asset.id)
[ "$CREATED1" = "true" ] && [ -n "$ASSET_ID" ] && [ "$ASSET_ID" != "__ERR__" ] && ok "first conversion created a new asset" || bad "first conversion did not report created:true: $CONVERT1"

request "convert opportunity (2nd, same key)" POST "/projects/$PID/opportunities/$OPP_ID/convert" "$TOKEN" 201 \
  -d "{\"idempotencyKey\":\"$IKEY\",\"assetType\":\"article\"}"
CONVERT2="$BODY"
CREATED2=$(echo "$CONVERT2" | jget created)
ASSET_ID_2=$(echo "$CONVERT2" | jget asset.id)
[ "$CREATED2" = "false" ] && [ "$ASSET_ID_2" = "$ASSET_ID" ] && ok "repeated conversion deduplicated — same asset, created:false" || bad "repeated conversion was NOT deduplicated: $CONVERT2"

# ── 2. Rename-safe ContentBrief version lineage (briefFamilyId) ────────────
request "create brief v1" POST "/projects/$PID/content-briefs" "$TOKEN" 201 \
  -d '{"title":"Original Brief Title","assetType":"article","angle":"Original angle"}'
BRIEF_V1="$BODY"
BRIEF_ID=$(echo "$BRIEF_V1" | jget id)
FAMILY_ID=$(echo "$BRIEF_V1" | jget briefFamilyId)
[ -n "$FAMILY_ID" ] && [ "$FAMILY_ID" != "__ERR__" ] && ok "brief v1 carries a briefFamilyId" || die "brief v1 family id" "$BRIEF_V1"

request "approve brief v1" PATCH "/projects/$PID/content-briefs/$BRIEF_ID" "$TOKEN" 200 -d '{"status":"approved"}'

# Rename AND change content in the same PATCH — forks v2, must stay in the SAME family.
request "rename + fork brief v2" PATCH "/projects/$PID/content-briefs/$BRIEF_ID" "$TOKEN" 200 \
  -d '{"title":"Renamed Brief Title","angle":"Updated angle after rename"}'
BRIEF_V2="$BODY"
FAMILY_ID_V2=$(echo "$BRIEF_V2" | jget briefFamilyId)
VERSION_V2=$(echo "$BRIEF_V2" | jget version)
[ "$FAMILY_ID_V2" = "$FAMILY_ID" ] && [ "$VERSION_V2" = "2" ] && ok "rename forked v2 IN THE SAME brief family (rename-safe)" || bad "rename severed/merged family history: v1 family=$FAMILY_ID, v2=$BRIEF_V2"

request "list brief versions (by original v1 id)" GET "/projects/$PID/content-briefs/$BRIEF_ID/versions" "$TOKEN" 200
VERSIONS_COUNT=$(echo "$BODY" | jlen versions)
[ "$VERSIONS_COUNT" = "2" ] && ok "both versions found under one family — history survived the rename" || bad "expected 2 versions, got $VERSIONS_COUNT: $BODY"

# ── 3. GrowthAsset identity is stable across a title rename too ────────────
CW_RENAME="{\"assetId\":\"$ASSET_ID\"}"
node -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
prisma.growthAsset.update({ where: { id: process.argv[1] }, data: { title: "Renamed Growth Asset Title" } })
  .then(() => prisma.$disconnect());
' "$ASSET_ID" >/dev/null 2>&1
request "content-workspace detail after GrowthAsset rename" GET "/projects/$PID/content-workspace/items/$ASSET_ID" "$TOKEN" 200
RENAMED_ID=$(echo "$BODY" | jget assetId)
RENAMED_TITLE=$(echo "$BODY" | jget title)
[ "$RENAMED_ID" = "$ASSET_ID" ] && [ "$RENAMED_TITLE" = "Renamed Growth Asset Title" ] && ok "GrowthAsset identity (id) unaffected by title rename" || bad "identity broke on rename: $BODY"

# ── 4. Explicit client-sharing state + revisions (operator-edit, no LLM cost) ──
request "save revision 1 (expectedVersion 0)" PATCH "/projects/$PID/growth-execution/assets/$ASSET_ID/content" "$TOKEN" 200 \
  -d '{"expectedVersion":0,"title":"Draft v1","body":"Body of the first revision.","fields":{}}'
REV1_ID=$(echo "$BODY" | jget current.id)
[ -n "$REV1_ID" ] && [ "$REV1_ID" != "__ERR__" ] && ok "revision 1 saved" || die "revision 1 save" "$BODY"

request "save revision 2 (expectedVersion 1)" PATCH "/projects/$PID/growth-execution/assets/$ASSET_ID/content" "$TOKEN" 200 \
  -d '{"expectedVersion":1,"title":"Draft v2 (new update in progress)","body":"Body of the second, unpublished revision.","fields":{}}'
REV2_ID=$(echo "$BODY" | jget current.id)
[ -n "$REV2_ID" ] && [ "$REV2_ID" != "__ERR__" ] && ok "revision 2 saved" || die "revision 2 save" "$BODY"

# Seed a Publication marking revision 1 as LIVE PUBLISHED (revision 2 stays unpublished).
PUB_SEED=$(CW_ASSET="$ASSET_ID" CW_PROJECT="$PID" CW_REV1="$REV1_ID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const dest = await prisma.publishDestination.create({ data: {
    projectId: process.env.CW_PROJECT, provider: 'custom-webhook', label: 'Smoke destination', status: 'connected',
  } });
  const pub = await prisma.publication.create({ data: {
    projectId: process.env.CW_PROJECT, destinationId: dest.id, assetId: process.env.CW_ASSET,
    revisionId: process.env.CW_REV1, mode: 'publish', status: 'published', remoteUrl: 'https://example.test/live-article',
  } });
  console.log(JSON.stringify({ destinationId: dest.id, publicationId: pub.id }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
) || die "publication seed failed" "$PUB_SEED"
ok "seeded a PUBLISHED placement pointing at revision 1 (older than the current draft, revision 2)"

# Revision 1 shared with the client; revision 2 stays private (default).
request "share revision 1 with client" POST "/projects/$PID/content-workspace/items/$ASSET_ID/revisions/$REV1_ID/share" "$TOKEN" 201

# ── 5. Four independent state axes: Published must not vanish while a new draft exists ──
request "content-workspace detail (published + in-progress)" GET "/projects/$PID/content-workspace/items/$ASSET_ID" "$TOKEN" 200
DETAIL="$BODY"
PUB_STATUS=$(echo "$DETAIL" | jget publicationSummary.status)
UPDATE_STATE=$(echo "$DETAIL" | jget updateState)
BADGE=$(echo "$DETAIL" | jget primaryBadge)
CLIENT_STATE=$(echo "$DETAIL" | jget clientReviewState)
CURRENT_VERSION=$(echo "$DETAIL" | jget currentVersion)
[ "$PUB_STATUS" = "published" ] && ok "publicationSummary.status = published (older revision live)" || bad "publicationSummary.status = $PUB_STATUS (expected published)"
[ "$UPDATE_STATE" = "revision-in-progress" ] && ok "updateState = revision-in-progress (newer unpublished draft exists)" || bad "updateState = $UPDATE_STATE (expected revision-in-progress)"
[ "$CURRENT_VERSION" = "2" ] && ok "currentVersion correctly reports the LATEST revision (2), not the published one" || bad "currentVersion = $CURRENT_VERSION (expected 2)"
echo "$BADGE" | grep -q "Published" && echo "$BADGE" | grep -q "Update in progress" && ok "primaryBadge is honest: '$BADGE' (Published never silently vanished)" || bad "primaryBadge lost a fact: '$BADGE'"
[ "$CLIENT_STATE" != "not-shared" ] && ok "clientReviewState reflects the explicit share ($CLIENT_STATE)" || bad "clientReviewState still not-shared after an explicit share"

# ── 6. Client portal: only the explicitly shared revision is ever readable ──
request "client portal content list" GET "/portal/projects/$PID/content" "$CLIENT_TOKEN" 200
CLIENT_LIST="$BODY"
LIST_HAS_ASSET=$(echo "$CLIENT_LIST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(String((o.items||[]).some(i=>i.assetId===process.argv[1])))})" "$ASSET_ID")
[ "$LIST_HAS_ASSET" = "true" ] && ok "client content list includes the shared piece" || bad "client content list missing the shared piece: $CLIENT_LIST"

request "client portal content detail" GET "/portal/projects/$PID/content/$ASSET_ID" "$CLIENT_TOKEN" 200
CLIENT_DETAIL="$BODY"
CLIENT_REV=$(echo "$CLIENT_DETAIL" | jget revision.revision)
CLIENT_TITLE=$(echo "$CLIENT_DETAIL" | jget revision.title)
[ "$CLIENT_REV" = "1" ] && [ "$CLIENT_TITLE" = "Draft v1" ] && ok "client sees ONLY the explicitly shared revision 1, never the unpublished revision 2" || bad "client detail leaked/served the wrong revision: $CLIENT_DETAIL"
HISTORY_LEN=$(echo "$CLIENT_DETAIL" | jlen history)
[ "$HISTORY_LEN" = "1" ] && ok "client history shows only the shared revision (1), not revision 2" || bad "client history length = $HISTORY_LEN (expected 1)"

# ── 7. A second, never-shared piece: 404s, not just filtered client-side ──
UNSHARED_SEED=$(CW_PROJECT="$PID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const asset = await prisma.growthAsset.create({ data: {
    projectId: process.env.CW_PROJECT, assetType: 'article', title: 'Never shared piece', brief: 'Smoke fixture, unshared.', status: 'in-progress',
  } });
  const rev = await prisma.contentRevision.create({ data: { assetId: asset.id, revision: 1, title: 'Private draft', body: 'Never shared.', clientVisible: false } });
  console.log(JSON.stringify({ assetId: asset.id, revisionId: rev.id }));
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
) || die "unshared fixture seed failed" "$UNSHARED_SEED"
UNSHARED_ASSET_ID=$(echo "$UNSHARED_SEED" | jget assetId)
[ -n "$UNSHARED_ASSET_ID" ] && [ "$UNSHARED_ASSET_ID" != "__ERR__" ] && ok "seeded a second piece with an unshared draft" || die "unshared seed" "$UNSHARED_SEED"

request "client portal detail on an unshared piece -> 404" GET "/portal/projects/$PID/content/$UNSHARED_ASSET_ID" "$CLIENT_TOKEN" 404
request "client portal list omits the unshared piece entirely" GET "/portal/projects/$PID/content" "$CLIENT_TOKEN" 200
LIST_HAS_UNSHARED=$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(String((o.items||[]).some(i=>i.assetId===process.argv[1])))})" "$UNSHARED_ASSET_ID")
[ "$LIST_HAS_UNSHARED" = "false" ] && ok "unshared piece is OMITTED from the client list (not just hidden client-side)" || bad "unshared piece leaked into the client list"

# ── 8. Capability matrix — real source-of-truth, not a frontend guess ──────
request "capability matrix" GET "/projects/$PID/content-workspace/capabilities" "$TOKEN" 200
ARTICLE_GEN=$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const r=(o.capabilities||[]).find(c=>c.assetType==='article');process.stdout.write(String(r&&r.generationImplemented))})")
SOCIAL_GEN=$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const r=(o.capabilities||[]).find(c=>c.assetType==='social-content');process.stdout.write(String(r&&r.generationImplemented))})")
SEOFIX_COUNTS=$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const r=(o.capabilities||[]).find(c=>c.assetType==='seo-fix');process.stdout.write(String(r&&r.countsAsContent))})")
[ "$ARTICLE_GEN" = "true" ] && [ "$SOCIAL_GEN" = "false" ] && ok "capability matrix: article implemented, social-content not (matches growth-execution.service.ts)" || bad "capability matrix wrong: article=$ARTICLE_GEN social=$SOCIAL_GEN"
[ "$SEOFIX_COUNTS" = "false" ] && ok "seo-fix correctly excluded from content counts" || bad "seo-fix countsAsContent = $SEOFIX_COUNTS (expected false)"

# ── 9. Canonical list: non-content types excluded from All content ─────────
node -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
prisma.growthAsset.create({ data: { projectId: process.argv[1], assetType: "seo-fix", title: "Fix the h1 tag", brief: "Smoke fixture.", status: "recommended" } })
  .then(() => prisma.$disconnect());
' "$PID" >/dev/null 2>&1
request "workspace list (All content)" GET "/projects/$PID/content-workspace/items?pageSize=50" "$TOKEN" 200
LIST_TYPES=$(echo "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write((o.items||[]).map(i=>i.assetType).join(','))})")
echo "$LIST_TYPES" | grep -q "seo-fix" && bad "seo-fix leaked into the content workspace list: $LIST_TYPES" || ok "seo-fix excluded from the content workspace list (types seen: $LIST_TYPES)"
TOTAL=$(echo "$BODY" | jget total)
[ "$TOTAL" = "2" ] && ok "All content count is exactly the 2 real content pieces (placements never inflate it)" || bad "All content total = $TOTAL (expected 2)"

echo ""
echo "== content-workspace smoke: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1

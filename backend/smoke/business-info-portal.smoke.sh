#!/usr/bin/env bash
# E2E smoke — P02 "Business information" (business-profile module):
# client-safe overview reads, rejection memory surviving a recrawl, confirm
# writing a new immutable version, and cross-client isolation.
#
# Seed via Prisma, not project HTTP creation (which starts paid/background
# onboarding jobs). Exercise the real auth/portal/staff HTTP surfaces.
set -uo pipefail
source "$(dirname "$0")/_common.sh"
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
die() { bad "$1"; echo "$2"; exit 1; }

echo "== business-info-portal smoke =="

SEED='{}'
cleanup() {
  BIZINFO_SEED="$SEED" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const s = JSON.parse(process.env.BIZINFO_SEED);
  if (!s.projectId) return;
  await prisma.$transaction(async (tx) => {
    await tx.businessProfileRejection.deleteMany({ where: { projectId: s.projectId } });
    await tx.businessProfile.deleteMany({ where: { projectId: s.projectId } });
    await tx.siteContext.deleteMany({ where: { projectId: s.projectId } });
    await tx.project.deleteMany({ where: { id: s.projectId } });
    const clientId = { in: [s.clientId, s.otherClientId] };
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
  const stamp = `bizinfo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${stamp}@example.test`;
  const otherEmail = `other-${stamp}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-bizinfo`;
  const passwordHash = await bcryptjs.hash(password, 10);
  const operator = await prisma.user.upsert({
    where: { email: process.env.SMOKE_EMAIL }, update: {},
    create: { email: process.env.SMOKE_EMAIL,
      passwordHash: await bcryptjs.hash(process.env.SMOKE_PW, 10),
      name: 'Swarm Smoke', role: 'admin', type: 'operator' },
  });
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { name: `BizInfo ${stamp}` } });
    const otherClient = await tx.client.create({ data: { name: `Other BizInfo ${stamp}` } });
    const user = await tx.user.create({ data: {
      email, passwordHash, name: 'BizInfo Client', type: 'client', clientId: client.id,
    } });
    await tx.user.create({ data: {
      email: otherEmail, passwordHash, name: 'Other BizInfo Client', type: 'client', clientId: otherClient.id,
    } });
    const project = await tx.project.create({ data: {
      name: `BizInfo Project ${stamp}`, domain: `${stamp}.example`,
      clientId: client.id, onboardingStatus: 'pending',
    } });
    // A confirmed version 1 — brandName/services/markets differ from what the
    // site currently says, so the site context below suggests changes to them.
    const confirmed = await tx.businessProfile.create({ data: {
      projectId: project.id, version: 1,
      brandName: 'Acme Inc', description: 'We do consulting.',
      services: JSON.stringify(['Consulting']),
      markets: JSON.stringify(['US']),
      icp: JSON.stringify({ segments: ['SMBs'], roles: [], painPoints: [] }),
      confirmedBy: operator.id, confirmedAt: new Date(),
    } });
    // The extracted candidate — disagrees on brandName/description/services/markets/icp.
    const ctx = await tx.siteContext.create({ data: {
      projectId: project.id, domain: project.domain, brand: 'Acme LLC',
      description: 'We help businesses grow online.',
      services: JSON.stringify(['Consulting', 'Coaching']),
      markets: JSON.stringify(['US', 'CA']),
      icp: JSON.stringify(['SMBs', 'Startups']),
      painPoints: JSON.stringify(['Low visibility']),
      pageUrls: JSON.stringify([`https://${project.domain}/about`]),
      pagesFetched: 3, extraction: 'llm-synthesized', llmModel: 'BIZINFO_PRIVATE_MODEL',
      costUsd: 1.23,
    } });
    return { clientId: client.id, otherClientId: otherClient.id, projectId: project.id,
      confirmedId: confirmed.id, ctxId: ctx.id, operatorId: operator.id,
      email, otherEmail, password };
  });
  console.log(JSON.stringify(result));
})().catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
EOF
) || die "seed failed" "$SEED"

PID=$(echo "$SEED" | jget projectId)
[ -n "$PID" ] && [ "$PID" != "__ERR__" ] && ok "seeded confirmed profile v1 + disagreeing site context" || die "seed" "$SEED"
EMAIL=$(echo "$SEED" | jget email)
OTHER_EMAIL=$(echo "$SEED" | jget otherEmail)
PW=$(echo "$SEED" | jget password)

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
CLIENT_TOKEN=$(login "$EMAIL" "$PW" | jget accessToken)
[ -n "$CLIENT_TOKEN" ] && [ "$CLIENT_TOKEN" != "__ERR__" ] && ok "client login works" || die "client login" "-"
OTHER_TOKEN=$(login "$OTHER_EMAIL" "$PW" | jget accessToken)
[ -n "$OTHER_TOKEN" ] && [ "$OTHER_TOKEN" != "__ERR__" ] && ok "other client login works" || die "other client login" "-"
TOKEN=$(smoke_auth)
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "staff login works" || die "staff login" "-"

# Client-safe recursive allowlist: no run id, no model name, no cost, no
# operator actor id anywhere in the overview response.
assert_overview_allowlisted() {
  local label="$1" body="$2" issues
  issues=$(BIZINFO_BODY="$body" node - <<'EOF'
const scalar = null;
const fields = (names) => Object.fromEntries(names.split(' ').map((k) => [k, scalar]));
const confirmedField = fields('field label value');
const suggestion = fields('field section label currentValue suggestedValue sourcePage sourceDate');
const gap = fields('field section label');
const version = fields('id version state confirmedAt createdAt');
const section = { key: scalar, label: scalar, confirmed: [confirmedField], suggestions: [suggestion], gaps: [gap] };
const shape = { projectId: scalar, profileState: scalar, confirmedVersion: version, sections: [section], suppressedRejectedCount: scalar, hasSiteContext: scalar, sourceCheckedAt: scalar };
const errors = [];
function walk(value, s, path) {
  if (s === null) {
    // value/currentValue/suggestedValue are string | string[] | null — an
    // array of primitives is still a leaf here, just not an array of objects.
    if (Array.isArray(value)) { if (value.some((v) => v !== null && typeof v === 'object')) errors.push(`${path} (array of objects not allowed)`); return; }
    if (value !== null && typeof value === 'object') errors.push(`${path} (expected scalar)`);
    return;
  }
  if (Array.isArray(s)) { if (!Array.isArray(value)) { errors.push(`${path} (expected array)`); return; } value.forEach((e, i) => walk(e, s[0], `${path}[${i}]`)); return; }
  if (value === null) return; // confirmedVersion may be null
  if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} (expected object)`); return; }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(s, key)) errors.push(`${path}.${key}`);
    else walk(value[key], s[key], `${path}.${key}`);
  }
}
try { walk(JSON.parse(process.env.BIZINFO_BODY), shape, '$'); }
catch (e) { errors.push(`$ (invalid JSON: ${e.message})`); }
console.log(errors.join('\n'));
process.exitCode = errors.length ? 1 : 0;
EOF
) && ok "$label recursive allowlist (no run id/model/cost/confirmedBy)" || { bad "$label recursive allowlist"; printf '%s\n' "$issues"; }

  if echo "$body" | grep -Eiq '"(llmModel|costUsd|pagesFetched|extraction)"[[:space:]]*:'; then
    bad "$label forbidden internal JSON key present"
  else ok "$label no forbidden internal JSON keys"; fi
  if echo "$body" | grep -Fq "BIZINFO_PRIVATE_MODEL"; then
    bad "$label private model name leaked"
  else ok "$label no private model name leaked"; fi
  if echo "$body" | grep -Fq "$(echo "$SEED" | jget operatorId)"; then
    bad "$label operator actor id leaked"
  else ok "$label no operator actor id leaked"; fi
}

request "client overview" GET "/portal/projects/$PID/business-profile/overview" "$CLIENT_TOKEN" 200
OVERVIEW1="$BODY"
assert_overview_allowlisted "client overview" "$OVERVIEW1"
[ "$(echo "$OVERVIEW1" | jget profileState)" = "confirmed" ] && ok "profile starts confirmed (no draft yet)" || bad "unexpected initial profileState"
[ "$(echo "$OVERVIEW1" | jget confirmedVersion.version)" = "1" ] && ok "confirmedVersion is version 1" || bad "wrong confirmedVersion"

# The "about" section's brandName suggestion should be present (Acme LLC != Acme Inc).
ABOUT_SUGGESTIONS=$(echo "$OVERVIEW1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const about=o.sections.find(x=>x.key==="about");process.stdout.write(JSON.stringify(about.suggestions))})')
echo "$ABOUT_SUGGESTIONS" | grep -q '"field":"brandName"' && ok "brandName suggestion present before rejection" || bad "expected brandName suggestion"
echo "$ABOUT_SUGGESTIONS" | grep -q '"suggestedValue":"Acme LLC"' && ok "suggested brandName value is what the site says" || bad "wrong suggested brandName"

request "staff overview" GET "/projects/$PID/business-profile/overview" "$TOKEN" 200
assert_overview_allowlisted "staff overview" "$BODY"

# Reject the brandName suggestion as the client ("Keep current").
request "client reject brandName" POST "/portal/projects/$PID/business-profile/candidates/reject" "$CLIENT_TOKEN" 200 \
  -d '{"field":"brandName"}'
[ "$(echo "$BODY" | jget rejected)" = "true" ] && ok "reject call acknowledges the decline" || bad "reject response malformed"

request "client overview after reject" GET "/portal/projects/$PID/business-profile/overview" "$CLIENT_TOKEN" 200
OVERVIEW2="$BODY"
ABOUT2=$(echo "$OVERVIEW2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const about=o.sections.find(x=>x.key==="about");process.stdout.write(JSON.stringify(about.suggestions))})')
echo "$ABOUT2" | grep -q '"field":"brandName"' && bad "brandName suggestion resurfaced right after being rejected" || ok "brandName suggestion withheld immediately after rejection"
[ "$(echo "$OVERVIEW2" | jget suppressedRejectedCount)" -ge "1" ] 2>/dev/null && ok "suppressedRejectedCount reflects the rejection" || bad "suppressedRejectedCount did not increase"

# Simulate a recrawl: a NEW SiteContext row is written with the SAME brand
# value. This is the exit-gate behavior: "client correction survives recrawl."
RECRAWL_SEED=$(BIZINFO_PID="$PID" node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const projectId = process.env.BIZINFO_PID;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  await prisma.siteContext.create({ data: {
    projectId, domain: project.domain, brand: 'Acme LLC', // identical value — must stay suppressed
    description: 'We help businesses grow online, worldwide.', // genuinely changed — must resurface
    services: JSON.stringify(['Consulting', 'Coaching']),
    markets: JSON.stringify(['US', 'CA']),
    icp: JSON.stringify(['SMBs', 'Startups']),
    pageUrls: JSON.stringify([`https://${project.domain}/about`]),
    pagesFetched: 4, extraction: 'deterministic',
  } });
  console.log('ok');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
EOF
)
[ "$RECRAWL_SEED" = "ok" ] && ok "simulated recrawl (new SiteContext row, same brand value)" || die "recrawl seed failed" "$RECRAWL_SEED"

request "client overview after recrawl" GET "/portal/projects/$PID/business-profile/overview" "$CLIENT_TOKEN" 200
OVERVIEW3="$BODY"
ABOUT3=$(echo "$OVERVIEW3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const about=o.sections.find(x=>x.key==="about");process.stdout.write(JSON.stringify(about.suggestions))})')
echo "$ABOUT3" | grep -q '"field":"brandName"' && bad "identical rejected value resurfaced after recrawl" || ok "identical rejected brandName value still withheld after recrawl"
echo "$ABOUT3" | grep -q '"field":"description"' && ok "genuinely changed description still suggested after recrawl" || bad "changed description should still be suggested"

# A field with no suggestion source at all (legalName — nothing in
# SiteContext extracts it) -> 404, and an unknown field -> 400 (DTO validation).
request "reject field with no suggestion source" POST "/portal/projects/$PID/business-profile/candidates/reject" "$CLIENT_TOKEN" 404 \
  -d '{"field":"legalName"}'
request "reject unknown field" POST "/portal/projects/$PID/business-profile/candidates/reject" "$CLIENT_TOKEN" 400 \
  -d '{"field":"notAField"}'

# Accept the description suggestion into the draft, then confirm -> new version.
request "client save draft (accept description)" PUT "/portal/projects/$PID/business-profile" "$CLIENT_TOKEN" 200 \
  -d '{"description":"We help businesses grow online, worldwide."}'
[ "$(echo "$BODY" | jget profile.isDraft)" = "true" ] && ok "accepting a suggestion creates a draft, not a fact" || bad "accept should produce a draft"

request "client confirm draft" POST "/portal/projects/$PID/business-profile/confirm" "$CLIENT_TOKEN" 200 -d '{}'
# The save above forked a new draft (version 2) from confirmed version 1;
# confirming that INSERTs yet another row (version 3) rather than stamping
# either version 1 or version 2 — see business-profile.service.ts#confirm.
CONFIRM_VERSION=$(echo "$BODY" | jget profile.version)
[ "$CONFIRM_VERSION" = "3" ] && ok "confirm wrote a NEW version (3), not an edit of version 1 or 2" || bad "confirm did not create version 3 (got $CONFIRM_VERSION)"

# Old confirmed version 1 must be unaffected by the later draft/confirm cycle.
request "staff read version 1" GET "/projects/$PID/business-profile?version=1" "$TOKEN" 200
[ "$(echo "$BODY" | jget profile.data.description)" = "We do consulting." ] && ok "confirmed version 1's data is untouched by the later confirmation" || bad "version 1 was mutated"

# Downstream rebuild is still explicit-only: confirming propagated nothing.
request "explicit rebuild dry run" POST "/projects/$PID/business-profile/rebuild" "$TOKEN" 200 \
  -d '{"targets":["project-competitors"],"reason":"smoke check","dryRun":true}'
[ "$(echo "$BODY" | jget dryRun)" = "true" ] && ok "rebuild remains an explicit, separate act from confirm" || bad "rebuild response malformed"

# Cross-client isolation: the other client sees none of this. This module's
# scope guard reports a foreign project as 403 (documented in its README:
# "the client portal returns 403 for another client's project"), not 404.
request "other client overview" GET "/portal/projects/$PID/business-profile/overview" "$OTHER_TOKEN" 403
echo "$BODY" | grep -Eq "($PID|Acme|BIZINFO)" && bad "other client response disclosed project data" || ok "other client overview discloses nothing"
request "other client reject" POST "/portal/projects/$PID/business-profile/candidates/reject" "$OTHER_TOKEN" 403 \
  -d '{"field":"brandName"}'

echo
echo "business-info-portal smoke: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

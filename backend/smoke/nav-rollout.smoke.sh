#!/usr/bin/env bash
# P16 smoke — final navigation and copy rollout (platform_improvement_plan.md
# §3.2 staff project navigation, §3.3 client navigation, §3.4 portfolio and
# administration, §4.3 language dictionary, §4.5 interaction and
# accessibility, §20.3 migration convention).
#
# §20.2 P16 exit gate: "No broken legacy deep links; nontechnical tasks
# succeed."
#
# What this proves, and how:
#
#   1. §20.3 — every retired route is still a redirect, and every redirect
#      target is a route this app serves. The redirects are enumerated from the
#      tree (`src/app/**/page.tsx` that call `redirect(`), not from a list in
#      the plan, so a stub deleted tomorrow fails here without anyone having to
#      update a list; the §20.3 register is then asserted by name on top of
#      that, and a redirect whose target is itself a stub (a chain) is a
#      failure rather than a pass.
#   2. §3.2/§3.3/§3.4 — the nav trees are data (`src/lib/navigation.ts`), so
#      the structure the plan specifies is read and compared to it: the Team
#      tools group with its collapse settings, the client's five primary
#      destinations, the renamed admin entries, and the staff-only research and
#      evidence surfaces §22 keeps.
#   3. §4.3 — the banned vocabulary is scanned for in every source file a
#      client screen can render (the client tree's import closure), looking
#      only at text a reader can see: JSX text and prose-like strings, with
#      comments removed. Identifiers, props and hrefs are ignored by design —
#      §4.3 is a visible-label dictionary, not an API/DB/TS rename.
#   4. §3.3/§4.5 — the rules that are decidable from source: no all-clients
#      surface in the client tree, one-project clients landing in their
#      project, scrollable regions being focusable and named, a status not
#      carried by colour alone, and no control claiming an ARIA pattern it does
#      not implement.
#
# Every assertion names the exact route, label or attribute it requires, so
# each one can fail. Nothing here needs the API: the checks read the files that
# define these behaviours. The one section that needs a running web server —
# the live redirect hop — is reported as SKIP, never as PASS, when nothing
# answers at $WEB_BASE.
#
# Run from backend/:
#   bash smoke/nav-rollout.smoke.sh
#   WEB_BASE=http://localhost:3010 bash smoke/nav-rollout.smoke.sh   # + live hop
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
WEB_ROOT="${WEB_ROOT:-../web}"
WEB_BASE="${WEB_BASE:-http://localhost:3010}"
NODE="${NODE:-node}"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

# Check programs print `PASS <message>` / `FAIL <message>` lines, plus free
# text that is echoed indented. Counted through a file rather than a pipe, so
# the counters are incremented in this shell and not in a subshell.
emit() {
  local line
  while IFS= read -r line; do
    case "$line" in
      "PASS "*) ok "${line#PASS }" ;;
      "FAIL "*) bad "${line#FAIL }" ;;
      *) [ -n "$line" ] && echo "        $line" ;;
    esac
  done
}

# A check that produces no assertions (because it crashed) must not read as a
# clean run.
ran() { # $1 = file, $2 = label, $3 = minimum assertions
  local n
  n=$(grep -c -e '^PASS ' -e '^FAIL ' "$1" 2>/dev/null || true)
  [ -n "$n" ] || n=0
  if [ "$n" -ge "$3" ]; then ok "$2 ($n assertions)"
  else bad "$2 produced only $n assertions — the check itself is broken"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/routes.js" <<'ROUTES_JS'
// §20.3 retired-route check (P16 smoke).
//
// The retired routes are enumerated from the tree, not from a list in the plan:
// every `src/app/**/page.tsx` that calls `redirect(` is a stub, and its target
// must be a route that still exists. Run from `backend/` with the web root as
// argv[2] (`$WEB_ROOT`).
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.resolve(process.argv[2] || '../web');
const APP = path.join(WEB_ROOT, 'src', 'app');
const out = [];
const pass = (m) => out.push('PASS ' + m);
const fail = (m) => out.push('FAIL ' + m);

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

let files;
try {
  files = walk(APP, []);
} catch (e) {
  console.log('FAIL  cannot read ' + APP + ' (' + e.message + ')');
  process.exit(1);
}
const pages = files.filter((f) => f.endsWith(path.sep + 'page.tsx')).sort();

// ── The URLs this app serves, derived from the file tree ────────────────────
// A route group `(ops)` is not part of the URL, so it is dropped; a dynamic
// segment `[projectId]` matches any concrete value in a redirect target.
function urlOf(file) {
  const rel = path.relative(APP, file).split(path.sep);
  rel.pop();
  return '/' + rel.filter((s) => !/^\(.*\)$/.test(s)).join('/');
}
const urls = new Set(pages.map(urlOf));

/** The URL in `candidates` that serves `target`, or `null`. A `[dynamic]`
 *  segment on either side matches any single segment. */
function matchRoute(candidates, target) {
  const t = target.split('/').filter(Boolean);
  for (const u of candidates) {
    const segs = u.split('/').filter(Boolean);
    if (segs.length !== t.length) continue;
    let same = true;
    for (let i = 0; i < segs.length; i += 1) {
      if (/^\[.+\]$/.test(segs[i]) || /^\[.+\]$/.test(t[i])) continue;
      if (segs[i] !== t[i]) { same = false; break; }
    }
    if (same) return u;
  }
  return null;
}

const allUrls = [...urls];
function routeExists(target) {
  return matchRoute(allUrls, target) !== null;
}

if (urls.size >= 100) pass(`the route tree parses: ${urls.size} page routes found`);
else fail(`only ${urls.size} page routes found — the tree walk is broken, not the app`);

// ── Redirects found in the tree ─────────────────────────────────────────────
// A target is normalised first: `${projectId}` and friends become `[projectId]`
// so it can be matched against the URL set, and the query string is dropped.
function normalise(expr) {
  return expr.replace(/\$\{[^}]*\}/g, '[projectId]').split('?')[0].replace(/\/$/, '') || '/';
}

const redirects = [];
for (const file of pages) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('redirect(')) continue;
  const rel = path.relative(APP, file).split(path.sep).join('/');
  const re = /redirect\(\s*(?:await\s+)?([`'"])((?:[^`'"\\]|\\.)*?)\1\s*\)/g;
  let m;
  let found = 0;
  while ((m = re.exec(src)) !== null) {
    found += 1;
    redirects.push({
      rel,
      url: urlOf(file),
      raw: m[2],
      target: normalise(m[2]),
      // A stub is a page whose only job is to send the reader elsewhere: no
      // client bundle, no markup.
      stub: !src.includes('use client') && !/<[A-Za-z/]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    });
  }
  if (found === 0) {
    fail(`${rel} calls redirect() in a form this check cannot read`);
  }
}

if (redirects.length >= 9) pass(`${redirects.length} redirect routes enumerated from the tree`);
else fail(`only ${redirects.length} redirect routes found — expected the 9 retired ones`);

const stubTargets = redirects.filter((r) => r.stub && r.rel !== 'page.tsx').map((r) => r.url);
for (const r of redirects) {
  if (routeExists(r.target)) pass(`${r.rel} -> ${r.target} (route exists)`);
  else fail(`${r.rel} -> ${r.target}: NO ROUTE SERVES THAT PATH`);
}
for (const r of redirects) {
  if (r.rel === 'page.tsx') continue; // the site root, not a retired route
  if (r.stub) pass(`${r.rel} is a redirect stub, not a restored screen`);
  else fail(`${r.rel} renders markup as well as redirecting — §20.3 keeps retired routes as stubs`);
}

// A target that is itself a stub would be a redirect chain (a deep link that
// takes two hops, or a loop). §20.3 wants one hop to a real screen.
for (const r of redirects) {
  if (r.rel === 'page.tsx') continue;
  const chained = matchRoute(stubTargets, r.target);
  if (!chained) continue;
  fail(`${r.rel} -> ${r.target} is a redirect chain: ${chained} is itself a stub`);
}

// ── The §20.3 register, named explicitly ────────────────────────────────────
// Enumerating from the tree proves every redirect resolves; this list proves
// the specific routes the plan retired are still the ones doing it. If a stub
// is deleted the route 404s for every bookmark that points at it, which is the
// failure §20.3's exit gate is about.
const RETIRED = [
  ['(ops)/projects/[projectId]/content/calendar', '/projects/[projectId]/calendar'],
  ['(ops)/projects/[projectId]/content/generate', '/projects/[projectId]/content'],
  ['(ops)/projects/[projectId]/content/page-analysis', '/projects/[projectId]/research/website/page-analysis'],
  ['(ops)/projects/[projectId]/research/context', '/projects/[projectId]/business-info'],
  ['(ops)/projects/[projectId]/research/presence/insights', '/projects/[projectId]/research/presence'],
  ['(ops)/projects/[projectId]/research/prompts', '/projects/[projectId]/research/ai/sets'],
  ['(ops)/projects/[projectId]/research/prompts/[setId]', '/projects/[projectId]/research/ai/sets/[projectId]'],
  ['(ops)/projects/[projectId]/research/search', '/projects/[projectId]/research/website'],
  ['(ops)/projects/[projectId]/research/traffic', '/projects/[projectId]/research/website'],
];
for (const [rel, expected] of RETIRED) {
  const file = path.join(APP, rel, 'page.tsx');
  if (!fs.existsSync(file)) {
    fail(`retired route ${rel} has no page file — the deep link now 404s`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/redirect\(\s*(?:await\s+)?([`'"])((?:[^`'"\\]|\\.)*?)\1\s*\)/);
  if (!m) {
    fail(`retired route ${rel} no longer redirects`);
    continue;
  }
  const got = normalise(m[2]);
  if (got === expected) pass(`retired ${rel} still lands on ${expected}`);
  else fail(`retired ${rel} now redirects to ${got}, not ${expected}`);
  if (routeExists(got)) pass(`  ... and ${got} is a route this app serves`);
  else fail(`  ${rel} redirects to ${got}, which no route serves`);
}

// ── §16.2 S02: the full action queue behind Overview's three cards ─────────
// Overview shows at most three items (§5.1); "View all" must lead to the
// *full* queue, not to a related-but-different screen. That was the original
// defect here: both audiences' links pointed at the plan/cycles screens, which
// list some of the same work but are not the queue.
for (const rel of [
  '(client)/client/projects/[projectId]/actions',
  '(ops)/projects/[projectId]/actions',
]) {
  const file = path.join(APP, rel, 'page.tsx');
  if (fs.existsSync(file)) pass(`§16.2 S02 ${rel} exists`);
  else fail(`§16.2 S02 ${rel} is missing — "View all" has nowhere to land`);
}

const overviewSvc = path.join(WEB_ROOT, '..', 'backend/src/modules/results/overview.service.ts');
if (fs.existsSync(overviewSvc)) {
  const src = fs.readFileSync(overviewSvc, 'utf8');
  const hrefs = [...src.matchAll(/buildActionPanel\([^)]*?,\s*[^,]*,\s*`([^`]+)`/g)].map((m) => m[1]);
  if (hrefs.length < 2) {
    fail(`overview.service.ts: expected two action panels (client + staff), found ${hrefs.length}`);
  } else {
    for (const href of hrefs) {
      if (/\/actions$/.test(href)) pass(`"View all" lands on the full queue: ${href}`);
      else fail(`"View all" points at ${href} — not the full action queue (§16.2 S02)`);
    }
  }
} else {
  fail('overview.service.ts not found — cannot check the "View all" destination');
}

// §20.3 is "keep the route, redirect it" — never "delete it", so a retired
// route must not have been quietly re-implemented either.
console.log(out.join('\n'));
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
ROUTES_JS
cat > "$TMP/nav.js" <<'NAV_JS'
// §3.2 / §3.3 / §3.4 navigation-structure check (P16 smoke).
//
// The nav trees are data (`src/lib/navigation.ts`), so the structure the plan
// specifies is assertable without rendering anything. Run from `backend/` with
// the web root as argv[2] (`$WEB_ROOT`).
//
// Every assertion names the exact label, flag or href it requires, so a missing
// group, a renamed label or a dropped entry fails here rather than in review.
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.resolve(process.argv[2] || '../web');
const SRC = path.join(WEB_ROOT, 'src');
const NAV_FILE = path.join(SRC, 'lib', 'navigation.ts');

const out = [];
const pass = (m) => out.push('PASS ' + m);
const fail = (m) => out.push('FAIL ' + m);
const finish = () => {
  console.log(out.join('\n'));
  process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
};

let navSrc;
try {
  navSrc = fs.readFileSync(NAV_FILE, 'utf8');
} catch (e) {
  fail('cannot read ' + NAV_FILE + ' (' + e.message + ')');
  finish();
}

// ── A reader for the literal arrays in navigation.ts ────────────────────────
// Comments are replaced by spaces first so a commented-out entry cannot be
// mistaken for a live one, and so the parser never has to skip them.
function stripComments(s) {
  let out2 = '';
  let i = 0;
  let mode = null;
  while (i < s.length) {
    const c = s[i];
    const nxt = i + 1 < s.length ? s[i + 1] : '';
    if (mode === null) {
      if (c === '/' && nxt === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && nxt === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        out2 += c;
        i += 1;
        while (i < s.length) {
          if (s[i] === '\\') { out2 += s[i] + s[i + 1]; i += 2; continue; }
          out2 += s[i];
          if (s[i] === q) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      out2 += c;
      i += 1;
    } else if (mode === 'line') {
      if (c === '\n') { mode = null; out2 += c; }
      i += 1;
    } else {
      if (c === '*' && nxt === '/') { mode = null; i += 2; continue; }
      out2 += c === '\n' ? '\n' : ' ';
      i += 1;
    }
  }
  return out2;
}
const src = stripComments(navSrc);

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

function readString(s, i) {
  const q = s[i];
  let v = '';
  i += 1;
  while (i < s.length) {
    if (s[i] === '\\') { v += s[i + 1]; i += 2; continue; }
    if (s[i] === q) return [v, i + 1];
    v += s[i];
    i += 1;
  }
  return [v, i];
}

function parseValue(s, start) {
  let i = skipWs(s, start);
  const c = s[i];
  if (c === '[' || c === '{') {
    const isArr = c === '[';
    const close = isArr ? ']' : '}';
    const acc = isArr ? [] : {};
    i += 1;
    while (i < s.length) {
      i = skipWs(s, i);
      if (s[i] === close) return [acc, i + 1];
      if (s[i] === ',') { i += 1; continue; }
      if (isArr) {
        const [v, j] = parseValue(s, i);
        acc.push(v);
        i = j;
        continue;
      }
      let key;
      if (s[i] === '"' || s[i] === "'") {
        const [k, j] = readString(s, i);
        key = k;
        i = j;
      } else {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j += 1;
        key = s.slice(i, j);
        i = j;
      }
      i = skipWs(s, i);
      if (s[i] === ':') {
        const [v, j] = parseValue(s, i + 1);
        acc[key] = v;
        i = j;
      } else {
        acc[key] = true; // shorthand
      }
    }
    return [acc, i];
  }
  if (c === '"' || c === "'" || c === '`') return readString(s, i);
  let j = i;
  let depth = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    j += 1;
  }
  const text = s.slice(i, j).trim();
  if (text === 'true') return [true, j];
  if (text === 'false') return [false, j];
  if (/^-?[\d.]+$/.test(text)) return [Number(text), j];
  return [{ $expr: text }, j];
}

function extractArray(name) {
  const m = new RegExp('(?:export )?const\\s+' + name + '\\b').exec(src);
  if (!m) return null;
  const eq = src.indexOf('=', m.index + m[0].length);
  if (eq < 0) return null;
  let i = eq + 1;
  while (i < src.length && src[i] !== '[') i += 1;
  if (i >= src.length) return null;
  return parseValue(src, i)[0];
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(condition, message) {
  if (condition) pass(message);
  else fail(message);
}
function checkEq(actual, expected, message) {
  check(eq(actual, expected), `${message} — got ${JSON.stringify(actual)}`);
}

const labels = (items) => (items || []).map((it) => (it && it.label) || '?');
const sectionLabels = (tree) => tree.map((s) => s.label || '');

const PROJECT_NAV = extractArray('PROJECT_NAV');
const OPERATOR_NAV = extractArray('OPERATOR_NAV');
const CLIENT_NAV = extractArray('CLIENT_NAV');
const CLIENT_PROJECT_NAV = extractArray('CLIENT_PROJECT_NAV');
const STAFF_GROUPS = extractArray('STAFF_GROUPS');

// ── Anti-vacuity: if the parser found nothing, nothing below means anything ──
check(Array.isArray(PROJECT_NAV) && PROJECT_NAV.length >= 5, `PROJECT_NAV parses into ${PROJECT_NAV ? PROJECT_NAV.length : 0} sections`);
check(Array.isArray(OPERATOR_NAV) && OPERATOR_NAV.length === 2, `OPERATOR_NAV parses into ${OPERATOR_NAV ? OPERATOR_NAV.length : 0} sections`);
check(Array.isArray(CLIENT_PROJECT_NAV) && CLIENT_PROJECT_NAV.length === 1, 'CLIENT_PROJECT_NAV parses');
check(Array.isArray(CLIENT_NAV) && CLIENT_NAV.length === 1, 'CLIENT_NAV parses');
check(Array.isArray(STAFF_GROUPS) && STAFF_GROUPS.length === 2, 'STAFF_GROUPS parses');
if (out.some((l) => l.startsWith('FAIL'))) finish();

// ── §3.4 portfolio navigation (the operator tree) ───────────────────────────
checkEq(labels(OPERATOR_NAV[0].items), ['Today', 'Clients', 'My Work', 'Content calendar', 'Reports', 'Sales'],
  '§3.4 portfolio nav is Today, Clients, My Work, Content calendar, Reports, Sales');
checkEq(OPERATOR_NAV[1].label, 'Administration', 'the portfolio tree keeps an Administration group');
checkEq(labels(OPERATOR_NAV[1].items),
  ['People and access', 'Service connections', 'Score settings', 'Spending limits', 'Activity history', 'Templates', 'Organization'],
  '§3.4 admin labels are People and access, Service connections, Score settings, Spending limits, Activity history, Templates, Organization');

// ── §3.2 staff project navigation ───────────────────────────────────────────
checkEq(sectionLabels(PROJECT_NAV), ['', 'Performance', 'Content', '', 'Team tools', ''],
  '§3.2 project nav sections are (unnamed), Performance, Content, (unnamed), Team tools, (unnamed)');
checkEq(labels(PROJECT_NAV[0].items), ['Overview', 'Plan', 'Content calendar'],
  '§3.2 project nav starts with Overview, Plan, Content calendar');
checkEq(labels(PROJECT_NAV[1].items), ['Website', 'AI visibility', 'Online presence', 'Competitors'],
  '§3.2 Performance holds Website, AI visibility, Online presence, Competitors');
checkEq(labels(PROJECT_NAV[2].items), ['All content', 'Writing style', 'Update existing content', 'Ideas workspace'],
  '§3.2 Content holds one workspace plus writing style and the two secondary destinations');
checkEq(PROJECT_NAV[2].items.filter((it) => it.secondary).map((it) => it.label),
  ['Update existing content', 'Ideas workspace'], 'the two secondary Content destinations are secondary: true');
checkEq(labels(PROJECT_NAV[3].items), ['Reports', 'Business information', 'Connected accounts'],
  '§3.2 keeps Reports, Business information, Connected accounts between Content and Team tools');
checkEq(labels(PROJECT_NAV[5].items), ['Project settings'], 'Project settings stays last, outside Team tools');

const team = PROJECT_NAV[4];
checkEq(labels(team.items),
  ['My work / team work', 'Delivery cycles', 'Review queue', 'Monitoring and schedules',
    'Authority and outreach', 'Outreach campaigns', 'Backlinks', 'Mention health'],
  'the Team tools group holds the eight staff destinations');
check(team.collapsible === true, '§3.2 Team tools is a collapsible group');
check(team.defaultCollapsed === true, '§3.2 Team tools starts collapsed');
checkEq(team.persistKey, 'team-tools', '§3.2 Team tools remembers its state under a stable persistKey');
const myWork = team.items.find((it) => it.label === 'My work / team work');
check(Boolean(myWork) && myWork.absolute === true && myWork.href === '/ops/work',
  '§3.2 "My work / team work" points at the portfolio work inbox, not a project route');

// ── The three rules §3.2's tree must not break ─────────────────────────────
const flatProject = (tree) => tree.flatMap((s) => [...s.items, ...((s.groups || []).flatMap((g) => g.items))]);
const allProjectItems = flatProject(PROJECT_NAV);
check(!allProjectItems.some((it) => /needs your action/i.test(it.label || '')),
  'there is no duplicate "Needs your action" nav item (§3.2 puts that in Overview and the work inbox)');
const projectLabels = allProjectItems.map((it) => it.label);
check(new Set(projectLabels).size === projectLabels.length,
  'no destination appears twice in the project tree');
const projectHrefs = allProjectItems.map((it) => it.href);
check(new Set(projectHrefs).size === projectHrefs.length,
  'no href appears twice in the project tree');
const emptySections = PROJECT_NAV.filter((s) => !s.items || s.items.length === 0);
check(emptySections.length === 0, 'no workstream section renders empty');
check(!PROJECT_NAV.some((s) => (s.groups || []).some((g) => !g.items || g.items.length === 0)),
  'no staff group renders empty');
check(!/items:\s*\[\s*\]/.test(src), 'no nav section is declared with an empty item list');

// ── §22 D05–D09: the staff-only surfaces are regrouped, never removed ───────
checkEq(STAFF_GROUPS.map((g) => g.label), ['Research tools', 'Evidence tools'],
  '§3.2 staff-only groups are Research tools and Evidence tools');
const staffHrefs = STAFF_GROUPS.flatMap((g) => g.items.map((it) => it.href));
for (const href of ['/research/serp', '/research/journeys', '/research/campaigns', '/content/data-assets', '/claims']) {
  check(staffHrefs.includes(href), `§22 D05–D09 keeps ${href} in the staff tree`);
}
check(STAFF_GROUPS.every((g) => typeof g.note === 'string' && g.note.length > 0),
  'each staff-only group states that it is staff only');

// ── §3.3 client navigation ─────────────────────────────────────────────────
const clientProjectItems = CLIENT_PROJECT_NAV[0].items;
checkEq(clientProjectItems.filter((it) => !it.secondary).map((it) => it.label),
  ['Overview', 'Plan', 'Results', 'Content', 'Calendar'],
  '§3.3 client project nav is Overview, Plan, Results, Content, Calendar');
checkEq(clientProjectItems.filter((it) => it.secondary).map((it) => it.label),
  ['Business information', 'Connected accounts'],
  '§3.3 Business information and Connected accounts are secondary links');
checkEq(labels(CLIENT_NAV[0].items), ['Home', 'Approvals', 'Reports', 'Messages', 'Account'],
  'the client workspace nav is Home, Approvals, Reports, Messages, Account');

const clientItems = [...CLIENT_NAV[0].items, ...clientProjectItems];
check(!clientItems.some((it) => /all clients|select (a )?client|client selector|switch client|other client/i.test(it.label || '')),
  '§3.3 client nav has no all-clients selector of any name');
check(!clientItems.some((it) => (it.label || '').trim() === 'Clients'),
  '§3.3 client nav has no portfolio Clients entry');
check(!clientItems.some((it) => typeof it.href === 'string' && /^\/ops(\/|$)/.test(it.href)),
  'no client nav entry links into the operator workspace');
const staffReachable = new Set([...staffHrefs, ...team.items.map((it) => it.href), '/ops/work']);
const leaked = clientItems.filter((it) => staffReachable.has(it.href));
check(leaked.length === 0, `§3.3 no client nav entry points at a staff tool${leaked.length ? ' — leaked: ' + leaked.map((i) => i.href).join(', ') : ''}`);
const clientHrefs = clientItems.map((it) => it.href);
check(!clientHrefs.some((h) => /\/(research|claims|priorities|authority|monitoring|cycles|data-assets|rubrics)\b/.test(h)),
  'no client nav entry points at a research, evidence or admin route');

// ── The shells, and the per-user collapse memory (§3.2) ─────────────────────
function readShell(name) {
  try {
    // Comment-stripped: a comment may *name* the other tree while explaining
    // the boundary, and that is not a leak.
    return stripComments(fs.readFileSync(path.join(SRC, 'components', 'layouts', name), 'utf8'));
  } catch (e) {
    return '';
  }
}
const opsShell = readShell('OpsShell.tsx');
const clientShell = readShell('ClientShell.tsx');
const appShell = readShell('AppShell.tsx');
check(opsShell.includes('resolveProjectNav') && opsShell.includes('OPERATOR_NAV'),
  'OpsShell renders the §3.2 project tree and the §3.4 portfolio tree');
// Substring care: `CLIENT_PROJECT_NAV` contains `PROJECT_NAV`, so these are
// matched on word starts rather than by `includes`.
const clientUsesStaffTree = /(?<![A-Z_])PROJECT_NAV|(?<![A-Z_])OPERATOR_NAV|STAFF_GROUPS/.test(clientShell);
const opsUsesClientTree = /CLIENT_PROJECT_NAV|(?<![A-Z_])CLIENT_NAV/.test(opsShell);
check(!clientUsesStaffTree, 'ClientShell renders no staff tree (PROJECT_NAV / OPERATOR_NAV / STAFF_GROUPS)');
check(!opsUsesClientTree, 'OpsShell renders no client tree — the staff toolbox cannot reach a client');
check(resolveSource('resolveProjectNav', 'section.label === \'Team tools\' ? STAFF_GROUPS'),
  'resolveProjectNav attaches the staff-only groups to Team tools and nowhere else');
check(resolveSource('resolveProjectNav', 'visibleSections('),
  'resolveProjectNav applies the role filter, so a hidden item is hidden for every role');
check(appShell.includes('cailyx:nav:'), 'the collapse preference is stored under the cailyx:nav: key');
check(appShell.includes('persistKey'), 'AppShell reads a section\'s persistKey to remember its state');
check(appShell.includes('aria-expanded') && appShell.includes('aria-controls'),
  'the collapsible group is a real disclosure: aria-expanded plus aria-controls');
check(appShell.includes('sectionContainsPath'),
  'a collapsed Team tools still shows an active child route (sectionContainsPath)');
check(opsShell.includes('`ops:${user.id}`') || opsShell.includes('ops:${user.id}'),
  '§3.2 the collapse state is remembered per user (ops:<user id>)');
check(clientShell.includes('client:${user.id}'),
  '§3.3 the client shell scopes its own preferences to that user');

function resolveSource(fnName, needle) {
  const m = new RegExp('(?:export )?function\\s+' + fnName + '\\b').exec(src);
  if (!m) return false;
  const body = src.slice(m.index, m.index + 2000);
  return body.includes(needle);
}

finish();
NAV_JS
cat > "$TMP/a11y.js" <<'A11Y_JS'
// §4.5 interaction/accessibility check (P16 smoke).
//
// These are the §4.5 requirements that are decidable from source: a scrollable
// region must be keyboard-reachable and announced, a status must not be carried
// by colour alone, and a control must not claim an ARIA pattern it does not
// implement. Comments are stripped first, so a comment that *describes* the
// attribute cannot satisfy the check.
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.resolve(process.argv[2] || '../web');
const SRC = path.join(WEB_ROOT, 'src');

function stripComments(s) {
  let out = '';
  let i = 0;
  let mode = null;
  while (i < s.length) {
    const c = s[i];
    const nxt = i + 1 < s.length ? s[i + 1] : '';
    if (mode === null) {
      if (c === '/' && nxt === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && nxt === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        out += c;
        i += 1;
        while (i < s.length) {
          if (s[i] === '\\') { out += s[i] + s[i + 1]; i += 2; continue; }
          out += s[i];
          if (s[i] === q) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      out += c;
      i += 1;
    } else if (mode === 'line') {
      if (c === '\n') { mode = null; out += c; }
      i += 1;
    } else {
      if (c === '*' && nxt === '/') { mode = null; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
    }
  }
  return out;
}

function read(rel) {
  try {
    return stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  } catch (e) {
    return null;
  }
}

let failed = false;
function check(condition, message) {
  if (condition) console.log('PASS ' + message);
  else { failed = true; console.log('FAIL ' + message); }
}

// ── Scrollable regions are reachable and announced ─────────────────────────
// `<pre role="region" tabIndex={0} aria-label=…>` — one element, so the
// attributes are matched inside a single JSX opening tag (no `>` between them).
const drawer = read('components/patterns/EvidenceDrawer.tsx');
check(drawer !== null, 'EvidenceDrawer source is where this check expects it');
if (drawer) {
  check(/role="region"[^>]*tabIndex=\{0\}[^>]*aria-label=/.test(drawer),
    '§4.5 the scrollable evidence text is a focusable, labelled region so it can be scrolled by keyboard');
  check(/aria-label=\{raw\.label \?\? '[^']+'\}/.test(drawer),
    '§4.5 that region has a name a screen reader can announce');
}

const workRow = read('components/patterns/WorkRow.tsx');
check(workRow !== null, 'WorkRow source is where this check expects it');
if (workRow) {
  check(/role="region"[^>]*aria-label=\{label\}[^>]*tabIndex=\{0\}/.test(workRow),
    '§4.5 the work table is a scrollable region with an accessible name (§3.4)');
  check(/text-danger-foreground">Overdue</.test(workRow),
    '§4.5 an overdue item is named in words, not signalled by colour alone (§3.4)');
}

// ── A control must not promise an ARIA pattern it does not implement ───────
const calendar = read('components/patterns/ContentCalendar.tsx');
check(calendar !== null, 'ContentCalendar source is where this check expects it');
if (calendar) {
  check(!/role="tab"/.test(calendar),
    '§4.5 the calendar view toggles do not claim role="tab" without a tabpanel or roving tabindex');
  check(!/aria-selected/.test(calendar), '§4.5 … and do not claim aria-selected either');
  check(/role="group"[^>]*aria-label="/.test(calendar),
    '§4.5 the toggle group is a labelled group instead');
  check(/aria-pressed=\{selected\}/.test(calendar),
    '§4.5 each toggle reports its own pressed state to assistive technology');
}

process.exit(failed ? 1 : 0);
A11Y_JS
cat > "$TMP/vocab.js" <<'VOCAB_JS'
// §4.3 language-dictionary scan (P16).
//
// Scope: every source file a client screen can actually render — the pages
// under `web/src/app/(client)` plus the transitive import closure of the
// shared components they pull in. Staff-only components (a run monitor, say)
// are out of scope by construction: no client page imports them, so their
// internal vocabulary is not a defect here.
//
// Only text a reader can see is scanned: JSX text nodes and quoted strings
// that read as prose. Identifiers, props and route hrefs are ignored on
// purpose — §4.3 is a *visible label* dictionary, not an API/DB/TS rename, so
// flagging `cycleStatusLabel` would be a false positive by construction.
const fs = require('fs');
const path = require('path');

const BANNED = [
  ['AEO', /\bAEO\b/],
  ['SERP', /\bSERP\b/],
  ['GSC', /\bGSC\b/],
  ['GA4', /\bGA4\b/],
  ['LLM', /\bLLM\b/],
  ['ICP', /\bICP\b/],
  ['DTO', /\bDTO\b/],
  ['roadmap', /roadmaps?/i],
  ['rubric', /rubrics?/i],
  ['workstream', /workstream/i],
  ['discipline', /\bdisciplines?\b/i],
  ['methodology break', /methodology[\s-]break/i],
  ['cohort', /\bcohorts?\b/i],
  ['manifest', /\bmanifests?\b/i],
  ['provenance', /provenance/i],
  ['extractability', /extractab/i],
  ['canonical mismatch', /canonical mismatch/i],
  ['generation job', /generation job/i],
  ['capability unavailable', /capability unavailable/i],
  ['site context', /site context/i],
  ['brand entities', /brand entit/i],
  ['brand voice', /brand voice/i],
  ['digital footprint', /digital footprint/i],
  ['presence insights', /presence insights/i],
  ['technical audit', /technical audits?/i],
  ['search performance', /search performance/i],
  ['traffic & acquisition', /traffic\s*&\s*acquisition/i],
  ['prompt library', /prompt library/i],
  ['query set', /query sets?/i],
  ['shortlist presence', /shortlist presence/i],
  ['share of voice', /share of voice/i],
  ['data asset', /data assets?/i],
  ['sleeper', /sleeper/i],
  ['run', /\bruns?\b/i],
  ['pipeline', /pipeline/i],
  ['cycle', /\bcycles?\b/i],
  ['artifact', /artifacts?\b/i],
  ['credential', /credentials?\b/i],
  ['provider', /\bproviders?\b/i],
  ['integration', /\bintegrations?\b/i],
];

// Files whose only renderers are staff screens. §4.3 governs the wording a
// *client* reads (§4.3 itself keeps "brief" as staff shorthand), and these
// components are reached from the client tree only through a type or a
// sub-export they do not themselves render — so they are out of scope here
// rather than silently failing the check.
const STAFF_ONLY = new Set([
  'components/patterns/RunConfigurator.tsx',
  'components/patterns/RunStatusStrip.tsx',
]);

// Words that are dictionary terms in one sense and ordinary English in
// another. Each entry is a phrase that is legitimate on its own terms.
const ALLOW = [
  /sales pipeline/i,
  /lead pipeline/i,
  /pipeline of work/i,
  /(check|checks|checking|has|have|had|when|once|who|that|it|still|to|first|each|the same)\s+runs?\b/i,
  /runs? (out|into|for|from|through|on|until|over)\b/i,
  /running/i,
  /Google Search Console/i,
  /Google Analytics/i,
  /credentials? (are|is) (configured|missing)/i,
  /service provider/i,
  // Staff-only navigation label: "Team tools" is not rendered to a client
  // (ClientShell renders CLIENT_NAV / CLIENT_PROJECT_NAV), and a work period
  // is called a delivery cycle in the delivery team's own vocabulary.
  /Delivery cycles/,
];

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = null;
  while (i < n) {
    const c = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (mode === null) {
      if (c === '/' && nxt === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && nxt === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        out += c; i += 1;
        while (i < n) {
          if (src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
          out += src[i];
          if (src[i] === q) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      out += c; i += 1;
    } else if (mode === 'line') {
      if (c === '\n') { mode = null; out += c; }
      i += 1;
    } else {
      if (c === '*' && nxt === '/') { mode = null; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
    }
  }
  return out;
}

// Text a reader can see, loosely: anything that reads like a sentence rather
// than code. The rejections below are what make a *false positive* unlikely, so
// they are deliberately narrow — an earlier version also dropped any run
// containing `;`, `?` or `!`, which silently skipped whole sentences of real
// copy ("Your AEO run finished; the cohort is in the manifest."). A check that
// cannot fail is worse than no check, so punctuation that prose uses is kept
// and only code-shaped punctuation is rejected.
function looksLikeProse(text) {
  if (text.length < 3) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/[={}<>`\\]/.test(text)) return false;      // code, not copy
  if (/&&|\|\||=>/.test(text)) return false;      // code, not copy
  // A JSX ternary leaks through as `) : prop ? (`; real copy does not glue
  // punctuation to a bracket like that.
  if (/[?:]\s*\(/.test(text) || /\)\s*[?:]/.test(text)) return false;
  if (/^[/.]/.test(text.trim())) return false;   // paths, class lists
  if (/\w+\(/.test(text)) return false;          // call expressions
  if (/^\s*[a-z][A-Za-z]*\s*$/.test(text)) return false; // a bare identifier
  return true;
}

function visibleRuns(src) {
  const runs = [];
  // JSX text nodes: between '>' and the next '<' with no braces inside. Parens
  // are allowed through: "Sources still to report (agreed, not measured yet)"
  // is copy, and excluding it would drop the parenthetical half of the copy
  // this scan exists to read. JSX expressions delimited by braces are still
  // excluded, so code inside `{…}` never enters.
  let m;
  const jsx = /(?:^|>)([^<>{}]*?)(?=<|$)/g;
  while ((m = jsx.exec(src)) !== null) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (looksLikeProse(text)) runs.push(text);
  }
  // Quoted strings that read as prose (a space and a letter, no path prefix).
  const str = /(['"`])((?:[^'"`\\\n]|\\.)*?)\1/g;
  while ((m = str.exec(src)) !== null) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (!/\s/.test(m[2])) continue;
    if (looksLikeProse(text)) runs.push(text);
  }
  return runs;
}

// ── Import closure of the client tree ─────────────────────────────────────
// The web root is passed in (`$WEB_ROOT` in the smoke runner): the script is
// run from backend/, and the sources it checks live in ../web.
const WEB_ROOT = path.resolve(process.argv[2] || '../web');
const SRC = path.join(WEB_ROOT, 'src');
const skip = new Set(process.env.SKIP_FILES ? process.env.SKIP_FILES.split(';') : []);

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(tsx|ts)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// Only the client tree seeds the closure; every other file must be reachable
// from it. A component that only an ops page renders never enters the scan.
const seen = new Set();
const clientFiles = walk(path.join(SRC, 'app', '(client)'), []);
const out = [];
const stack = [...clientFiles];
const importSpec = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
while (stack.length) {
  const file = stack.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  let m;
  importSpec.lastIndex = 0;
  while ((m = importSpec.exec(src)) !== null) {
    const resolved = resolveImport(file, m[1]);
    if (resolved && !seen.has(resolved)) stack.push(resolved);
  }
}

let hits = 0;
let skipped = 0;
const scanned = [];
const excluded = [];
for (const file of [...seen].sort()) {
  const rel = path.relative(SRC, file);
  if (skip.has(rel) || STAFF_ONLY.has(rel)) {
    skipped += 1;
    excluded.push(rel + (skip.has(rel) ? ' (excluded by SKIP_FILES)' : ' (staff-only renderer)'));
    continue;
  }
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const lines = src.split('\n');
  for (const run of visibleRuns(src)) {
    if (ALLOW.some((re) => re.test(run))) continue;
    for (const [name, re] of BANNED) {
      if (re.test(run)) {
        const idx = lines.findIndex((l) => l.includes(run.split(' ').slice(0, 3).join(' ')));
        hits += 1;
        console.log(`HIT ${rel}:${idx + 1} [${name}] ${run.slice(0, 120)}`);
        break;
      }
    }
  }
  scanned.push(rel);
}
for (const e of excluded) console.log(`NOTICE not scanned: ${e}`);
console.log(`scanned=${scanned.length} skipped=${skipped} hits=${hits}`);
process.exit(hits === 0 ? 0 : 1);
VOCAB_JS

echo "== nav-rollout smoke (web root: $WEB_ROOT) =="

# ── 1. §20.3 — retired routes still resolve ────────────────────────────────
echo
echo "-- §20.3 retired routes are redirects into routes that exist --"
"$NODE" "$TMP/routes.js" "$WEB_ROOT" > "$TMP/routes.out" 2>&1
emit < "$TMP/routes.out"
ran "$TMP/routes.out" "the route checks ran" 20

# ── 2. §20.3 over HTTP — a retired deep link answers a redirect ────────────
# The source check proves the stub exists and points somewhere real; this is
# the half that proves the running app actually hops. There is no browser in
# this harness, so it is a header read, not a rendered page.
echo
echo "-- §20.3 live: a retired deep link redirects instead of 404ing --"
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$WEB_BASE/" 2>/dev/null | tail -1)
[ -n "$HEALTH" ] || HEALTH=000
if [ "$HEALTH" = "000" ]; then
  skip "no web server at $WEB_BASE — start it (cd web && npx next start -p 3010) and re-run for the live hop"
else
  # path <TAB> expected location fragment
  while IFS=$'\t' read -r path expected; do
    [ -n "$path" ] || continue
    HDRS=$(curl -s -o /dev/null -D - -m 20 "$WEB_BASE$path" 2>/dev/null || true)
    CODE=$(printf '%s\n' "$HDRS" | head -1 | awk '{print $2}')
    LOC=$(printf '%s\n' "$HDRS" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2; exit}')
    case "$CODE" in
      30*) : ;;
      *) bad "$path answered ${CODE:-nothing}, not a redirect"; continue ;;
    esac
    case "$LOC" in
      *"$expected"*) ok "$path -> $LOC" ;;
      *) bad "$path redirected to ${LOC:-nowhere}, not to *$expected*" ;;
    esac
  done <<'LIVE_ROUTES'
/projects/legacy-smoke/research/search	/projects/legacy-smoke/research/website?tab=search
/projects/legacy-smoke/research/traffic	/projects/legacy-smoke/research/website?tab=visitors
/projects/legacy-smoke/research/prompts	/projects/legacy-smoke/research/ai/sets
/projects/legacy-smoke/research/prompts/set-1	/projects/legacy-smoke/research/ai/sets/set-1
/projects/legacy-smoke/research/context	/projects/legacy-smoke/business-info
/projects/legacy-smoke/research/presence/insights	/projects/legacy-smoke/research/presence
/projects/legacy-smoke/content/calendar	/projects/legacy-smoke/calendar
/projects/legacy-smoke/content/generate	/projects/legacy-smoke/content
/projects/legacy-smoke/content/page-analysis	/projects/legacy-smoke/research/website/page-analysis
LIVE_ROUTES
fi

# ── 3. §3.2/§3.3/§3.4 — the nav trees are the ones the plan specifies ──────
echo
echo "-- §3.2 staff project nav, §3.3 client nav, §3.4 portfolio nav --"
"$NODE" "$TMP/nav.js" "$WEB_ROOT" > "$TMP/nav.out" 2>&1
emit < "$TMP/nav.out"
ran "$TMP/nav.out" "the nav checks ran" 40

# ── 4. §3.3 — the absolute client rules ────────────────────────────────────
echo
echo "-- §3.3 client rules that hold by construction --"
CLIENT_APP="$WEB_ROOT/src/app/(client)"
CLIENT_SHELL="$WEB_ROOT/src/components/layouts/ClientShell.tsx"
if [ -d "$CLIENT_APP" ] && [ -f "$CLIENT_SHELL" ]; then
  if grep -rq "listClients" "$CLIENT_APP" "$CLIENT_SHELL" 2>/dev/null; then
    bad "§3.3 a client screen reads the client list — the client tree must have no all-clients surface"
  else
    ok "§3.3 no client screen reads the client list (no all-clients selector, no other-client surface)"
  fi

  if grep -rEq "'/research|\"/research|'/ops|\"/ops|'/claims|'/priorities|'/authority|'/monitoring|'/cycles|'/content/data-assets|'/ops/work" "$CLIENT_APP" 2>/dev/null; then
    bad "a client page links into a staff-only surface (§3.3, §22 D05–D09 keep those staff only)"
  else
    ok "no client page links to a research, evidence, admin or work-inbox route"
  fi

  CLIENT_HOME="$CLIENT_APP/client/page.tsx"
  if [ -f "$CLIENT_HOME" ] && grep -q 'projects?.length === 1' "$CLIENT_HOME" \
     && grep -q 'router.replace(`/client/projects/' "$CLIENT_HOME"; then
    ok "§3.3 a client with exactly one project lands in that project, not on a picker"
  else
    bad "§3.3 the client home no longer sends a one-project client into their project"
  fi
else
  bad "the client tree is where this check expects it ($CLIENT_APP)"
fi

# ── 5. §4.5 — the accessibility rules that are decidable from source ───────
echo
echo "-- §4.5 keyboard/screen-reader contracts --"
"$NODE" "$TMP/a11y.js" "$WEB_ROOT" > "$TMP/a11y.out" 2>&1
emit < "$TMP/a11y.out"
ran "$TMP/a11y.out" "the accessibility checks ran" 8

# ── 6. §4.3 — the language dictionary, over everything a client can render ──
# No files are excluded by default: the three P15-owned pages that were skipped
# while that phase was in flight have since had their copy brought in line, and
# the scan passes over the whole client closure with `hits=0`. SKIP_FILES still
# exists as an escape hatch for a deliberately in-progress screen, but anything
# listed there is named in the output rather than silently dropped.
echo
echo "-- §4.3 banned vocabulary has no hit in client-reachable sources --"
SKIP_FILES="${SKIP_FILES-}"
export SKIP_FILES
"$NODE" "$TMP/vocab.js" "$WEB_ROOT" > "$TMP/vocab.out" 2>&1
VOCAB_STATUS=$?
emit < "$TMP/vocab.out"
SUMMARY=$(grep -E '^scanned=' "$TMP/vocab.out" | tail -1)
SCANNED=$(printf '%s' "$SUMMARY" | sed -n 's/.*scanned=\([0-9]*\).*/\1/p')
[ -n "$SCANNED" ] || SCANNED=0
if [ "$VOCAB_STATUS" = "0" ] && [ "$SCANNED" -ge 60 ]; then
  ok "§4.3 the dictionary scan covered $SUMMARY"
else
  bad "§4.3 the dictionary scan is not clean or did not cover the client tree ($SUMMARY)"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo
echo "nav-rollout smoke: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = "0" ] && echo "ALL PASS" || { echo "FAILURES PRESENT"; exit 1; }

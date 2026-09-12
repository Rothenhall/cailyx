#!/usr/bin/env bash
# E2E smoke — users module (operator administration, admin only).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }

echo "== users smoke =="

TOKEN=$(smoke_auth)   # shared smoke operator = the bootstrap admin
[ -n "$TOKEN" ] && [ "$TOKEN" != "__ERR__" ] && ok "got admin token" || { bad "no token"; exit 1; }
AUTH=(-H "authorization: Bearer $TOKEN")

# --- roles + list -------------------------------------------------
R=$(curl -s "$API/users/roles" "${AUTH[@]}")
echo "$R" | grep -q '"admin"' && echo "$R" | grep -q '"content"' && ok "role catalogue returned" || bad "roles = $R"
L0=$(curl -s "$API/users" "${AUTH[@]}" | jlen users)
[ "$L0" -ge 1 ] 2>/dev/null && ok "list operators ($L0)" || bad "list = $L0"

# --- create ----------------------------------------------------
EM="smoke-op-$RANDOM@cailyx.test"
C=$(curl -s -X POST "$API/users" "${AUTH[@]}" -H 'content-type: application/json' -d "{\"email\":\"$EM\",\"password\":\"operator-pw-123456\",\"name\":\"Test Operator\",\"role\":\"content\"}")
OPID=$(echo "$C" | jget id)
[ -n "$OPID" ] && [ "$OPID" != "__ERR__" ] && ok "created operator $OPID" || { bad "create"; echo "$C"; exit 1; }
[ "$(echo "$C" | jget role)" = "content" ] && ok "role = content" || bad "role wrong"
echo "$C" | grep -qiE 'passwordHash|password"' && bad "secret leaked in create response" || ok "no secret in create response"
# Throwaway accounts this script creates, deleted on every exit path.
EXTRA_IDS=""
cleanup() {
  curl -s -X DELETE "$API/users/$OPID" "${AUTH[@]}" >/dev/null 2>&1
  for id in $EXTRA_IDS; do
    curl -s -X DELETE "$API/users/$id" "${AUTH[@]}" >/dev/null 2>&1
  done
  # Tripwire: this script must never leave the SHARED smoke operator without
  # admin rights. Every other smoke script authenticates as it, so a demoted
  # operator makes the rest of the suite fail with 403 on admin-only routes —
  # and a demoted account cannot promote itself back, so this can only report,
  # not repair. Nothing below demotes it by design; this exists so a future edit
  # cannot regress that silently.
  if [ "$(curl -s "$API/auth/me" "${AUTH[@]}" | jget role)" != "admin" ]; then
    echo "  WARN  $SMOKE_EMAIL was left without admin rights — the rest of the suite will fail."
    echo "        Repair with:  npx prisma studio   (or) node -e \"…user.update({where:{email:'$SMOKE_EMAIL'},data:{role:'admin'}})\""
  fi
  echo "(op deleted)"
}
trap cleanup EXIT

# --- the new operator can log in --------------------------------
NT=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EM\",\"password\":\"operator-pw-123456\"}" | jget accessToken)
[ -n "$NT" ] && [ "$NT" != "__ERR__" ] && ok "new operator can log in" || bad "new op login failed"
# ...but is not admin — cannot list users
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/users" -H "authorization: Bearer $NT")" = "403" ] && ok "non-admin → 403 on /users" || bad "non-admin not 403"

# --- update role + name --------------------------------------
U=$(curl -s -X PATCH "$API/users/$OPID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"role":"delivery-lead","name":"Renamed Operator"}')
[ "$(echo "$U" | jget role)" = "delivery-lead" ] && [ "$(echo "$U" | jget name)" = "Renamed Operator" ] && ok "update role + name" || bad "update: $(echo "$U" | jget role)/$(echo "$U" | jget name)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/users/$OPID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"role":"wizard"}')" = "400" ] && ok "invalid role → 400" || bad "bad role not 400"

# --- password reset ---------------------------------------
PR=$(curl -s -X POST "$API/users/$OPID/password" "${AUTH[@]}" -H 'content-type: application/json' -d '{"password":"a-new-operator-pw-9"}')
echo "$PR" | grep -q '"sessionsRevoked"' && ok "password reset returns sessionsRevoked" || bad "reset shape: $PR"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EM\",\"password\":\"a-new-operator-pw-9\"}")" = "200" ] && ok "login works with the new password" || bad "new password login failed"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/users/$OPID/password" "${AUTH[@]}" -H 'content-type: application/json' -d '{"password":"short"}')" = "400" ] && ok "short password → 400" || bad "short pw not 400"

# --- guard rails ----------------------------------------
ME=$(curl -s "$API/auth/me" "${AUTH[@]}" | jget id)
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/users/$ME" "${AUTH[@]}")" = "400" ] && ok "cannot delete your own account → 400" || bad "self-delete not 400"

# The last-admin guard (`users.service.update`: 409 when the target is an admin,
# the patch is not admin, and adminCount() <= 1).
#
# This is deliberately NOT tested by demoting the shared smoke operator. That
# only returns 409 on a database where it happens to be the sole admin; on any
# database with a second admin the demote SUCCEEDS, and the operator every other
# smoke script logs in as is left without admin rights — turning one failed
# assertion into a suite-wide cascade of 403s. (Observed: 6/9 scripts failing.)
#
# So the coverage is conditional on what the database actually contains:
#   - exactly 1 admin (a fresh dev.db — the intended environment): assert the 409.
#     This is safe precisely because the guard REJECTS it, so nothing changes.
#   - more than 1 admin: skip it loudly. The demote would succeed and break the
#     shared operator, and the sole-admin state cannot be manufactured here
#     without demoting the operator's real admins.
# Either way, a throwaway admin then covers the guard's other branch (a non-last
# admin CAN be demoted), so the happy path is always exercised.
ADMIN_COUNT=$(curl -s "$API/users" "${AUTH[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).users||[]).filter(u=>u.role==="admin").length))}catch(e){process.stdout.write("0")}})')

if [ "$ADMIN_COUNT" = "1" ]; then
  # Safe: the guard rejects this, so the operator keeps its admin rights.
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/users/$ME" "${AUTH[@]}" -H 'content-type: application/json' -d '{"role":"content"}')" = "409" ] \
    && ok "cannot demote the last admin → 409" || bad "last-admin demote not 409"
else
  skip "last-admin 409 guard — needs a sole-admin database (this one has $ADMIN_COUNT admins); never tested by demoting $SMOKE_EMAIL"
fi

TMP_ADMIN_EMAIL="smoke-admin-$RANDOM@cailyx.test"
TA=$(curl -s -X POST "$API/users" "${AUTH[@]}" -H 'content-type: application/json' \
  -d "{\"email\":\"$TMP_ADMIN_EMAIL\",\"password\":\"temp-admin-pw-123456\",\"name\":\"Temp Admin\",\"role\":\"admin\"}")
TAID=$(echo "$TA" | jget id)
if [ -n "$TAID" ] && [ "$TAID" != "__ERR__" ]; then
  EXTRA_IDS="$EXTRA_IDS $TAID"
  ok "created throwaway admin (admins now $((ADMIN_COUNT + 1)))"
  # A non-last admin CAN be demoted — the guard must not over-trigger.
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/users/$TAID" "${AUTH[@]}" -H 'content-type: application/json' -d '{"role":"content"}')" = "200" ] \
    && ok "a non-last admin can be demoted → 200" || bad "non-last-admin demote not 200"
else
  bad "could not create throwaway admin: $TA"
fi

# --- delete ------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/users/$OPID" "${AUTH[@]}")" = "200" ] && ok "delete operator → 200" || bad "delete failed"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/users/$OPID" "${AUTH[@]}")" = "404" ] && ok "deleted operator → 404" || bad "deleted still found"

echo
if [ "$SKIP" -gt 0 ]; then
  echo "== $PASS passed, $FAIL failed, $SKIP skipped =="
else
  echo "== $PASS passed, $FAIL failed =="
fi
[ "$FAIL" = "0" ]

#!/usr/bin/env bash
# E2E smoke — users module (operator administration, admin only).
set -uo pipefail
source "$(dirname "$0")/_common.sh"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

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
cleanup() { curl -s -X DELETE "$API/users/$OPID" "${AUTH[@]}" >/dev/null 2>&1; echo "(op deleted)"; }
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
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$API/users/$ME" "${AUTH[@]}" -H 'content-type: application/json' -d '{"role":"content"}')" = "409" ] && ok "cannot demote the last admin → 409" || bad "last-admin demote not 409"

# --- delete ------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/users/$OPID" "${AUTH[@]}")" = "200" ] && ok "delete operator → 200" || bad "delete failed"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/users/$OPID" "${AUTH[@]}")" = "404" ] && ok "deleted operator → 404" || bad "deleted still found"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]

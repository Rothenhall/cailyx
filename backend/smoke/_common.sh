# Shared helpers for swarm-layer smoke scripts. `source` this file.
#
#   source "$(dirname "$0")/_common.sh"
#   TOKEN=$(smoke_auth); AUTH=(-H "authorization: Bearer $TOKEN")
#
# All smoke scripts share ONE operator account. Whichever script runs first on a
# fresh dev.db bootstraps it as admin (auth.register: first account = admin);
# the rest just log in.
API="${API:-http://localhost:3002/api}"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke@cailyx.test}"
SMOKE_PW="${SMOKE_PW:-smoke-cailyx-pw-1234567890}"
SMOKE_NAME="Swarm Smoke"

# Extract a dotted path from stdin JSON; "" for null/undefined, __ERR__ on bad JSON.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let p=o;for(const k of process.argv[1].split("."))p=p==null?undefined:p[k];process.stdout.write(p==null?"":(typeof p==="object"?JSON.stringify(p):String(p)))}catch(e){process.stdout.write("__ERR__")}})' "$1"; }
# Length of an array at a dotted path (or root); "NaN" when not an array.
jlen() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1]?process.argv[1].split(".").reduce((a,k)=>a?.[k],o):o;process.stdout.write(Array.isArray(p)?String(p.length):"NaN")}catch(e){process.stdout.write("NaN")}})' "${1:-}"; }

smoke_auth() {
  local tok
  tok=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PW\"}" | jget accessToken)
  if [ -z "$tok" ] || [ "$tok" = "__ERR__" ]; then
    tok=$(curl -s -X POST "$API/auth/register" -H 'content-type: application/json' \
      -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PW\",\"name\":\"$SMOKE_NAME\"}" | jget accessToken)
  fi
  printf '%s' "$tok"
}

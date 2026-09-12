# Shared helpers for swarm-layer smoke scripts. `source` this file.
#
#   source "$(dirname "$0")/_common.sh"
#   TOKEN=$(smoke_auth); AUTH=(-H "authorization: Bearer $TOKEN")
#
# All smoke scripts share ONE operator account. Whichever script runs first on a
# fresh dev.db bootstraps it as admin (auth.register: first account = admin);
# the rest just log in.
#
# ── Two rules this harness learned the hard way ──────────────────────────────
#
# 1. NEVER change the shared operator's role, and never leave a test that could.
#    Every script authenticates as it, so demoting it makes the whole suite fail
#    with 403 on admin-only routes — and a demoted account cannot promote itself
#    back, so the only fix is a manual DB edit. A test that needs a role change
#    must create its own throwaway account and change that instead.
#    (`users.smoke.sh` used to demote it whenever the DB had >1 admin.)
#
# 2. NEVER put a bare `|` inside a `node -e '…'` script body. On Windows, Volta's
#    node shim re-parses the command line and treats it as a shell pipe: node
#    never starts, the command prints "The system cannot find the path
#    specified." and the assertion silently compares against an empty string.
#    `||` is fine; a lone `|` — including inside a string literal like " | " —
#    is not. Use a different separator.
API="${API:-http://localhost:3002/api}"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke@cailyx.test}"
SMOKE_PW="${SMOKE_PW:-smoke-cailyx-pw-1234567890}"
SMOKE_NAME="Swarm Smoke"

# Extract a dotted path from stdin JSON; "" for null/undefined, __ERR__ on bad JSON.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let p=o;for(const k of process.argv[1].split("."))p=p==null?undefined:p[k];process.stdout.write(p==null?"":(typeof p==="object"?JSON.stringify(p):String(p)))}catch(e){process.stdout.write("__ERR__")}})' "$1"; }
# Length of an array at a dotted path (or root); "NaN" when not an array.
jlen() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1]?process.argv[1].split(".").reduce((a,k)=>a?.[k],o):o;process.stdout.write(Array.isArray(p)?String(p.length):"NaN")}catch(e){process.stdout.write("NaN")}})' "${1:-}"; }

# Poll a URL until the value at a dotted JSON path matches one of the given
# space-separated terminal values (or the timeout elapses). Prints the last
# response body it fetched. Needed now that discovery/audit endpoints queue
# their work and return immediately instead of blocking until done.
#   poll_until "$API/projects/$PID/presence/discoveries/$RID" status "completed failed" 30 "${AUTH[@]}"
poll_until() {
  local url="$1" path="$2" terminal="$3" timeout="${4:-30}"
  shift 4
  local body elapsed=0
  while true; do
    body=$(curl -s "$url" "$@")
    local val
    val=$(echo "$body" | jget "$path")
    for t in $terminal; do
      if [ "$val" = "$t" ]; then
        echo "$body"
        return 0
      fi
    done
    [ "$elapsed" -ge "$timeout" ] && { echo "$body"; return 1; }
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

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

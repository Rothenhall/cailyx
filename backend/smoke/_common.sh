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

# Log in as the shared smoke operator, retrying through a throttle.
#
# `POST /auth/login` is rate-limited, and a full `run-all.sh` pass makes dozens
# of logins in quick succession. Without a retry the first 429 returns an empty
# token, the caller's `die` fires, and the suite reports as a whole-script
# failure having tested nothing — which is exactly what made a 32-suite run read
# as 16/32 with a wall of unrelated failures. Retrying here costs a few seconds
# and makes the harness's own results mean something.
smoke_auth() {
  local tok attempt wait
  wait=3
  for attempt in 1 2 3 4 5 6; do
    tok=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
      -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PW\"}" | jget accessToken)
    if [ -n "$tok" ] && [ "$tok" != "__ERR__" ]; then
      printf '%s' "$tok"
      return 0
    fi
    sleep "$wait"
    wait=$((wait * 2))
  done

  # No account yet (fresh DB): the first registration becomes the bootstrap
  # admin. Also throttled, so it gets the same treatment.
  wait=3
  for attempt in 1 2 3 4 5 6; do
    tok=$(curl -s -X POST "$API/auth/register" -H 'content-type: application/json' \
      -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PW\",\"name\":\"$SMOKE_NAME\"}" | jget accessToken)
    if [ -n "$tok" ] && [ "$tok" != "__ERR__" ]; then
      printf '%s' "$tok"
      return 0
    fi
    sleep "$wait"
    wait=$((wait * 2))
  done

  printf ''
}

# Log in as an arbitrary account, retrying through a throttle.
#
# `smoke_auth` covers the shared operator, but a dozen suites create their own
# throwaway client/operator accounts and log in directly. Those logins are just
# as exposed to the `/auth/login` rate limit, and a 429 there reads as
# "client login" failing — a whole-suite false alarm. Use this instead of a
# bare curl whenever a suite signs in a second account:
#
#   CAUTH_JSON=$(smoke_login "$EMAIL" "$PW")
#   CAUTH=(-H "authorization: Bearer $(echo "$CAUTH_JSON" | jget accessToken)")
smoke_login() {
  local email="$1" password="$2" body attempt wait
  wait=3
  for attempt in 1 2 3 4 5 6; do
    body=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"$password\"}")
    if [ -n "$(printf '%s' "$body" | jget accessToken)" ]; then
      printf '%s' "$body"
      return 0
    fi
    sleep "$wait"
    wait=$((wait * 2))
  done
  printf '%s' "$body"
}

# ── Is an LLM provider configured on the backend? ───────────────────────────
# Several suites assert the *no-provider* path: an endpoint that takes
# `useLlm: true` must answer 503 rather than pretend to work. That assertion
# can only hold when no key is set. When one IS set, those endpoints do real
# work — and spend real money — so the honest thing is to skip the check and
# say so, never to call them and grade the result.
#
# The path is resolved from THIS file's location, not the working directory:
# `run-all.sh` cds into `smoke/`, so a bare `.env` check silently looked at
# `smoke/.env`, decided no provider was configured, and then failed the
# assertion against a server that had one. This mirrors `_common.sh`'s
# existing position that the feature gates live on the BACKEND process.
llm_provider_configured() {
  local env_file
  env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
  [ -f "$env_file" ] || return 1
  grep -qE '^(ANTHROPIC_API_KEY|OPENROUTER_API_KEY|LLM_API_KEY)=.+' "$env_file"
}

# Emits the standard branch for a no-provider assertion, and counts it itself:
#   llm_gate_check "useLlm without a provider" "$HTTP_CODE"
# Prints PASS when the gate answered 503, SKIP when a provider is configured
# (so the branch is not exercisable), and FAIL for anything else. It does not
# call back into the caller's ok/bad/skip helpers, because not every suite
# defines a skip counter.
llm_gate_check() {
  local label="$1" code="$2"
  # `${VAR:-0}` on the right-hand side because most callers run under `set -u`
  # and several of these suites have no SKIP counter declared at all.
  if llm_provider_configured; then
    echo "  SKIP  $label — a provider IS configured on this server, so the no-provider 503 branch cannot be exercised (and calling it would spend real money)"
    SKIP=$((${SKIP:-0}+1))
  elif [ "$code" = "503" ]; then
    echo "  PASS  $label → 503 (honest gate)"
    PASS=$((${PASS:-0}+1))
  else
    echo "  FAIL  $label → $code, expected 503 with no provider configured"
    FAIL=$((${FAIL:-0}+1))
  fi
}

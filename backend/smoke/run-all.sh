#!/usr/bin/env bash
# Swarm-layer smoke harness. Runs every *.smoke.sh against a live backend.
#
#   API=http://localhost:3002/api bash smoke/run-all.sh
#
# Each smoke script is self-contained: it bootstraps its own auth, creates a
# throwaway project, exercises the module end-to-end against dev.db, and deletes
# the project on exit.
#
# No API keys required — deterministic adapters only. Those adapters are gated,
# though, and the gates live on the BACKEND process, not here:
#
#   MEASUREMENT_ALLOW_MOCK=1        mock answer-engine surface
#   INTERNAL_LINK_ALLOW_FIXTURE=1   fixture:// crawl roots
#   SERP_ALLOW_FIXTURE=1            canned SERP provider
#
# They are set in backend/.env. Start the backend any other way and authority,
# internal-link, capture and serp-intelligence fail with gate errors that read
# like code regressions — which is exactly how an hour gets lost.
set -uo pipefail
cd "$(dirname "$0")"
API="${API:-http://localhost:3002/api}"
export API

# Fail fast if the backend is not up.
if ! curl -sf -o /dev/null "$API/health"; then
  echo "backend not reachable at $API — start it with 'npm run start:dev'"
  exit 1
fi

total=0; failed=0
for s in *.smoke.sh; do
  [ -e "$s" ] || continue
  echo "────────────────────────────────────────────────────────"
  echo "▶ $s"
  echo "────────────────────────────────────────────────────────"
  if bash "$s"; then :; else failed=$((failed+1)); fi
  total=$((total+1))
done

echo "════════════════════════════════════════════════════════"
echo "smoke harness: $((total-failed))/$total scripts passed"
[ "$failed" = "0" ]

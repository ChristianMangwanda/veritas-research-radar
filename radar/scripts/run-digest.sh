#!/usr/bin/env bash
# Wrapper for the local fit-aware digest, launched daily by launchd (see
# com.veritas.radar.digest.plist). Sources your private env, then runs the
# profile-aware digest. Nothing here leaves the machine except the ntfy push.
#
# Arm it:
#   1. cp radar/scripts/.digest.env.example radar/scripts/.digest.env
#   2. fill in NTFY_TOPIC (a private ntfy.sh topic you subscribe to) and, for
#      fresh data, SUPABASE_URL / SUPABASE_SERVICE_KEY (else it reads the local
#      jobs.json snapshot, which only updates when you run a local refresh).
#   3. see the plist header for the launchctl load command.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REPO_DIR}/radar/scripts/.digest.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Rebuild the profile first if any resume file changed since the last build —
# best-effort (needs Ollama for new extractions), so a failure never blocks
# the digest; it just scores with the previous profile.
/usr/local/bin/node "${REPO_DIR}/radar/scripts/build-profile.js" --if-stale || true

exec /usr/local/bin/node "${REPO_DIR}/radar/scripts/digest-local.js"

#!/usr/bin/env bash
# Click-to-open entry point for the radar (see `npm run app:install`, which
# wraps this in a real .app you can keep in the Dock).
#
# Everything the dashboard needs lives on this machine: the resume files, the
# compiled profile, and the local model that judges postings. So "opening the
# app" means making sure the server is up, then pointing a browser at it.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-4173}"
URL="http://localhost:${PORT}"
LOG="${HOME}/Library/Logs/veritas-radar.log"

mkdir -p "$(dirname "${LOG}")"
exec >>"${LOG}" 2>&1
echo "--- launch $(date) ---"

note() { osascript -e "display notification \"$1\" with title \"Veritas Research Radar\"" >/dev/null 2>&1 || true; }

# Node lives in a few different places depending on how it was installed, and
# a GUI launch does not get your shell's PATH.
find_node() {
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$(command -v node 2>/dev/null || true)"; do
    [[ -n "${candidate}" && -x "${candidate}" ]] && { echo "${candidate}"; return 0; }
  done
  return 1
}

NODE="$(find_node)" || {
  note "Node.js not found — install it from nodejs.org, then try again."
  echo "no node on PATH or in the usual places"
  exit 1
}

already_running() { curl -sf -o /dev/null --max-time 2 "${URL}/api/preferences"; }

if already_running; then
  echo "server already up"
else
  echo "starting server with ${NODE}"
  cd "${REPO_DIR}" || exit 1
  # nohup + disown so the dashboard outlives this launcher process.
  nohup "${NODE}" "${REPO_DIR}/radar/scripts/server.js" >>"${LOG}" 2>&1 &
  disown || true

  for _ in $(seq 1 40); do
    already_running && break
    sleep 0.5
  done

  if ! already_running; then
    note "Could not start the radar — see ~/Library/Logs/veritas-radar.log"
    echo "server failed to come up"
    exit 1
  fi
  echo "server up"
fi

# The local model is what makes Qualified more than a keyword list; say so
# rather than letting the matching quietly do nothing.
if ! curl -sf -o /dev/null --max-time 2 "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags"; then
  note "Ollama isn't running — jobs will rank, but won't be read and judged."
fi

open "${URL}"

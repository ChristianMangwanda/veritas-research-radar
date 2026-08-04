#!/usr/bin/env bash
# Builds "Veritas Radar.app" — a real double-clickable app you can keep in the
# Dock — and points it at this checkout. Re-run it after moving the repo.
#
# Built with osacompile rather than a hand-rolled bundle. A hand-written
# Info.plist + shell stub LOOKS right and macOS silently refuses to launch it:
# no log line, no crash report, `open` still exits 0, and ad-hoc codesigning
# does not help. osacompile produces a bundle LaunchServices actually trusts.
# The applet just calls launch.sh, so the app never goes stale as code changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${1:-/Applications}/Veritas Radar.app"
LAUNCHER="${REPO_DIR}/radar/scripts/launch.sh"

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# Unregister before deleting, every time. Repeatedly rebuilding a bundle in
# place leaves stale LaunchServices records behind, and once a few accumulate
# macOS refuses to launch the app with NO diagnostic at all: `open` exits 0,
# nothing runs, no crash report, and the signature still verifies. Deleting
# the directory alone does not clear the record.
"${LSREGISTER}" -u "${APP_DIR}" >/dev/null 2>&1 || true
rm -rf "${APP_DIR}"
mkdir -p "$(dirname "${APP_DIR}")"

# `|| true` so a failure surfaces as launch.sh's own notification rather than
# a raw AppleScript error dialog full of shell output.
# Keep osacompile's own bundle identifier. Setting a custom one (and then
# rebuilding the app under it repeatedly) poisoned LaunchServices: three stale
# records accumulated for the same identifier and every launch failed silently
# afterwards — `open` exits 0, nothing runs, no crash report — and neither
# unregistering nor re-signing recovered it.
osacompile -o "${APP_DIR}" -e "do shell script \"'${LAUNCHER}' || true\""

# The icon is built ahead of time by radar/scripts/make-icon.py and committed,
# so installing needs no Python, no Pillow, and no sips/iconutil conversion
# chain — the step that used to silently produce an unusable iconset because
# icons/icon128.png is a JPEG wearing a .png name. Change logo.png, re-run
# make-icon.py, then re-run this script.
# osacompile bundles name their icon applet.icns — overwrite that one.
if [[ -f "${REPO_DIR}/icons/veritas-radar.icns" ]]; then
  cp "${REPO_DIR}/icons/veritas-radar.icns" "${APP_DIR}/Contents/Resources/applet.icns"
else
  echo "(no icons/veritas-radar.icns — run 'python3 radar/scripts/make-icon.py'; the app still works, it just wears the default icon)"
fi

# RE-SIGN LAST. osacompile signs the bundle on the way out, and every edit
# above (Info.plist keys, the icon) invalidates that signature — after which
# macOS silently refuses to launch the app, with no error and no crash log.
# This must stay the final mutation.
codesign --force --sign - "${APP_DIR}" >/dev/null 2>&1 \
  || echo "(could not re-sign the bundle — if it will not open, re-run this script)"

# Nudge LaunchServices so Finder picks up the new icon instead of a cached one.
touch "${APP_DIR}"
"${LSREGISTER}" -f "${APP_DIR}" >/dev/null 2>&1 || true

# Keep exactly one copy on the machine: duplicates of the same bundle identity
# in different folders reproduce the same silent-refusal failure.
DUPES="$(mdfind -name 'Veritas Radar.app' 2>/dev/null | grep -v "^${APP_DIR}$" || true)"
if [[ -n "${DUPES}" ]]; then
  echo "Warning: other copies exist and can stop this one launching. Remove them:"
  echo "${DUPES}" | sed 's/^/  /'
fi

echo "Installed: ${APP_DIR}"
echo "Double-click it in Finder, then drag it to your Dock."

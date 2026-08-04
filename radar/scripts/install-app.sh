#!/usr/bin/env bash
# Builds "Veritas Radar.app" — a real double-clickable app you can keep in the
# Dock — and points it at this checkout. Re-run it after moving the repo.
#
# The bundle is deliberately tiny: a stub that execs radar/scripts/launch.sh.
# No packaging step, no copy of the code, so the app never goes stale.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="${1:-/Applications}/Veritas Radar.app"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Veritas Radar</string>
  <key>CFBundleDisplayName</key><string>Veritas Radar</string>
  <key>CFBundleIdentifier</key><string>com.veritas.radar.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>VeritasRadar</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- Launch, open the browser, and get out of the way. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cat > "${APP_DIR}/Contents/MacOS/VeritasRadar" <<STUB
#!/bin/bash
exec "${REPO_DIR}/radar/scripts/launch.sh"
STUB
chmod +x "${APP_DIR}/Contents/MacOS/VeritasRadar"

# Reuse the extension's icon. Two gotchas, both silent: iconutil rejects an
# iconset that lacks the @2x variants, and icons/icon128.png is actually a
# JPEG — sips preserves the source format, so the output must be forced to
# PNG or iconutil refuses the lot.
if [[ -f "${REPO_DIR}/icons/icon128.png" ]] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  WORK="$(mktemp -d)/icon.iconset"
  mkdir -p "${WORK}"
  for size in 16 32 128 256 512; do
    sips -s format png -z "${size}" "${size}" "${REPO_DIR}/icons/icon128.png" \
      --out "${WORK}/icon_${size}x${size}.png" >/dev/null 2>&1 || true
    sips -s format png -z "$((size * 2))" "$((size * 2))" "${REPO_DIR}/icons/icon128.png" \
      --out "${WORK}/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "${WORK}" -o "${APP_DIR}/Contents/Resources/icon.icns" >/dev/null 2>&1 \
    || echo "(icon generation skipped — the app still works, it just wears the default icon)"
fi

echo "Installed: ${APP_DIR}"
echo "Open it once from Finder (right-click → Open the first time, since it is unsigned),"
echo "then drag it to your Dock."

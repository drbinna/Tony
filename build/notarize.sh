#!/usr/bin/env bash
# Build a signed + NOTARIZED Tony release.
#
# Your Apple app-specific password never goes on a command line or into git:
# put it once in build/notarize.env (gitignored), and this script loads it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f build/notarize.env ]; then
  set -a; . build/notarize.env; set +a
fi

: "${APPLE_ID:?Set APPLE_ID (fill build/notarize.env — see notarize.env.example)}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?Set APPLE_APP_SPECIFIC_PASSWORD (fill build/notarize.env)}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-8938U82HGG}"

echo "Building signed + notarized release for Apple ID: ${APPLE_ID}"
echo "Notarization uploads the app to Apple and can take 2–15 minutes…"
npm run dist:notarize

echo
echo "Verifying the notarization ticket is stapled…"
xcrun stapler validate "dist/Tony-0.1.0-universal.dmg" \
  && echo "✅ Stapled. This DMG opens with no Gatekeeper warning." \
  || echo "⚠️  Staple check failed — see the electron-builder log above."

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

# electron-builder notarizes and staples the .app INSIDE the dmg, but not the
# .dmg container itself — so a downloaded .dmg has no ticket of its own. Submit
# and staple it here so the disk image opens with no Gatekeeper prompt too.
DMG="dist/Tony-0.1.0-universal.dmg"
echo
echo "Notarizing the DMG container…"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
echo "Stapling the ticket to the DMG…"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG" \
  && echo "✅ App and DMG both notarized + stapled. Clean-install ready." \
  || echo "⚠️  DMG staple failed — see above."

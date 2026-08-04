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

# electron-builder notarizes and staples the .app INSIDE each dmg, but not the
# .dmg container itself — so a downloaded .dmg has no ticket of its own. Submit
# and staple every dmg here so each disk image opens with no Gatekeeper prompt.
echo
for DMG in dist/*.dmg; do
  echo "Notarizing the DMG container: $DMG …"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait
  echo "Stapling the ticket to $DMG …"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG" \
    && echo "✅ $DMG notarized + stapled." \
    || echo "⚠️  $DMG staple failed — see above."
done
echo "All DMGs processed."

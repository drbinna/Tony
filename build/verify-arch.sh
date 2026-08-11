#!/usr/bin/env bash
# Fail the release if a built .app has the wrong architecture. Guards two silent
# failure modes: observer/build.sh falling back to a native-only Swift binary
# (so the wrong arch ships in one DMG), and electron-builder mis-targeting an
# arch. Runs after the build, before the release is un-drafted — a bad build
# stays an invisible draft instead of reaching users.
#
# electron-builder lays the apps down at:
#   dist/mac-arm64/Tony.app  (arm64)   dist/mac/Tony.app  (x64)
set -uo pipefail
fail=0

check_main() {   # app_dir  expected_arch
  local app="$1" want="$2" bin
  bin="$app/Contents/MacOS/Tony"
  if [ ! -f "$bin" ]; then echo "❌ missing main binary: $bin"; fail=1; return; fi
  local archs; archs=$(lipo -archs "$bin" 2>/dev/null)
  if echo "$archs" | grep -qw "$want"; then
    echo "✓ $(basename "$app") main = [$archs] (has $want)"
  else
    echo "❌ $(basename "$app") main = [$archs], expected $want"; fail=1
  fi
}

check_universal() {   # app_dir
  local app="$1" b f archs
  for b in ax-dump drive; do
    f=$(find "$app/Contents/Resources" -name "$b" -type f 2>/dev/null | head -1)
    if [ -z "$f" ]; then echo "❌ $(basename "$app"): Swift '$b' not found"; fail=1; continue; fi
    archs=$(lipo -archs "$f" 2>/dev/null)
    if echo "$archs" | grep -qw x86_64 && echo "$archs" | grep -qw arm64; then
      echo "✓ $(basename "$app") $b = universal [$archs]"
    else
      echo "❌ $(basename "$app") $b = [$archs], expected universal (x86_64 + arm64)"; fail=1
    fi
  done
}

check_main      dist/mac-arm64/Tony.app arm64
check_main      dist/mac/Tony.app       x86_64
check_universal dist/mac-arm64/Tony.app
check_universal dist/mac/Tony.app

if [ "$fail" = 0 ]; then echo "ARCH GUARD PASSED"; else echo "ARCH GUARD FAILED"; exit 1; fi

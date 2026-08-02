#!/usr/bin/env bash
# Compile the AX tree dumper. Requires Xcode command line tools:
#   xcode-select --install
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "observer: skipping build (macOS only) — Tony will report an observer error" >&2
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "observer: swiftc not found. Run: xcode-select --install" >&2
  exit 1
fi

# Universal binaries: the packaged app ships to both Intel and Apple Silicon.
# Falls back to a native-only build if the cross-target SDK isn't available.
build_universal() {
  local src="$1" out="$2"
  if swiftc -O -framework AppKit -framework ApplicationServices \
       -target x86_64-apple-macos12 -o "${out}-x64" "$src" 2>/dev/null \
     && swiftc -O -framework AppKit -framework ApplicationServices \
       -target arm64-apple-macos12 -o "${out}-arm64" "$src" 2>/dev/null; then
    lipo -create -output "$out" "${out}-x64" "${out}-arm64"
    rm -f "${out}-x64" "${out}-arm64"
    echo "observer: built ./${out} (universal)"
  else
    swiftc -O -framework AppKit -framework ApplicationServices -o "$out" "$src"
    echo "observer: built ./${out} ($(uname -m) only)"
  fi
}

build_universal ax-dump.swift ax-dump
build_universal drive.swift drive

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

swiftc -O -framework AppKit -framework ApplicationServices \
  -o ax-dump ax-dump.swift
echo "observer: built ./ax-dump"

swiftc -O -framework AppKit -framework ApplicationServices \
  -o drive drive.swift
echo "observer: built ./drive"

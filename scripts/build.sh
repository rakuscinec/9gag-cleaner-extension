#!/usr/bin/env bash
# Builds the Chrome Web Store package from extension/ into dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/manifest.json")"
OUT="$ROOT/dist/comment-cleaner-for-9gag-$VERSION.zip"

mkdir -p "$ROOT/dist"
rm -f "$OUT"
cd "$SRC"
zip -X -q -r "$OUT" . -x '.*' -x '*/.*'
echo "Built $OUT"
unzip -l "$OUT"

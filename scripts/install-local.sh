#!/bin/sh
# Install the `bun run build:local` app into /Applications, replacing the
# running Agetor. Agents keep running in tmux across the swap and the new
# app reattaches to them on launch.
#
#   bun run build:local && bun run install:local
#
# Before swapping it backs up ~/.agetor/agetor.sqlite and the current app to
# ~/.agetor/backups/, so rolling back is: quit Agetor, unzip the previous app
# into /Applications, and (only if a migration ran) restore the database.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$ROOT/artifacts/stable-macos-arm64-Agetor.app.tar.zst"
TARGET="/Applications/Agetor.app"
DATA_DIR="$HOME/.agetor"
BACKUPS="$DATA_DIR/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -f "$ARCHIVE" ] || { echo "no $ARCHIVE — run 'bun run build:local' first" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xf "$ARCHIVE" -C "$STAGE"
[ -d "$STAGE/Agetor.app" ] || { echo "archive has no Agetor.app" >&2; exit 1; }
# Electrobun skips signing for local builds; give the bundle a consistent
# ad-hoc signature so macOS treats it as one app.
codesign --force --deep --sign - "$STAGE/Agetor.app"

mkdir -p "$BACKUPS"
if [ -f "$DATA_DIR/agetor.sqlite" ]; then
  sqlite3 "$DATA_DIR/agetor.sqlite" ".backup '$BACKUPS/agetor.sqlite.$STAMP'"
  echo "backed up database → $BACKUPS/agetor.sqlite.$STAMP"
fi
if [ -d "$TARGET" ]; then
  ditto -c -k --keepParent "$TARGET" "$BACKUPS/Agetor.app.$STAMP.zip"
  echo "backed up app → $BACKUPS/Agetor.app.$STAMP.zip"
fi

if pgrep -f "$TARGET/Contents/MacOS" >/dev/null; then
  echo "quitting Agetor (agents keep running in tmux)…"
  osascript -e 'quit app "Agetor"' >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$TARGET/Contents/MacOS" >/dev/null; do
    i=$((i + 1))
    [ "$i" -le 30 ] || { echo "Agetor didn't quit — quit it and re-run" >&2; exit 1; }
    sleep 1
  done
fi

rm -rf "$TARGET"
ditto "$STAGE/Agetor.app" "$TARGET"
echo "installed $(git -C "$ROOT" rev-parse --short HEAD) → $TARGET"
open "$TARGET"

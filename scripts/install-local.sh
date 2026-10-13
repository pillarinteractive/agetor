#!/bin/sh
# Install the `bun run build:local` app into /Applications, replacing the
# running Agetor. Agents keep running in tmux across the swap and the new
# app reattaches to them on launch.
#
#   bun run build:local && bun run install:local
#
# It also compiles the `agetor` CLI into ~/.agetor/bin/agetor for the
# Conductor agent.
#
# Before swapping it backs up ~/.agetor/agetor.sqlite and moves the current
# app into ~/.agetor/backups/, so rolling back is: quit Agetor, move the
# previous app back into /Applications, and (only if a migration ran) restore
# the database.
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

# The `agetor` CLI the Conductor agent drives (src/bun/conductor.ts), built
# from the same commit as the app so their routes match. Built before the
# swap so a compile error leaves the running app alone.
mkdir -p "$DATA_DIR/bin"
bun build "$ROOT/src/cli/index.ts" --compile --outfile "$STAGE/agetor" >/dev/null
mv -f "$STAGE/agetor" "$DATA_DIR/bin/agetor"
echo "installed CLI → $DATA_DIR/bin/agetor"
# The keepalive check launchd runs once `agetor keepalive on` is set
# (src/bun/keepalive.ts). Installing it changes nothing until then.
install -m 755 "$ROOT/scripts/keepalive/agetor-keepalive.sh" "$DATA_DIR/bin/agetor-keepalive"
echo "installed keepalive check → $DATA_DIR/bin/agetor-keepalive"

mkdir -p "$BACKUPS"
if [ -f "$DATA_DIR/agetor.sqlite" ]; then
  sqlite3 "$DATA_DIR/agetor.sqlite" ".backup '$BACKUPS/agetor.sqlite.$STAMP'"
  echo "backed up database → $BACKUPS/agetor.sqlite.$STAMP"
fi
if pgrep -f "$TARGET/Contents/MacOS" >/dev/null; then
  echo "quitting Agetor — confirm Quit if it asks (agents keep running in tmux)…"
  osascript -e 'quit app "Agetor"' >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$TARGET/Contents/MacOS" >/dev/null; do
    i=$((i + 1))
    [ "$i" -le 300 ] || { echo "Agetor didn't quit — quit it and re-run" >&2; exit 1; }
    sleep 1
  done
fi

# Move the old bundle aside rather than deleting it: a tmux server started by
# an older Agetor can still have Contents/MacOS as its working directory, and
# deleting it breaks every new agent session until that server restarts.
if [ -d "$TARGET" ]; then
  mv "$TARGET" "$BACKUPS/Agetor.app.$STAMP"
  echo "moved previous app → $BACKUPS/Agetor.app.$STAMP"
fi
ditto "$STAGE/Agetor.app" "$TARGET"
echo "installed $(git -C "$ROOT" rev-parse --short HEAD) → $TARGET"
open "$TARGET"

# Each install leaves one app bundle and one database copy in the backups
# folder. Keep the newest few. An older bundle that a process still has as its
# working directory stays (see the note above about tmux servers).
KEEP_APPS=3
KEEP_DBS=5
before_kb="$(du -sk "$BACKUPS" | cut -f1)"
in_use="$(lsof -a -d cwd 2>/dev/null || true)"
ls -1d "$BACKUPS"/Agetor.app.* 2>/dev/null | sort -r | tail -n +"$((KEEP_APPS + 1))" | while IFS= read -r old; do
  case "$in_use" in
    *"$old"*) echo "kept $old (still in use)" ;;
    *) rm -rf "$old" ;;
  esac
done
ls -1 "$BACKUPS"/agetor.sqlite.* 2>/dev/null | sort -r | tail -n +"$((KEEP_DBS + 1))" | while IFS= read -r old; do
  rm -f "$old"
done
after_kb="$(du -sk "$BACKUPS" | cut -f1)"
echo "pruned backups: kept $KEEP_APPS apps and $KEEP_DBS databases, freed $(( (before_kb - after_kb) / 1024 )) MB"

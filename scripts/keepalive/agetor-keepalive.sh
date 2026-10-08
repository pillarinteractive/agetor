#!/bin/sh
# Agetor keepalive check (src/bun/keepalive.ts). launchd runs this every few
# minutes (LaunchAgent com.pillarinteractive.agetor.keepalive, managed with
# `agetor keepalive on|off|status`). It reopens Agetor only when
#   (a) keepalive is enabled:   $AGETOR_DATA_DIR/keepalive-enabled exists,
#   (b) no Agetor app process is running, and
#   (c) the last exit wasn't a deliberate quit: no $AGETOR_DATA_DIR/keepalive-quit
#       (a quit the user approves writes it; the next launch clears it).
# `open -a` never starts a second instance: Launch Services dedupes by bundle id.
#
# Installed to ~/.agetor/bin/agetor-keepalive by `bun run install:local`.
set -u

DATA="${AGETOR_DATA_DIR:-$HOME/.agetor}"
APP="${AGETOR_APP:-/Applications/Agetor.app}"
LOG="$DATA/keepalive.log"

[ -f "$DATA/keepalive-enabled" ] || exit 0
[ -f "$DATA/keepalive-quit" ] && exit 0
# Mid-install (install:local moves the old bundle aside first) or uninstalled.
[ -x "$APP/Contents/MacOS/launcher" ] || exit 0
# The app's own processes: the launcher and its main.js. Not the core child
# alone — it exits by itself within seconds once the app is gone.
if pgrep -f "$APP/Contents/MacOS/(launcher|\.\./Resources/main\.js)" >/dev/null 2>&1; then
  exit 0
fi

# Crash-loop guard: at most 5 reopens per hour (an app that dies on every
# launch needs a person, not a relaunch every few minutes).
NOW="$(date +%s)"
STAMPS="$DATA/keepalive-reopens"
RECENT="$(awk -v now="$NOW" 'now - $1 < 3600' "$STAMPS" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${RECENT:-0}" -ge 5 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') Agetor isn't running, but it was reopened 5 times in the last hour — not reopening" >> "$LOG"
  exit 0
fi
{ awk -v now="$NOW" 'now - $1 < 3600' "$STAMPS" 2>/dev/null; echo "$NOW"; } > "$STAMPS.tmp" && mv "$STAMPS.tmp" "$STAMPS"

echo "$(date '+%Y-%m-%d %H:%M:%S') Agetor isn't running and wasn't quit on purpose — reopening it" >> "$LOG"
open -a "$APP" >> "$LOG" 2>&1 || echo "$(date '+%Y-%m-%d %H:%M:%S') open -a failed" >> "$LOG"
exit 0

#!/usr/bin/env sh
# Manual installer for pi-sync (the non-pi way).
#
#   sh install.sh
#
# Copies extensions/pi-sync.ts into $PI_CODING_AGENT_DIR/extensions (default
# ~/.pi/agent/extensions). Prefer `pi install git:github.com/Tehnocrat/pi-sync-vibecoded`
# if you have pi: that keeps the package updatable via `pi update`.
set -eu

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$AGENT_DIR/extensions"

mkdir -p "$DEST"
cp "$HERE/extensions/pi-sync.ts" "$DEST/pi-sync.ts"

echo "Installed pi-sync to $DEST/pi-sync.ts"
echo
echo "Next: restart pi (or run /reload), then:"
echo "  /sync-init https://github.com/<you>/<your-private-config-repo>.git"
echo "  /sync-push \"initial config\""

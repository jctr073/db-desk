#!/bin/sh
# Copy the packaged "DB Desk.app" produced by `npm run package` into
# /Applications, replacing any previous install. Quit DB Desk first if it is
# running from /Applications.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="DB Desk.app"
DEST="/Applications/$NAME"

APP="$(/usr/bin/find "$ROOT/dist" -maxdepth 2 -name "$NAME" -type d 2>/dev/null | head -n 1)"
if [ -z "$APP" ]; then
  echo "No packaged app under dist/ — run 'npm run package' first." >&2
  exit 1
fi

rm -rf "$DEST"
# ditto preserves the bundle's metadata and code signature, unlike cp -r.
ditto "$APP" "$DEST"
echo "Installed $DEST"

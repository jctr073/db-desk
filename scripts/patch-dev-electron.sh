#!/bin/sh
# On macOS the menu-bar app name and Finder/Dock icon come from the running
# bundle's Info.plist, not app.setName(). In development that bundle is
# node_modules/electron/dist/Electron.app, so patch its name and icon there.
# Idempotent; wired to postinstall and predev so it survives npm install.
set -eu

[ "$(uname)" = "Darwin" ] || exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
ICNS="$ROOT/resources/icon.icns"
NAME="DB Desk"
PB=/usr/libexec/PlistBuddy

[ -f "$PLIST" ] || exit 0

changed=0

if [ "$($PB -c 'Print :CFBundleName' "$PLIST" 2>/dev/null || true)" != "$NAME" ]; then
  "$PB" -c "Set :CFBundleName $NAME" "$PLIST"
  changed=1
fi

if [ "$($PB -c 'Print :CFBundleDisplayName' "$PLIST" 2>/dev/null || true)" != "$NAME" ]; then
  "$PB" -c "Set :CFBundleDisplayName $NAME" "$PLIST" 2>/dev/null ||
    "$PB" -c "Add :CFBundleDisplayName string $NAME" "$PLIST"
  changed=1
fi

if [ -f "$ICNS" ] && ! cmp -s "$ICNS" "$APP/Contents/Resources/electron.icns"; then
  cp "$ICNS" "$APP/Contents/Resources/electron.icns"
  changed=1
fi

if [ "$changed" = 1 ]; then
  # Editing the bundle invalidates Electron's ad-hoc signature; re-sign or
  # macOS (notably Apple Silicon) will refuse to launch it.
  codesign --force --deep --sign - "$APP"
  # macOS caches bundle icons by path; bump mtime and re-register with
  # LaunchServices so the new name/icon actually show up.
  touch "$APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
  echo "patch-dev-electron: renamed dev Electron.app to \"$NAME\" and installed icon"
fi

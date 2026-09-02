#!/usr/bin/env bash
# מכין תיקיית www/ נקייה - עותק של קבצי האתר הסטטי בלבד, ללא node_modules/android/git.
# רץ לפני `npx cap sync android`.
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WWW_DIR="$ROOT_DIR/www"

rm -rf "$WWW_DIR"
mkdir -p "$WWW_DIR"

cp -r "$ROOT_DIR/index.html" "$WWW_DIR/"
cp -r "$ROOT_DIR/css" "$WWW_DIR/"
cp -r "$ROOT_DIR/js" "$WWW_DIR/"
cp -r "$ROOT_DIR/data" "$WWW_DIR/"
[ -d "$ROOT_DIR/icons" ] && cp -r "$ROOT_DIR/icons" "$WWW_DIR/"
[ -f "$ROOT_DIR/manifest.json" ] && cp "$ROOT_DIR/manifest.json" "$WWW_DIR/"
[ -f "$ROOT_DIR/sw.js" ] && cp "$ROOT_DIR/sw.js" "$WWW_DIR/"

echo "www/ מוכן ($(du -sh "$WWW_DIR" | cut -f1))"

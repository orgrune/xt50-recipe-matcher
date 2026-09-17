#!/bin/sh
# Builds build/icon.icns from build/icon.png (macOS only, uses sips + iconutil).
set -e
cd "$(dirname "$0")/.."
rm -rf build/icon.iconset && mkdir build/icon.iconset
for s in 16 32 128 256 512; do
  d=$((s*2))
  sips -z $s $s build/icon.png --out build/icon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $d $d build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "wrote build/icon.icns"

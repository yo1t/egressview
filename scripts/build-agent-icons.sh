#!/bin/bash
# Regenerate every raster icon asset from the SVG sources in design/icons/.
#
# The sources are the only thing that is edited by hand. Everything this script
# writes is derived and gitignored, so changing the artwork is: edit the SVG,
# run this, rebuild. Exporting sizes by hand would make an artwork change cost
# a full manual re-export, which is what kept the agent shipping without an
# icon at all.
#
# Usage: scripts/build-agent-icons.sh [output-dir]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/design/icons"
OUT="${1:-$ROOT/design/icons/build}"

command -v sips >/dev/null || { echo "sips not found (macOS only)" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "iconutil not found (macOS only)" >&2; exit 1; }

# Rasterise one SVG at one pixel size, preserving transparency.
#
# Not qlmanage: it produces a QuickLook *thumbnail*, which bakes an opaque
# background into the image. A menu bar template image treats every opaque
# pixel as part of the mask, so that turned the icon into a solid white square
# on the menu bar, and it would also have squared off the app icon's rounded
# corners. sips reads the SVG directly and keeps the alpha channel.
render() {
  local svg="$1" size="$2" dest="$3"
  sips -s format png -z "$size" "$size" "$svg" --out "$dest" >/dev/null 2>&1 \
    || { echo "render failed: $svg @${size}" >&2; exit 1; }
}

# Guard the property the menu bar depends on: a template image must be mostly
# transparent. Catching this here is the difference between a failed build and
# an icon that silently renders as a filled rectangle.
assert_transparent() {
  local png="$1"
  python3 - "$png" <<'PYEOF'
import struct, sys, zlib
path = sys.argv[1]
data = open(path, 'rb').read()
pos, idat, width, height, colour = 8, b'', 0, 0, 0
while pos < len(data):
    length = struct.unpack('>I', data[pos:pos + 4])[0]
    kind = data[pos + 4:pos + 8]
    if kind == b'IHDR':
        width, height, _, colour = struct.unpack('>IIBB', data[pos + 8:pos + 18])
    elif kind == b'IDAT':
        idat += data[pos + 8:pos + 8 + length]
    pos += 12 + length
if colour != 6:
    sys.exit(f'{path}: no alpha channel (colour type {colour})')
raw = zlib.decompress(idat)
bpp, stride, prev, i, clear = 4, width * 4, bytearray(width * 4), 0, 0
for _ in range(height):
    filt = raw[i]; i += 1
    line = bytearray(raw[i:i + stride]); i += stride
    for x in range(stride):
        a = line[x - bpp] if x >= bpp else 0
        b = prev[x]
        c = prev[x - bpp] if x >= bpp else 0
        if filt == 1: line[x] = (line[x] + a) & 255
        elif filt == 2: line[x] = (line[x] + b) & 255
        elif filt == 3: line[x] = (line[x] + (a + b) // 2) & 255
        elif filt == 4:
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    clear += sum(1 for x in range(width) if line[x * 4 + 3] < 50)
    prev = line
if clear < width * height * 0.25:
    sys.exit(f'{path}: only {clear}/{width * height} pixels are transparent; '
             'a template image would render as a filled block')
PYEOF
}

rm -rf "$OUT"
mkdir -p "$OUT"
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"

# 16 and 32 use the simplified mark: the secondary dots merge into one blob
# below ~32px, so the detailed mark is not just smaller there, it is wrong.
for spec in "16:small:icon_16x16.png" "32:small:icon_16x16@2x.png" \
            "32:small:icon_32x32.png" "64:small:icon_32x32@2x.png" \
            "128:full:icon_128x128.png" "256:full:icon_128x128@2x.png" \
            "256:full:icon_256x256.png" "512:full:icon_256x256@2x.png" \
            "512:full:icon_512x512.png" "1024:full:icon_512x512@2x.png"; do
  size="${spec%%:*}"; rest="${spec#*:}"; variant="${rest%%:*}"; name="${rest#*:}"
  case "$variant" in
    small) svg="$SRC/egressview-mark-small.svg" ;;
    full)  svg="$SRC/egressview-mark.svg" ;;
  esac
  render "$svg" "$size" "$ICONSET/$name"
done

iconutil --convert icns --output "$OUT/AppIcon.icns" "$ICONSET"

# Menu bar template images. macOS inverts a template image for light and dark
# menu bars, so these carry no colour of their own.
for state in "" "-paused" "-attention"; do
  src="$SRC/egressview-menubar-template${state}.svg"
  render "$src" 18 "$OUT/MenuBar${state}Template.png"
  render "$src" 36 "$OUT/MenuBar${state}Template@2x.png"
  render "$src" 54 "$OUT/MenuBar${state}Template@3x.png"
  assert_transparent "$OUT/MenuBar${state}Template.png"
done

# ---- Xcode asset catalog -------------------------------------------------
# Written straight to the Host source dir so Xcode can compile it. The whole
# catalog is generated and gitignored; the SVGs remain the only source.
CAT="$ROOT/apps/agent-macos/Xcode/Host/Assets.xcassets"
rm -rf "$CAT"
mkdir -p "$CAT/AppIcon.appiconset"
printf '{"info":{"author":"xcode","version":1}}\n' > "$CAT/Contents.json"

cp "$ICONSET"/*.png "$CAT/AppIcon.appiconset/"
cat > "$CAT/AppIcon.appiconset/Contents.json" <<'JSON'
{
  "images" : [
    { "idiom" : "mac", "scale" : "1x", "size" : "16x16",   "filename" : "icon_16x16.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "16x16",   "filename" : "icon_16x16@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "32x32",   "filename" : "icon_32x32.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "32x32",   "filename" : "icon_32x32@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "128x128", "filename" : "icon_128x128.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "128x128", "filename" : "icon_128x128@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "256x256", "filename" : "icon_256x256.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "256x256", "filename" : "icon_256x256@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "512x512", "filename" : "icon_512x512.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "512x512", "filename" : "icon_512x512@2x.png" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

# Menu bar imagesets. template-rendering-intent makes macOS invert them for the
# light and dark menu bar, which is why the SVGs carry no colour of their own.
for state in "" "-paused" "-attention"; do
  case "$state" in
    "")           name="MenuBar" ;;
    "-paused")    name="MenuBarPaused" ;;
    "-attention") name="MenuBarAttention" ;;
  esac
  dir="$CAT/$name.imageset"
  mkdir -p "$dir"
  cp "$OUT/MenuBar${state}Template.png"    "$dir/$name.png"
  cp "$OUT/MenuBar${state}Template@2x.png" "$dir/$name@2x.png"
  cp "$OUT/MenuBar${state}Template@3x.png" "$dir/$name@3x.png"
  cat > "$dir/Contents.json" <<JSON
{
  "images" : [
    { "idiom" : "universal", "scale" : "1x", "filename" : "$name.png" },
    { "idiom" : "universal", "scale" : "2x", "filename" : "$name@2x.png" },
    { "idiom" : "universal", "scale" : "3x", "filename" : "$name@3x.png" }
  ],
  "info" : { "author" : "xcode", "version" : 1 },
  "properties" : { "template-rendering-intent" : "template" }
}
JSON
done

echo "Wrote:"
echo "  $CAT (AppIcon + MenuBar/MenuBarPaused/MenuBarAttention)"
echo "  $OUT/AppIcon.icns"
echo "  $ICONSET ($(ls "$ICONSET" | wc -l | tr -d ' ') png)"
echo "  $OUT/MenuBar*Template*.png ($(ls "$OUT"/MenuBar*.png | wc -l | tr -d ' ') files)"

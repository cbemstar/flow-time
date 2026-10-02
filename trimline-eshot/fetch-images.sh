#!/usr/bin/env bash
# Downloads the e-shot images from Figma (links expire after 7 days) and
# prepares email-safe versions: SVGs -> PNG @2x, image-in-text cropped.
# Needs: curl, ImageMagick (`magick` or `convert`). rsvg-convert is used for SVGs if present.
set -euo pipefail
cd "$(dirname "$0")/images"
P="https://www.figma.com/api/mcp/asset/2156b3f6-b26b-499a-9d3a-fd47991a2e08"
IM=$(command -v magick || command -v convert)

get() { curl -fsSL -o "$2" "$P/$1"; }

get c3202.png trimline-logo.png
get b7a9e.png hero.png
get b30be.png image-in-text-src.png
get 6c22e.png atrim-src.png
get 0d57d.png signature.png
get 0bd21.png trimline-mark.png
get 498f7.png trimline-logo-white.png

for pair in 354f9:facebook:36 c449c:linkedin:36 dee90:instagram:36 8dea3:x:36 \
            77be2:bullet:12 5f94f:dukkaboard:70 d5d39:onboard:70 86c50:validus:70 \
            771f3:pyro-echo:56 c06e5:phone:20 b9e13:mail:20; do
  IFS=: read -r id name w <<<"$pair"
  get "$id.svg" "$name.svg"
  # render at 2x for retina; width attribute in the HTML keeps it at 1x
  if command -v rsvg-convert >/dev/null; then rsvg-convert -w $((w*2)) "$name.svg" -o "$name.png"
  else "$IM" -background none -density 384 "$name.svg" -resize "$((w*2))x" "$name.png"; fi
done

# Image in text: Figma shows the source at 528x396, window starts 100px down, 140px tall (2x).
"$IM" image-in-text-src.png -resize 1056x792! -crop 1056x280+0+200 +repage image-in-text.png
# Atrim logo tile: source is positioned at 67x16 inside the 92px tile.
"$IM" atrim-src.png -resize 134x32 atrim-logo.png

echo "Done. Upload everything in images/*.png to the Dynamics 365 Files library and swap the src URLs."

#!/bin/sh
# Renders one cut, normalises its loudness to -14 LUFS, and writes its
# thumbnail (frame 0, the cold open) next to it, also embedded as cover art.
#   scripts/render.sh DocBroTeaser docbro-teaser
set -e
comp=$1
name=$2
cd "$(dirname "$0")/.."
mkdir -p out
npx remotion render "$comp" "out/$name.raw.mp4"
npx remotion still "$comp" "out/$name-thumbnail.png" --frame=0
ffmpeg -y -loglevel error -i "out/$name.raw.mp4" -i "out/$name-thumbnail.png" \
  -map 0:v -map 0:a -map 1:v -c:v:0 copy -c:v:1 png -disposition:v:1 attached_pic \
  -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 192k \
  "out/$name.mp4"
rm "out/$name.raw.mp4"
echo "out/$name.mp4 + out/$name-thumbnail.png"

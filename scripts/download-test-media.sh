#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOWNLOADS="$ROOT/test/fixtures/downloads"
MEDIA="$ROOT/test/fixtures/media"
SOURCE="$DOWNLOADS/BigBuckBunny_320x180.mp4"
URL="https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4"

mkdir -p "$DOWNLOADS" "$MEDIA"
curl --location --fail --show-error --output "$SOURCE" "$URL"

EXPECTED="f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508"
ACTUAL="$(shasum -a 256 "$SOURCE" | awk '{print $1}')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Source checksum mismatch: expected $EXPECTED, got $ACTUAL" >&2
  exit 1
fi

ffmpeg -hide_banner -loglevel error -y -ss 20 -i "$SOURCE" -t 4 \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -an -movflags +faststart "$MEDIA/bunny-template.mp4"

ffmpeg -hide_banner -loglevel error -y -i "$MEDIA/bunny-template.mp4" -t 1 \
  -vf "scale=3840:2160:flags=lanczos" -an \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p \
  -movflags +faststart "$MEDIA/bunny-4k.mp4"

ffmpeg -hide_banner -loglevel error -y -ss 30 -i "$SOURCE" -t 2 \
  -vf "crop=180:180:70:0,scale=180:180" -c:v libvpx-vp9 -crf 34 -b:v 0 \
  -an "$MEDIA/bunny-square.webm"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=220:duration=4:sample_rate=48000" \
  -f lavfi -i "sine=frequency=277.18:duration=4:sample_rate=48000" \
  -f lavfi -i "sine=frequency=329.63:duration=4:sample_rate=48000" \
  -filter_complex "[0:a]volume=0.10[a0];[1:a]volume=0.07[a1];[2:a]volume=0.06[a2];[a0][a1][a2]amix=inputs=3:normalize=0,afade=t=in:d=0.2,afade=t=out:st=3.5:d=0.5" \
  -c:a libopus -b:a 96k "$MEDIA/yumcut-demo-music.ogg"

ffmpeg -hide_banner -loglevel error -y -ss 25 -i "$SOURCE" \
  -frames:v 1 -q:v 2 "$MEDIA/bunny-poster.jpg"

shasum -a 256 "$MEDIA"/*

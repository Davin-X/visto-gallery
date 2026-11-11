#!/usr/bin/env bash
#
# Build the `ffmpeg` and `ffprobe` sidecars the app ships.
#
# Homebrew's binaries are useless here: they are ~400 KB shims linked against
# 37 dylibs in the Cellar, so copying them means shipping a Homebrew install.
# A static build with only the components VistoGallery calls is a few megabytes
# and depends on nothing but libSystem.
#
# The feature list below is exactly what the app does:
#   * probe   — read container and stream headers (demuxers, no decoders)
#   * remux   — copy the video stream into MP4, re-encode audio to AAC-LC
#   * poster  — decode one frame of any supported video and scale it to JPEG
#
# Anything missing here shows up as a specific failure, not a silent one: a
# missing decoder means "ffmpeg could not extract a frame", a missing muxer
# means "ffmpeg could not remux this file".
#
# Usage: bash scripts/build-ffmpeg.sh [version]     (default 7.1)
set -euo pipefail

VERSION="${1:-${FFMPEG_VERSION:-7.1}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries"
WORK="${VISTO_FFMPEG_WORK:-${TMPDIR:-/tmp}/visto-ffmpeg-build}"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

mkdir -p "$OUT" "$WORK"
SRC="$WORK/ffmpeg-$VERSION"
TARBALL="$WORK/ffmpeg-$VERSION.tar.xz"

TRIPLE="$(rustc -vV | awk '/^host: /{print $2}')"

# Building is minutes of work; leave an existing pair alone unless asked.
if [ "${VISTO_FFMPEG_FORCE:-0}" != "1" ] \
  && [ -x "$OUT/ffmpeg-$TRIPLE" ] \
  && [ -x "$OUT/ffprobe-$TRIPLE" ]; then
  echo "==> sidecars already built in $OUT (VISTO_FFMPEG_FORCE=1 to rebuild)"
  exit 0
fi

if [ ! -d "$SRC" ]; then
  if [ ! -f "$TARBALL" ]; then
    echo "==> downloading ffmpeg $VERSION"
    curl -fsSL -C - --retry 3 --retry-delay 2 \
      -o "$TARBALL" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
  fi
  tar -xJf "$TARBALL" -C "$WORK"
fi

cd "$SRC"

# Every codec the library can hold, so a poster is never refused for a format
# the player accepts.
DEMUXERS="mov,matroska,avi,asf,flv,mpegts,mpegps,ogg,wav,mp3,aac,flac,image2,apng"
VIDEO_DECODERS="h264,hevc,vp8,vp9,av1,mpeg4,mpeg2video,mpeg1video,mjpeg,png,prores,theora,wmv1,wmv2,wmv3,vc1,dvvideo,h263,rawvideo"
AUDIO_DECODERS="aac,ac3,eac3,dts,truehd,mlp,flac,opus,vorbis,mp2,mp3,alac,wmav1,wmav2,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_u8"
PARSERS="h264,hevc,vp9,av1,mpeg4video,mpegaudio,aac,ac3,dts,opus,vorbis,png,mjpeg"
BSFS="aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata"

echo "==> configuring ffmpeg $VERSION"
./configure \
  --prefix="$WORK/install" \
  --disable-autodetect \
  --disable-everything \
  --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-network \
  --disable-debug \
  --enable-static --disable-shared \
  --enable-protocol=file,pipe \
  --enable-demuxer="$DEMUXERS" \
  --enable-muxer=mp4,mov,image2 \
  --enable-decoder="$VIDEO_DECODERS,$AUDIO_DECODERS" \
  --enable-encoder=aac,ac3,vp9,mjpeg,png \
  --enable-parser="$PARSERS" \
  --enable-bsf="$BSFS" \
  --enable-filter=scale,format,crop,pad,setsar,aresample,anull,null,transpose,fps \
  --enable-ffmpeg --enable-ffprobe \
  --extra-cflags="-O2" \
  >"$WORK/configure.log" 2>&1 || {
    echo "configure failed; see $WORK/configure.log" >&2
    tail -20 "$WORK/configure.log" >&2
    exit 1
  }

echo "==> building (jobs=$JOBS)"
make -j"$JOBS" ffmpeg ffprobe >"$WORK/make.log" 2>&1 || {
  echo "build failed; see $WORK/make.log" >&2
  tail -20 "$WORK/make.log" >&2
  exit 1
}

for tool in ffmpeg ffprobe; do
  install -m 755 "$SRC/$tool" "$OUT/$tool-$TRIPLE"
  # Static builds sometimes keep a non-system dependency; fail loudly rather
  # than ship a binary that only runs on this machine.
  foreign="$(otool -L "$OUT/$tool-$TRIPLE" | tail -n +2 | awk '{print $1}' | grep -v '^/usr/lib/' | grep -v '^/System/' || true)"
  if [ -n "$foreign" ]; then
    echo "error: $tool links against non-system libraries:" >&2
    echo "$foreign" >&2
    exit 1
  fi
  printf '%-30s %s\n' "$tool-$TRIPLE" "$(du -h "$OUT/$tool-$TRIPLE" | cut -f1)"
done

echo "==> done: $OUT"

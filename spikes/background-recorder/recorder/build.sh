#!/usr/bin/env bash
# Cross-compiles iptvnator_mpv_recorder.exe with mingw-w64 against the pinned
# Windows libmpv (tools/embedded-mpv/windows-runtime-pin.json).
# Usage: build.sh <extracted mpv-dev dir> <output dir>
set -euo pipefail
MPV_DEV=${1:?mpv-dev dir with include/ and libmpv.dll.a}
OUT=${2:?output dir}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
x86_64-w64-mingw32-g++ -std=c++17 -O2 -Wall \
    -I"$MPV_DEV/include" \
    "$HERE/mpv_recorder.cpp" "$MPV_DEV/libmpv.dll.a" \
    -static -static-libgcc -static-libstdc++ \
    -o "$OUT/iptvnator_mpv_recorder.exe"
cp "$MPV_DEV/libmpv-2.dll" "$OUT/"
echo "built $OUT/iptvnator_mpv_recorder.exe"

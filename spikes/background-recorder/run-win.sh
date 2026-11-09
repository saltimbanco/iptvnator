#!/usr/bin/env bash
# Copies the spike scripts to the Windows work dir and runs one with Windows
# Node. Usage: run-win.sh <script.mjs> [args…]   (args use Windows paths)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_DIR=${SPIKE_WIN_DIR:-/mnt/c/Users/Tolis/AppData/Local/Temp/iptvnator-recorder-spike}
NODE=${SPIKE_WIN_NODE:-/mnt/c/apps/nodejs/node.exe}
mkdir -p "$WIN_DIR"
cp "$HERE"/*.mjs "$HERE"/player.html "$WIN_DIR/"
mkdir -p "$WIN_DIR/vendor"
ROOT=$(cd "$HERE/../.." && pwd)
cp "$ROOT/node_modules/mpegts.js/dist/mpegts.js" "$ROOT/node_modules/hls.js/dist/hls.min.js" "$WIN_DIR/vendor/"
script=$1; shift
cd "$WIN_DIR"
exec "$NODE" "$script" "$@"

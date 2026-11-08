# Background recorder spike (Windows)

Throwaway prototype for Windows background recording: a headless libmpv
recorder process that owns the single provider connection, plus a localhost
relay that lets the visible player watch the recording live or timeshifted.
Not production code; nothing here is wired into the app.

## Pieces

| File | What it is |
| --- | --- |
| `apps/electron-backend/native/helper/mpv_recorder.cpp` (moved there from this folder) | `iptvnator_mpv_recorder.exe`: libmpv with `vo=null`, `ao=null`, frame decoding skipped, `stream-record` into `.ts` files. Reuses `apps/electron-backend/native/helper/frame_helper_io.h`: tab-separated, percent-encoded commands on stdin (`open`, `rotate`, `stop`, `quit`; EOF quits), JSON events on stdout (`ready`, `opened`, `recording`, `buffering`, `record-failed`, `ended`, `stopped`, `log`). URLs and headers only travel over stdin; log lines containing URLs are redacted. |
| `recorder/build.sh` | mingw-w64 cross-compile against the pinned Windows libmpv dev archive (`tools/embedded-mpv/windows-runtime-pin.json`). |
| `ts-index.mjs` | Incremental MPEG-TS indexer over the growing files: PAT/PMT cache, keyframes with PTS, HLS segment cuts, virtual reads across files. |
| `relay.mjs` | `127.0.0.1` HTTP server, random token in the path: `live.ts` (PAT+PMT, newest keyframe, then tail; ends at a file boundary), `timeshift.m3u8` (EVENT playlist, `BYTERANGE` into `rec.ts`, discontinuity per file, `ENDLIST` when done), `rec.ts` with Range. |
| `session.mjs` | Windows Node driver: spawns the recorder, runs the relay, rotates files, logs size and recorder CPU/memory. |
| `player.html` | `?mode=live` (mpegts.js, reopens `live.ts` when it ends) and `?mode=timeshift&target=N` (hls.js). |
| `electron-probe.mjs` | Plays both modes in Electron's Chromium (has H.264/AAC) and screenshots the burned-in clock. |
| `mock-provider.mjs` | ffmpeg test pattern with a wall-clock overlay, served as TS on `:8099`; requires `X-Token: spike` and logs UA, referer and concurrent connections. |
| `run-win.sh` | Copies the scripts to a Windows folder and runs them with Windows `node.exe` from WSL. |

## Running (WSL host, Windows node)

```sh
./recorder/build.sh /tmp/mpvwin/ext "$WIN_DIR/bin"
node mock-provider.mjs 8099 &
./run-win.sh session.mjs --bin "$W\\bin" --out "$W\\rec" \
  --url http://127.0.0.1:8099/live/news.ts --duration 200 --rotate-every 45 --token t
# then, from the repo root (Playwright's _electron needs the repo's node_modules):
node electron-probe.mjs http://127.0.0.1:8790/t /tmp/probe-out
```

## Results (Windows via WSL interop, pinned libmpv, 720p25 H.264 + AAC at ~2.6 Mbit/s)

- **Recorder cost:** 4.0–4.7 s CPU over 200–240 s of recording, about 2% of one
  core; 40 MB working set at start, 120–136 MB after 4 minutes (demuxer cache).
- **Single connection:** the provider saw one connection (peak 1) while the
  relay served mpegts.js, hls.js, ffmpeg and two libmpv readers. UA, referer
  and custom headers from stdin reached the provider.
- **Files:** valid 1280x720 H.264 + AAC TS. Each file starts with about one GOP
  that cannot be decoded (joining mid-GOP); players skip it.
- **mpv rebases timestamps per file.** Every `stream-record` file starts near
  PTS 0, so rotated files are separate timelines: HLS needs
  `#EXT-X-DISCONTINUITY` per file, and the live tail must end at a file
  boundary so the player reopens. Rotate only when the stream itself restarts
  (reconnect, failover), not on a timer.
- **mpv does not create the output folder.** Setting `stream-record` succeeds,
  then mpv logs `recorder: Failed opening output file.` and keeps playing
  without recording. The recorder now turns that into one `record-failed`
  event per file; the supervisor must also create the folder first.

### Latency against the burned-in clock (wall clock at screenshot → frame shown)

| Mode | Measured | Notes |
| --- | --- | --- |
| Live, mpegts.js on `live.ts` | 1 s (18:29:29 → 18:29:28; 18:30:15 → 18:30:14) | 2 s right after a rotation. Includes encode, recorder and relay. |
| Timeshift at live edge, hls.js, 2 s segments | 4 s (18:30:31 → 18:30:27) | `liveSyncDurationCount: 2` |
| Timeshift, back to live | 5 s | |
| Timeshift, 1 s segments | 4 s (18:30:55 → 18:30:51) | Shorter segments did not help. |

So the design should play `live.ts` at the live edge and switch to the HLS
timeshift view only on pause or seek; *Back to live* switches back.

### Player matrix

| Reader | `live.ts` | `timeshift.m3u8` |
| --- | --- | --- |
| mpegts.js (Electron) | plays; reopens across a rotation (several quick reopens while the new file has no keyframe yet; add a backoff) | — |
| hls.js (Electron) | — | plays near live, crosses discontinuities, seek to 5 s and back to live work, no errors |
| ffmpeg | 0 decode errors, 25 fps | 250 frames in 10 s from the start, no errors |
| libmpv (the recorder exe as reader, i.e. embedded MPV's engine) | 522 frames in 21 s | 548 frames in 22 s |

Not tested: VLC and external `mpv.exe` (not installed), Video.js/ArtPlayer
wrappers (they use the same mpegts.js/hls.js engines), real Stalker/Xtream
providers, HLS provider streams.

## After the spike

The recorder source moved to `apps/electron-backend/native/helper/` and lost
its `rotate` command: the app starts one recorder process per file. So
`session.mjs --rotate-every` only works with the recorder from the spike
commit.

## Left for the real implementation

- Supervisor: crash and stall detection, restart into a new file,
  re-resolving short-lived Stalker links on every (re)start.
- Folder creation and `record-failed` handling in the main process.
- Live reopen backoff in the relay view.
- Building, signing and packaging the exe with the Windows runtime.

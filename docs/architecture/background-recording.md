# Background recording (Windows)

Background recording captures a live channel in a separate mpv process that
owns the provider connection, so a recording survives channel changes,
navigation and a hidden window. It is Windows only and runs one recording at
a time. Recordings made inside the embedded MPV player (`stream-record` on the
playing session) are a separate, older path; see
[embedded MPV](embedded-mpv-native.md#live-stream-recording).

Status: the main-process core is in place (recorder executable, service,
IPC, persistence) and scheduled recordings plus the tray lifetime are built
on top of it. The in-player Record button, takeover, switch guard and the
relay player view are not built yet; recordings are started from the channel
context menu and by the scheduler, and past ones play in the inline player
(`/workspace/downloads/recording-player/:recordingId`).

## Recorder executable

`iptvnator_mpv_recorder.exe` (`apps/electron-backend/native/helper/mpv_recorder.cpp`)
links the bundled `libmpv-2.dll` and is built by the `iptvnator_mpv_recorder`
target in `native/binding.gyp` (Windows only; a no-op target elsewhere). It
lands in `native/` beside the DLL and the frame-copy helper, and is found the
same way as the addon: packaged builds only look inside the app.

- mpv runs with `vo=null` and `ao=null`, skips frame decoding, and records
  with `stream-record`. `ao=null` (not `audio=no`) keeps the audio track in
  the file.
- Protocol: the frame helper's `frame_helper_io.h` encoding. Commands on
  stdin: `open` (url, path, user-agent, referrer, headers), `stop`, `quit`;
  stdin EOF quits. Events on stdout, one JSON object per line: `ready`,
  `opened`, `recording`, `buffering`, `record-failed`, `ended`, `stopped`,
  `log`, `fatal`. The URL and headers never travel on argv, and log lines
  containing a URL are redacted.
- mpv accepts `stream-record` for a folder it cannot write, then logs
  `Failed opening output file.` and keeps playing without recording. The
  recorder turns that into one `record-failed` event per file, and the
  service creates the folder before starting.
- One process writes one file. mpv restarts the timestamps of every
  `stream-record` file, so each file is its own timeline anyway.

Measured in the spike (`spikes/background-recorder/README.md`): about 2% of
one core and 40–136 MB for a 720p H.264 stream.

## BackgroundRecordingService

`apps/electron-backend/src/app/services/background-recording.service.ts`,
wired with Electron dependencies in `background-recording.runtime.ts`.

- **Start** (`BackgroundRecordingStartRequest`): a playback resolved
  immediately before the call, the recording metadata, the origin
  (`button | menu | schedule`), an optional folder and an optional planned
  end. Refused when a recording is running, for DRM streams, for a planned
  end in the past, and when the recorder is missing.
- **Folder:** the request's folder, else the mirrored `recordingFolder`
  setting (`RECORDING_FOLDER` in the main store, written by
  `SETTINGS_UPDATE`), else Downloads. File names follow
  `recording-target-path.ts`, shared with embedded MPV recordings.
- **Rows:** one `recordings` row per file, inserted when the file first
  grows, so an attempt that records nothing leaves no row and its reserved
  file is removed. Background rows set `origin`; their `session_id` is the
  recording id shared by all of its files. `RECORDINGS_STOP` routes rows
  with an origin to the service. Startup recovery skips rows the service
  still owns.
- **Supervision:** the service polls the file size every 2 s. An `ended`
  event, a recorder exit or 20 s without growth ends the file as
  `interrupted` and starts a new recorder into a new file after a backoff
  (2, 4, 8, 16, 30 s). Each reopen asks `setPlaybackResolver`'s resolver for
  a fresh stream (Stalker links expire within seconds); until the renderer
  resolver exists, the start playback is reused. Five failed reopens in a row
  end the recording with an error. Growth resets the count. `record-failed`
  ends the recording at once.
- **Stop:** an explicit stop or the planned end sends `quit`, waits up to
  5 s for the recorder to flush and exit, then finalizes the file as
  `completed` with its size.
- **Power:** `powerSaveBlocker('prevent-app-suspension')` is held while a
  recording runs.
- **Quit:** app shutdown asks the recorder to stop; a row left in
  `recording` is repaired at the next startup.

## IPC

| Channel | Direction | Payload |
| --- | --- | --- |
| `BACKGROUND_RECORDING_START` | invoke | `BackgroundRecordingStartRequest` → `BackgroundRecordingState`; rejects with a message |
| `BACKGROUND_RECORDING_STOP` | invoke | optional recording id → `BackgroundRecordingState` |
| `BACKGROUND_RECORDING_GET_STATE` | invoke | → `BackgroundRecordingState` |
| `RECORDING_ACTIVE_STATE` | push | `BackgroundRecordingState` on every change |

`BackgroundRecordingState.available` reports whether the recorder is present.
`RECORDINGS_UPDATE_EVENT` still fires when rows change.

## Scheduling

`recording_schedules` (main-process SQLite) holds one row per scheduled
recording: the resolved playback and recording metadata as JSON, the start
and end instant, and a status (`pending`, `started`, `canceled`, `failed`).

- **Where the row comes from.** Every channel list's right-click menu offers
  *Schedule recording…* (`ChannelContextMenuComponent` + `ScheduleRecordingLauncherService`).
  The list resolves the playback first — an M3U channel's own URL and headers,
  the Xtream live URL built from the playlist credentials, or a Stalker
  `create_link` result with the portal's mac cookie headers — and the dialog
  only collects a date, a start and an end time. The renderer never holds the
  timer. Stalker radio rows resolve through `resolveRadioPlayback`, ITV rows
  through `resolveItvPlayback`; a channel whose link cannot be resolved shows
  `RECORDING_SCHEDULE.ERROR_RESOLVE` instead of opening the dialog. Stalker
  rows also carry `refresh` (`kind: 'stalker'`, the portal `cmd` and
  `contentType`), which is what the main process re-mints at start time.
- **Who fires it.** `RecordingSchedulerService` arms one timer per pending
  row at startup and after every create/cancel. At the start instant it hands
  the stored playback to `BackgroundRecordingService` with `origin: 'schedule'`
  and the planned end, so the recorder stops itself on time. A launch that
  lands inside a schedule's window starts it immediately; a window that has
  already passed marks the row `failed` instead of recording nothing.
- **Expiring links.** The playback is stored once, with the headers the
  portal needs. Xtream and M3U live URLs stay valid; a Stalker `create_link`
  URL usually does not. A Stalker schedule therefore also stores the
  channel's portal command (`refresh_json`), and the main process handshakes
  and mints a fresh `create_link` right before starting (both ITV and radio).
  The stored link is the fallback for a portal that cannot be reached at the
  start instant — for example a playlist deleted after scheduling.
- **IPC.** `RECORDING_SCHEDULE_CREATE`, `RECORDING_SCHEDULE_CANCEL`,
  `RECORDING_SCHEDULE_GET_LIST` (invoke) and `RECORDING_SCHEDULE_UPDATE_EVENT`
  (push). The capability gate is `supportsRecordingSchedule`.

## Tray and window lifetime

`tray.service.ts` creates the tray after the main window exists and supplies
the only way back from a hidden window. With a tray present, a window `close`
hides instead of quitting, so a scheduled recording still fires and an active
one is not cut short; `app.quit()` (tray menu, application menu, update
install) sets the bypass first, and a close already intercepted by the
unsaved-changes guard is left to that guard. Without a loadable icon no tray
is created and closing keeps quitting, `IPTVNATOR_NO_TRAY=1` forces that.

Past recordings keep the existing manager surface (`/workspace/downloads`,
recordings filter), reachable from the rail's *Recordings* entry, which opens
that filtered view. That manager also lists the pending schedule rows with a
cancel action, so the main-process timers are visible and revocable from the
renderer.

Playback runs through the shared inline player. Recordings are MPEG-TS, which
the web engines cannot demux, so the recording player prefers the embedded MPV
engine when the runtime supports it; the filesystem path goes to that engine
unchanged and is converted to a `file://` URL for the web engines.

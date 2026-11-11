# Background (DVR) recording

Background recording captures a live channel without showing it: the stream
is opened on a hidden embedded-MPV session in the main process and written
with mpv's `stream-record`, the same mechanism the player's record button
uses. There is no separate recorder executable, no second process protocol
and no second copy of libmpv; the recording survives channel changes,
navigation, a hidden window and a renderer reload.

Recordings started from the player are the same engine without the hidden
session; see [embedded MPV](embedded-mpv-native.md#live-stream-recording).

## Pieces

| Piece | Where | Owns |
| --- | --- | --- |
| DVR policy | `apps/electron-backend/src/app/services/background-recording.service.ts` | one recording at a time, the folder, the planned end, renderer state, the outcome a schedule reads |
| Engine port | `background-recording.runtime.ts` | adapts `EmbeddedMpvNativeService` + `EmbeddedMpvRecordingTracker` to the small `DvrRecordingEngine` surface |
| Hidden session | `EmbeddedMpvNativeService.openRecordingSession()` | the stream, `vo=null`/`ao=null` so nothing renders or plays, reconnect/reload |
| Rows | `embedded-mpv-recording-tracker.ts` | one `recordings` row per file, finalization, file-size probe, empty-file cleanup |

`openRecordingSession()` returns the engine session id, which is also the
DVR recording id and the rows' `session_id`, so stopping a row, the schedule
and the tray all name the same thing. The session is marked *headless*: its
updates never reach the renderer, and a renderer crash or reload does not
dispose it.

## Start and end

- **Start** (`BackgroundRecordingStartRequest`): a playback resolved
  immediately before the call, the recording metadata, the origin
  (`button | menu | schedule`), an optional folder and an optional planned
  end. Refused when a recording is running, for DRM streams, for a planned
  end in the past, and when the engine cannot record.
- **Availability** is the engine's own answer (`canRecord()`:
  `getSupport().supported` plus the addon's recording capability), never a
  second binary's presence. When the engine cannot record, the refusal
  carries its reason so a schedule can show it.
- **Folder:** the request's folder, else the mirrored `recordingFolder`
  setting (`RECORDING_FOLDER` in the main store, written by
  `SETTINGS_UPDATE`), else Downloads. File names follow
  `recording-target-path.ts`, shared with the player's recordings.
- **Planned end:** a timer in the DVR service stops the recording. The
  service also polls the session's live state every 2 s to keep
  `backgroundRecordingState` honest (`starting`, `recording`,
  `reconnecting`, `stopping`) and to notice a stream that ended.
- **Drop and reconnect:** the embedded session's reconnect coordinator
  reloads the stream and restarts the recording into a fresh file; the
  tracker files the partial as `interrupted`. A recording that cannot
  recover ends and the DVR service reports the engine's error.
- **Scheduled source failover:** when a scheduled recording's stream errors
  or ends, the DVR service pauses recording and opens the same channel from
  the next alternate source (`live-recording-failover.ts`: Xtream and M3U
  live rows in the desktop catalog, ranked with the shared fuzzy channel
  matcher). Each source gets 20 s to reach `recording` before the next one
  is tried; every continuation segment records without its own row and is
  appended into the first file, so one schedule still yields one recording.
  Stalker channels have no catalog rows and are not hop candidates.
- **Stop:** `stopRecording()` closes the file, then the hidden session is
  disposed. The tracker finalizes the row (`completed` after a requested
  stop) and reports `{ sessionId, status, fileSizeBytes, errorMessage }`;
  the DVR service turns that into `BackgroundRecordingOutcome`
  (`recordedBytes` across the files, plus any error) for the scheduler.
- **Quit:** app shutdown stops the recording; a row left in `recording` is
  repaired at the next startup (`reconcileStaleRecordings`, which skips rows
  the tracker still owns).

## Power

`prevent-app-suspension` is held while a DVR recording runs, so Windows does
not sleep through a scheduled slot; the display may still turn off.

## IPC

| Channel | Direction | Payload |
| --- | --- | --- |
| `BACKGROUND_RECORDING_START` | invoke | `BackgroundRecordingStartRequest` → `BackgroundRecordingState`; rejects with a message |
| `BACKGROUND_RECORDING_STOP` | invoke | optional recording id → `BackgroundRecordingState` |
| `BACKGROUND_RECORDING_GET_STATE` | invoke | → `BackgroundRecordingState` |
| `RECORDING_ACTIVE_STATE` | push | `BackgroundRecordingState` on every change |

`RECORDINGS_STOP` routes a row with an `origin` to
`backgroundRecordingService.stop(row.sessionId)`; every other row is stopped
through `embeddedMpvNativeService.stopRecording()`. `RECORDINGS_UPDATE_EVENT`
fires when rows change.

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
  the stored playback to the DVR service with `origin: 'schedule'`, the
  planned end and the schedule id. A launch that lands inside a schedule's
  window starts it immediately; a window that has already passed marks the
  row `failed` instead of recording nothing.
- **Outcome.** The DVR service reports what a recording actually wrote; a
  schedule whose recording wrote zero bytes is marked `failed` with the
  engine's reason instead of claiming a recording that is not there.
- **Expiring links.** The playback is stored once, with the headers the
  portal needs. Xtream and M3U live URLs stay valid; a Stalker `create_link`
  URL usually does not. A Stalker schedule therefore also stores the
  channel's portal command (`refresh_json`), and the main process handshakes
  and mints a fresh `create_link` right before starting (both ITV and radio).
  The same re-mint runs before every reconnect of a running recording: a
  dropped Stalker stream is dialled again with a link minted for the new
  connection, never with the one that died with the old one. The stored link
  is the fallback for a portal that cannot be reached at the start instant —
  for example a playlist deleted after scheduling.
- **IPC.** `RECORDING_SCHEDULE_CREATE`, `RECORDING_SCHEDULE_RESCHEDULE`,
  `RECORDING_SCHEDULE_CANCEL`, `RECORDING_SCHEDULE_GET_LIST` (invoke) and
  `RECORDING_SCHEDULE_UPDATE_EVENT` (push). Both create and reschedule
  validate the window through `recording-schedule-window.ts`. The capability
  gate is `supportsRecordingSchedule`.
- **Latency.** A Stalker row's `create_link` handshake runs inside the open
  dialog (`openDeferred`), so the context menu answers at once; Xtream and
  M3U rows pass their resolved target straight in.
- **Visibility.** Every outcome is logged under `[Recording schedule]` and a
  Windows toast reports a schedule that started or failed. The manager lists
  pending rows plus the latest finished ones (bounded query) with their
  status and reason, so a missed recording is no longer silent.

## Tray and window lifetime

`tray.service.ts` creates the tray after the main window exists and supplies
the only way back from a hidden window. With a tray present, a window `close`
hides instead of quitting, so a scheduled recording still fires and an active
one is not cut short; `app.quit()` (tray menu, application menu, update
install) sets the bypass first, and a close already intercepted by the
unsaved-changes guard is left to that guard. Without a loadable icon no tray
is created and closing keeps quitting, `IPTVNATOR_NO_TRAY=1` forces that.

The hidden DVR session needs the Electron window to exist (`getNativeWindowHandle`)
but not to be visible: closing to the tray keeps it alive, and the session
survives a renderer reload because `disposeAll` skips headless sessions.

Past recordings keep the existing manager surface (`/workspace/downloads`,
recordings filter), reachable from the rail's *Recordings* entry, which opens
that filtered view. That manager also lists the pending schedule rows with a
cancel action, so the main-process timers are visible and revocable from the
renderer.

Playback runs through the shared inline player. Recordings are MPEG-TS, which
the web engines cannot demux, so the recording player prefers the embedded MPV
engine when the runtime supports it; the filesystem path goes to that engine
unchanged and is converted to a `file://` URL for the web engines.

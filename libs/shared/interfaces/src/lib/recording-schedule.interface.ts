import type { ResolvedPortalPlayback } from './portal-playback.interface';
import type { RecordingStartMetadata } from './recording-metadata.interface';

/**
 * A recording the user scheduled from a channel's context menu.
 *
 * The main process owns the schedule, not the renderer: the app keeps
 * running in the tray, so a recording must start with the window closed or
 * the renderer gone. The playback is resolved when the schedule is created
 * and stored with it — Xtream and M3U live URLs stay valid for the whole
 * window, while a Stalker `create_link` URL can expire before the start
 * instant. A Stalker schedule therefore also stores `refresh`: the main
 * process mints a fresh link from it at the start, and only falls back to
 * the stored one when the portal cannot be reached.
 */
export type RecordingScheduleStatus =
    | 'pending'
    | 'started'
    | 'canceled'
    | 'failed';

/**
 * Enough for the main process to mint a fresh Stalker stream URL at the
 * start instant without the renderer (`create_link` results are short-lived
 * and the portal identity lives on the playlist row).
 */
export interface StalkerScheduleRefresh {
    kind: 'stalker';
    /** The channel's portal command, e.g. `ffrt4://...`. */
    cmd: string;
    contentType: 'itv' | 'radio';
}

export interface RecordingScheduleCreateRequest {
    /** Playback resolved by the renderer right before the schedule is saved. */
    playback: ResolvedPortalPlayback;
    /** Snapshot shown in the recordings manager; survives playlist deletion. */
    metadata: RecordingStartMetadata;
    /** Present for Stalker rows: re-resolved when the schedule fires. */
    refresh?: StalkerScheduleRefresh;
    /** ISO instant the recording starts at. */
    startAt: string;
    /** ISO instant the recording stops at. */
    endAt: string;
    directory?: string;
}

export interface RecordingScheduleItem {
    id: number;
    channelName: string;
    channelLogoUrl?: string;
    playlistId?: string;
    playlistName?: string;
    sourceType?: RecordingStartMetadata['sourceType'];
    startAt: string;
    endAt: string;
    status: RecordingScheduleStatus;
    errorMessage?: string;
    /** Set once the schedule fired and handed over to a recording. */
    recordingId?: string;
}

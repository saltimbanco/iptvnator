import { ResolvedPortalPlayback } from './portal-playback.interface';
import { RecordingStartMetadata } from './recording-metadata.interface';
import { StalkerScheduleRefresh } from './recording-schedule.interface';

/**
 * Background recording: the player's own engine records the channel on a
 * hidden session, so the app keeps writing the stream with the window closed
 * to the tray and no second recorder binary is involved. One background
 * recording runs at a time; it ends on an explicit stop or at its planned
 * end. See docs/architecture/background-recording.md.
 */

/** Where a background recording was started from (`recordings.origin`). */
export type BackgroundRecordingOrigin = 'button' | 'menu' | 'schedule';

export type BackgroundRecordingStatus =
    'idle' | 'starting' | 'recording' | 'reconnecting' | 'stopping';

export interface BackgroundRecordingStartRequest {
    /**
     * Resolved immediately before the call: Stalker links live for seconds,
     * so a stored playback must never be passed here.
     */
    playback: ResolvedPortalPlayback;
    metadata: RecordingStartMetadata;
    origin: BackgroundRecordingOrigin;
    /** Recording folder; falls back to the mirrored setting, then Downloads. */
    directory?: string;
    /** Planned end (ISO instant). Absent means "until stopped". */
    endsAt?: string;
    /** The schedule that started this recording, when `origin` is `schedule`. */
    scheduleId?: number;
    /**
     * Present for Stalker rows: the recorder re-mints the short-lived
     * `create_link` URL from it whenever the stream has to be reconnected.
     */
    refresh?: StalkerScheduleRefresh;
}

/**
 * What a finished background recording actually left behind, reported once its
 * last file is closed. A scheduled recording uses it to tell "recorded" apart
 * from "handed over but wrote nothing", which would otherwise stay silent.
 */
export interface BackgroundRecordingOutcome {
    /** Why it ended early, when it did. */
    error?: string;
    /** Bytes written across every file; 0 means nothing was recorded. */
    recordedBytes: number;
}

export interface BackgroundRecordingState {
    /** Whether the player engine can record right now. */
    available: boolean;
    status: BackgroundRecordingStatus;
    /** Stable id of the running recording; shared by all of its files. */
    recordingId?: string;
    origin?: BackgroundRecordingOrigin;
    channelName?: string;
    channelLogoUrl?: string;
    playlistId?: string;
    sourceType?: RecordingStartMetadata['sourceType'];
    startedAt?: string;
    endsAt?: string;
    /** The file currently being written. */
    filePath?: string;
    /** 1 for the first file; a reconnect continues in the next one. */
    segment?: number;
    /** Why the last recording ended early, kept until the next start. */
    error?: string;
}

import { ResolvedPortalPlayback } from './portal-playback.interface';
import { RecordingStartMetadata } from './recording-metadata.interface';

/**
 * Background recording (Windows): a separate mpv recorder process owns the
 * provider connection and writes the stream to disk independently of the
 * visible player. One background recording runs at a time; it ends on an
 * explicit stop or at its planned end. See
 * docs/architecture/background-recording.md.
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
}

export interface BackgroundRecordingState {
    /** Windows with the recorder executable present. */
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

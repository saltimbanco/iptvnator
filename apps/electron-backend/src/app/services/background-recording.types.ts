import type {
    BackgroundRecordingOrigin,
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
    BackgroundRecordingStatus,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';

/**
 * The shapes `BackgroundRecordingService` exchanges with its engine and its
 * callers, kept beside it so the policy in `background-recording.service.ts`
 * stays readable.
 */

/** One finished file, as the engine reports it. */
export interface DvrRecordingFinal {
    sessionId: string;
    /** The file that just closed; hops append it into the main file. */
    targetPath?: string;
    status: 'completed' | 'interrupted' | 'failed';
    fileSizeBytes: number | null;
    errorMessage?: string;
}

/** Live state of a DVR session. */
export interface DvrRecordingSessionState {
    status: string;
    active: boolean;
    targetPath?: string;
    error?: string;
}

export interface DvrRecordingOpen {
    playback: ResolvedPortalPlayback;
    directory: string;
    title: string;
    metadata: RecordingStartMetadata;
    origin: BackgroundRecordingOrigin;
    /** Continue the recording into this file instead of reserving one. */
    targetPath?: string;
    /** `false` for a continuation segment: it owns no `recordings` row. */
    trackRow?: boolean;
    /** Stalker rows: the engine re-mints the link on every reconnect. */
    refresh?: StalkerScheduleRefresh;
}

/**
 * What DVR recording needs from the player engine — implemented over
 * `EmbeddedMpvNativeService`, faked in tests.
 */
export interface DvrRecordingEngine {
    canRecord(): { ready: boolean; reason?: string };
    /** Opens the stream on a hidden session and starts recording it. */
    open(input: DvrRecordingOpen): string;
    stop(sessionId: string): void;
    state(sessionId: string): DvrRecordingSessionState | null;
    onFinalized(listener: (final: DvrRecordingFinal) => void): void;
    /** Rows the tracker still owns; startup recovery must leave them alone. */
    activeRowIds(): Promise<Set<number>>;
}

export interface BackgroundRecordingDeps {
    readonly engine: DvrRecordingEngine;
    /** The folder to record into, created if needed. */
    resolveDirectory(requested?: string): string;
    keepAwake(active: boolean): void;
    broadcast(state: BackgroundRecordingState): void;
    /** Reserves the one file every hop of one recording appends into. */
    reserveTargetPath?(directory: string, title: string): string;
    /**
     * Alternate live playbacks of the same channel, in source order. Absent
     * on a runtime without the desktop catalog: such a recording ends when
     * its stream does.
     */
    resolveAlternates?(
        request: BackgroundRecordingStartRequest
    ): Promise<ResolvedPortalPlayback[]>;
    /** Appends one finished segment into the recording's main file. */
    appendSegment?(targetPath: string, segmentPath: string): Promise<void>;
    /** Keeps the main row `recording` while a hop is being written. */
    onSegmentMerged?(targetPath: string): void;
    /** Completes the main row once the last source hop ends the recording. */
    finalizeMerged?(targetPath: string, error?: string): void;
}

/** The one recording this service runs at a time. */
export interface Recording {
    /** The engine session id, which is also the id of the rows it writes. */
    id: string;
    request: BackgroundRecordingStartRequest;
    startedAt: string;
    status: BackgroundRecordingStatus;
    filePath?: string;
    /** The file the first segment reserved; every hop appends into it. */
    mainPath?: string;
    /** Untried alternate sources; null until the first failure. */
    alternates: ResolvedPortalPlayback[] | null;
    /** Serializes appends so segments land in recording order. */
    mergeChain: Promise<void>;
    /** Set once a source hop has happened. */
    hopped: boolean;
    /** A hop is opening its session; the poll must not start another. */
    hopInFlight: boolean;
    /** When the current alternate started; unset while the main source runs. */
    hopStartedAt?: number;
    endTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setInterval>;
    stopping: boolean;
}

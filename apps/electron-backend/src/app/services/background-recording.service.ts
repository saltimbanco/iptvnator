import type {
    BackgroundRecordingOrigin,
    BackgroundRecordingOutcome,
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
    BackgroundRecordingStatus,
    RecordingStartMetadata,
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';

/**
 * DVR recording (the channel menu's record action and the scheduler). It
 * records through the player's own engine: the stream is opened on a hidden
 * embedded-MPV session and captured with the same `stream-record` the
 * record button uses, so there is no second recorder binary, no second
 * protocol to keep in step, and no separate process to package.
 *
 * This service owns policy only — one recording at a time, the folder, the
 * planned end, the state the renderer sees and the outcome a schedule needs.
 * The engine owns the stream and the files, and the recording tracker owns
 * the `recordings` rows.
 */

/** One finished file, as the engine reports it. */
export interface DvrRecordingFinal {
    sessionId: string;
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
}

/** How often the engine's live state is read while a recording runs. */
const POLL_MS = 2_000;
/** setTimeout's limit; longer planned ends are re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

interface Recording {
    /** The engine session id, which is also the id of the rows it writes. */
    id: string;
    request: BackgroundRecordingStartRequest;
    startedAt: string;
    status: BackgroundRecordingStatus;
    filePath?: string;
    endTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setInterval>;
    stopping: boolean;
}

/**
 * One DVR recording at a time. A dropped stream is the engine's business:
 * its reconnect coordinator reloads the stream and restarts the recording,
 * so this service only has to notice the session ending and report what
 * reached the disk.
 */
export class BackgroundRecordingService {
    private active: Recording | null = null;
    private lastError: string | undefined;
    /**
     * Requests of recordings whose file is not finalized yet. The outcome is
     * reported from the tracker's finalize, which lands after the stop, so
     * the request has to outlive the active recording.
     */
    private readonly finishing = new Map<
        string,
        { request: BackgroundRecordingStartRequest; error?: string }
    >();
    private outcomeListener:
        | ((
              request: BackgroundRecordingStartRequest,
              outcome: BackgroundRecordingOutcome
          ) => void)
        | null = null;

    constructor(private readonly deps: BackgroundRecordingDeps) {
        this.deps.engine.onFinalized((final) => this.handleFinalized(final));
    }

    /**
     * Told once a recording has finished, with what it really wrote. A
     * schedule hands the stream over and is marked as recording before a byte
     * exists, so without this a stream that never opened leaves the schedule
     * claiming a recording that is not there.
     */
    setOutcomeListener(
        listener: (
            request: BackgroundRecordingStartRequest,
            outcome: BackgroundRecordingOutcome
        ) => void
    ): void {
        this.outcomeListener = listener;
    }

    isAvailable(): boolean {
        return this.deps.engine.canRecord().ready;
    }

    getState(): BackgroundRecordingState {
        const recording = this.active;
        const available = this.isAvailable();
        if (!recording) {
            return {
                available,
                status: 'idle',
                ...(this.lastError ? { error: this.lastError } : {}),
            };
        }
        const { metadata, origin, endsAt } = recording.request;
        const filePath =
            this.deps.engine.state(recording.id)?.targetPath ??
            recording.filePath;
        return {
            available,
            status: recording.status,
            recordingId: recording.id,
            origin,
            channelName: metadata.channelName,
            channelLogoUrl: metadata.channelLogoUrl,
            playlistId: metadata.playlistId,
            sourceType: metadata.sourceType,
            startedAt: recording.startedAt,
            endsAt,
            ...(filePath ? { filePath } : {}),
            segment: 1,
        };
    }

    start(request: BackgroundRecordingStartRequest): BackgroundRecordingState {
        const availability = this.deps.engine.canRecord();
        if (!availability.ready) {
            throw new Error(
                `Background recording is not available.${
                    availability.reason ? ` ${availability.reason}` : ''
                }`
            );
        }
        if (this.active) {
            throw new Error('A background recording is already running.');
        }
        if (!request?.playback?.streamUrl || !request.metadata) {
            throw new Error('There is no stream to record.');
        }
        if (request.playback.drm) {
            throw new Error('DRM-protected channels cannot be recorded.');
        }
        const endsAtMs = request.endsAt ? Date.parse(request.endsAt) : null;
        if (endsAtMs !== null && !(endsAtMs > Date.now())) {
            throw new Error('The planned end is not in the future.');
        }

        const sessionId = this.deps.engine.open({
            playback: request.playback,
            directory: this.deps.resolveDirectory(request.directory),
            title:
                request.metadata.channelName || request.playback.title || '',
            metadata: request.metadata,
            origin: request.origin,
            ...(request.refresh ? { refresh: request.refresh } : {}),
        });
        const recording: Recording = {
            id: sessionId,
            request,
            startedAt: new Date().toISOString(),
            status: 'starting',
            stopping: false,
        };
        this.active = recording;
        this.lastError = undefined;
        this.deps.keepAwake(true);
        if (endsAtMs !== null) {
            this.armEndTimer(recording, endsAtMs);
        }
        recording.pollTimer = setInterval(
            () => this.poll(recording),
            POLL_MS
        );
        this.publish();
        return this.getState();
    }

    /** Stops the running recording; with an id, only if it is that one. */
    stop(recordingId?: string): Promise<void> {
        const recording = this.active;
        if (!recording || (recordingId && recordingId !== recording.id)) {
            return Promise.resolve();
        }
        return this.finish(recording);
    }

    activeRowIds(): Promise<Set<number>> {
        return this.deps.engine.activeRowIds();
    }

    private poll(recording: Recording): void {
        const state = this.deps.engine.state(recording.id);
        if (!state) {
            void this.finish(recording, 'The recording stopped unexpectedly.');
            return;
        }
        if (state.targetPath) {
            recording.filePath = state.targetPath;
        }
        if (state.error) {
            void this.finish(recording, state.error);
            return;
        }
        if (
            state.status === 'ended' ||
            state.status === 'idle' ||
            state.status === 'closed' ||
            state.status === 'error'
        ) {
            // The stream is over; the tracker files the file and reports it.
            void this.finish(recording);
            return;
        }
        const next: BackgroundRecordingStatus =
            state.status === 'loading'
                ? 'reconnecting'
                : state.active
                  ? 'recording'
                  : recording.status;
        if (next !== recording.status) {
            recording.status = next;
            this.publish();
        }
    }

    private finish(recording: Recording, error?: string): Promise<void> {
        if (recording.stopping) {
            return Promise.resolve();
        }
        recording.stopping = true;
        clearTimeout(recording.endTimer);
        clearInterval(recording.pollTimer);
        recording.status = 'stopping';
        this.publish();
        this.finishing.set(recording.id, {
            request: recording.request,
            ...(error ? { error } : {}),
        });
        try {
            this.deps.engine.stop(recording.id);
        } catch (stopError) {
            console.warn('[Background recording] stop failed:', stopError);
        }
        if (this.active === recording) {
            this.active = null;
        }
        this.lastError = error;
        this.deps.keepAwake(false);
        this.publish();
        return Promise.resolve();
    }

    private handleFinalized(final: DvrRecordingFinal): void {
        const pending = this.finishing.get(final.sessionId);
        this.finishing.delete(final.sessionId);
        const recording =
            this.active?.id === final.sessionId ? this.active : null;
        const request = pending?.request ?? recording?.request;
        if (!request) {
            return;
        }
        const error = pending?.error ?? final.errorMessage;
        if (recording) {
            // The file ended on its own (stream over, recorder error).
            clearTimeout(recording.endTimer);
            clearInterval(recording.pollTimer);
            this.active = null;
            this.lastError = error;
            this.deps.keepAwake(false);
            this.publish();
        }
        this.outcomeListener?.(request, {
            ...(error ? { error } : {}),
            recordedBytes: final.fileSizeBytes ?? 0,
        });
    }

    private armEndTimer(recording: Recording, endsAtMs: number): void {
        const delay = Math.min(
            Math.max(endsAtMs - Date.now(), 0),
            MAX_TIMER_MS
        );
        recording.endTimer = setTimeout(() => {
            if (Date.now() >= endsAtMs) {
                void this.finish(recording);
            } else {
                this.armEndTimer(recording, endsAtMs);
            }
        }, delay);
    }

    private publish(): void {
        this.deps.broadcast(this.getState());
    }
}

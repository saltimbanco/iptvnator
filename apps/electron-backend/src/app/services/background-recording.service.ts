import type {
    BackgroundRecordingOutcome,
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
    BackgroundRecordingStatus,
} from '@iptvnator/shared/interfaces';
import type {
    BackgroundRecordingDeps,
    DvrRecordingFinal,
    DvrRecordingOpen,
    Recording,
} from './background-recording.types';

export type {
    BackgroundRecordingDeps,
    DvrRecordingEngine,
    DvrRecordingFinal,
    DvrRecordingOpen,
    DvrRecordingSessionState,
} from './background-recording.types';

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

/** How often the engine's live state is read while a recording runs. */
const POLL_MS = 2_000;
/**
 * How long an alternate source has to reach `recording` before the next one
 * is tried. Long enough for a portal handshake, short enough that a dead
 * source does not eat the programme.
 */
const HOP_ESTABLISH_MS = 20_000;
/** setTimeout's limit; longer planned ends are re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

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

        const directory = this.deps.resolveDirectory(request.directory);
        const title =
            request.metadata.channelName || request.playback.title || '';
        const mainPath = this.deps.reserveTargetPath?.(directory, title);
        const sessionId = this.deps.engine.open({
            playback: request.playback,
            directory,
            title,
            metadata: request.metadata,
            origin: request.origin,
            ...(mainPath ? { targetPath: mainPath } : {}),
            ...(request.refresh ? { refresh: request.refresh } : {}),
        });
        const recording: Recording = {
            id: sessionId,
            request,
            startedAt: new Date().toISOString(),
            status: 'starting',
            alternates: null,
            mergeChain: Promise.resolve(),
            hopped: false,
            hopInFlight: false,
            stopping: false,
            ...(mainPath ? { mainPath } : {}),
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
            void this.recover(recording, state.error);
            return;
        }
        if (
            state.status === 'ended' ||
            state.status === 'idle' ||
            state.status === 'closed' ||
            state.status === 'error'
        ) {
            // The stream is over. A scheduled recording tries the same
            // channel in another source before it gives up; anything else
            // is finished here.
            void this.recover(recording);
            return;
        }
        const next: BackgroundRecordingStatus =
            state.status === 'loading'
                ? 'reconnecting'
                : state.active
                  ? 'recording'
                  : recording.status;
        if (recording.hopStartedAt !== undefined) {
            if (next === 'recording') {
                // The alternate plays: it is the recording now.
                recording.hopStartedAt = undefined;
                recording.alternates = null;
            } else if (
                Date.now() - recording.hopStartedAt >=
                HOP_ESTABLISH_MS
            ) {
                // Not playable in time; move on to the next source.
                recording.hopStartedAt = undefined;
                void this.recover(
                    recording,
                    'The alternate source did not start.'
                );
                return;
            }
        }
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
        const mainPath = recording.mainPath;
        if (mainPath && recording.hopped && this.deps.finalizeMerged) {
            // The main file's row was filed when its own stream died; the
            // hops kept writing into that file, so it is completed here.
            void recording.mergeChain.then(() =>
                this.deps.finalizeMerged?.(mainPath, error)
            );
        }
        this.lastError = error;
        this.deps.keepAwake(false);
        this.publish();
        return Promise.resolve();
    }

    /**
     * A dead stream on a scheduled recording: keep the file, stop the dead
     * segment and continue the same channel in another source until one plays.
     * The main file is only touched again by appends, so the user still gets
     * one recording, not one per source.
     */
    private async recover(
        recording: Recording,
        reason?: string
    ): Promise<void> {
        if (recording.stopping || recording.hopInFlight) {
            return;
        }
        if (recording.request.origin !== 'schedule') {
            // A menu/button recording follows one stream; only a schedule owns
            // the "keep recording this programme" intent across sources.
            await this.finish(recording, reason);
            return;
        }
        const resolveAlternates = this.deps.resolveAlternates;
        if (!resolveAlternates || !recording.mainPath) {
            await this.finish(recording, reason);
            return;
        }

        recording.hopInFlight = true;
        recording.status = 'reconnecting';
        this.publish();
        try {
            if (recording.alternates === null) {
                recording.alternates = await resolveAlternates(
                    recording.request
                );
            }
            if (recording.stopping) {
                return;
            }
            let lastError = reason;
            while (recording.alternates.length > 0) {
                const alternate = recording.alternates.shift();
                if (!alternate) {
                    break;
                }
                try {
                    // Stop the failing segment first: its bytes are appended
                    // into the main file once the file is closed.
                    this.deps.engine.stop(recording.id);
                    const sessionId = this.deps.engine.open({
                        ...this.openInput(recording.request),
                        playback: alternate,
                        targetPath: recording.mainPath,
                        trackRow: false,
                    });
                    recording.id = sessionId;
                    recording.hopped = true;
                    recording.hopStartedAt = Date.now();
                    recording.hopInFlight = false;
                    // The main file is growing again; its row must not stay
                    // filed as an interrupted partial meanwhile.
                    this.deps.onSegmentMerged?.(recording.mainPath);
                    this.publish();
                    return;
                } catch (error) {
                    lastError =
                        error instanceof Error
                            ? error.message
                            : String(error);
                    console.warn(
                        '[Background recording] source hop failed:',
                        error
                    );
                }
            }
            recording.hopInFlight = false;
            await this.finish(
                recording,
                lastError ?? 'No alternate source could be recorded.'
            );
        } finally {
            recording.hopInFlight = false;
        }
    }

    private openInput(
        request: BackgroundRecordingStartRequest
    ): DvrRecordingOpen {
        return {
            playback: request.playback,
            directory: this.deps.resolveDirectory(request.directory),
            title:
                request.metadata.channelName || request.playback.title || '',
            metadata: request.metadata,
            origin: request.origin,
            ...(request.refresh ? { refresh: request.refresh } : {}),
        };
    }

    private enqueueSegmentMerge(
        recording: Recording,
        segmentPath: string
    ): void {
        const append = this.deps.appendSegment;
        const mainPath = recording.mainPath;
        if (!append || !mainPath || segmentPath === mainPath) {
            return;
        }
        recording.mergeChain = recording.mergeChain.then(async () => {
            try {
                await append(mainPath, segmentPath);
                this.deps.onSegmentMerged?.(mainPath);
            } catch (error) {
                console.warn(
                    '[Background recording] segment append failed:',
                    error
                );
            }
        });
    }

    private handleFinalized(final: DvrRecordingFinal): void {
        const pending = this.finishing.get(final.sessionId);
        this.finishing.delete(final.sessionId);
        const active = this.active;

        // A hop's continuation file: append it into the recording's main file
        // and keep the recording running. It owns no row of its own.
        const isContinuation =
            active !== null &&
            final.targetPath !== undefined &&
            final.targetPath !== active.mainPath;
        if (isContinuation) {
            this.enqueueSegmentMerge(active, final.targetPath as string);
            if (!pending) {
                return;
            }
        }
        // Our own hop stopped the previous session; the recording now runs in
        // the session opened right behind it, so this is not its outcome.
        if (
            active &&
            active.hopInFlight &&
            final.sessionId === active.id &&
            !pending
        ) {
            return;
        }

        const recording =
            active?.id === final.sessionId ? active : null;
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

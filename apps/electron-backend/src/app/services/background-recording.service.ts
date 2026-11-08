import { randomUUID } from 'crypto';
import type {
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
    BackgroundRecordingStatus,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import type { RecorderProcess } from './background-recorder-process';
import { buildRecorderOpenCommand } from './background-recorder-protocol';
import type {
    RecordingRowEnd,
    RecordingRowsStore,
} from './background-recording-rows';

export interface BackgroundRecordingDeps {
    resolveRecorderPath(): string | null;
    spawnRecorder(executablePath: string): RecorderProcess;
    rows: RecordingRowsStore;
    /** The folder to record into, created if needed. */
    resolveDirectory(requested?: string): string;
    reservePath(directory: string, title: string): string;
    releasePath(filePath: string): void;
    /** File size, or null when it cannot be read. */
    statSize(filePath: string): Promise<number | null>;
    keepAwake(active: boolean): void;
    broadcast(state: BackgroundRecordingState): void;
}

/** File-growth poll; also how the first bytes are noticed. */
const POLL_MS = 2_000;
/**
 * No growth for this long counts as a dropped stream. libmpv's HTTP stream
 * can sit on a dead connection without ending playback, so this, not an
 * `ended` event, is often what notices a provider outage.
 */
const STALL_MS = 20_000;
/** Reopen attempts in a row before the recording ends with an error. */
const MAX_RESTARTS = 5;
const MAX_RESTART_DELAY_MS = 30_000;
/** setTimeout's limit; longer planned ends are re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

/** One recorder process writing one file. */
interface Segment {
    filePath: string;
    startedAt: string;
    process: RecorderProcess;
    /** Inserted once the file first grows, so empty attempts leave no row. */
    rowId: Promise<number | null> | null;
    size: number;
    lastGrowthAt: number;
    ended: boolean;
}

interface Recording {
    id: string;
    request: BackgroundRecordingStartRequest;
    executablePath: string;
    directory: string;
    startedAt: string;
    status: BackgroundRecordingStatus;
    segment: Segment | null;
    segmentCount: number;
    restarts: number;
    endTimer?: ReturnType<typeof setTimeout>;
    restartTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setInterval>;
    stopping: Promise<void> | null;
}

type SegmentStatus = RecordingRowEnd['status'];

/**
 * Owns the one background recording (Windows): supervises the recorder
 * process, writes one `recordings` row per file, keeps the machine awake
 * and pushes its state. A dropped, stalled or crashed stream ends the
 * current file as `interrupted` and continues in a new one with backoff,
 * re-resolving the stream first (Stalker links expire within seconds).
 */
export class BackgroundRecordingService {
    private active: Recording | null = null;
    private lastError: string | undefined;
    private recorderPath: string | null | undefined;
    private resolvePlayback: (
        request: BackgroundRecordingStartRequest
    ) => Promise<ResolvedPortalPlayback> = (request) =>
        Promise.resolve(request.playback);

    constructor(private readonly deps: BackgroundRecordingDeps) {}

    /** How a reopen gets a fresh stream; defaults to the start playback. */
    setPlaybackResolver(
        resolver: (
            request: BackgroundRecordingStartRequest
        ) => Promise<ResolvedPortalPlayback>
    ): void {
        this.resolvePlayback = resolver;
    }

    isAvailable(): boolean {
        if (this.recorderPath === undefined) {
            this.recorderPath = this.deps.resolveRecorderPath();
        }
        return this.recorderPath !== null;
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
            filePath: recording.segment?.filePath,
            segment: recording.segmentCount,
        };
    }

    start(request: BackgroundRecordingStartRequest): BackgroundRecordingState {
        if (!this.isAvailable() || !this.recorderPath) {
            throw new Error('Background recording is not available.');
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

        const recording: Recording = {
            id: randomUUID(),
            request,
            executablePath: this.recorderPath,
            directory: this.deps.resolveDirectory(request.directory),
            startedAt: new Date().toISOString(),
            status: 'starting',
            segment: null,
            segmentCount: 0,
            restarts: 0,
            stopping: null,
        };
        this.openSegment(recording, request.playback);
        this.active = recording;
        this.lastError = undefined;
        this.deps.keepAwake(true);
        if (endsAtMs !== null) {
            this.armEndTimer(recording, endsAtMs);
        }
        recording.pollTimer = setInterval(
            () => void this.poll(recording),
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
        return this.deps.rows.activeRowIds();
    }

    private openSegment(
        recording: Recording,
        playback: ResolvedPortalPlayback
    ): void {
        const filePath = this.deps.reservePath(
            recording.directory,
            recording.request.metadata.channelName || playback.title
        );
        const segment: Segment = {
            filePath,
            startedAt: new Date().toISOString(),
            process: this.deps.spawnRecorder(recording.executablePath),
            rowId: null,
            size: 0,
            lastGrowthAt: Date.now(),
            ended: false,
        };
        recording.segment = segment;
        recording.segmentCount += 1;
        segment.process.onEvent((event) => {
            if (event.event === 'ready') {
                segment.process.send(
                    buildRecorderOpenCommand(playback, filePath)
                );
            } else if (event.event === 'record-failed') {
                void this.finish(
                    recording,
                    `The recording file could not be written: ${event.error}`,
                    'failed'
                );
            } else if (
                event.event === 'ended' &&
                event.reason !== 'stop' &&
                event.reason !== 'quit'
            ) {
                this.dropSegment(recording, segment, 'The stream ended.');
            } else if (event.event === 'fatal') {
                this.dropSegment(recording, segment, event.error);
            }
        });
        segment.process.onExit(() =>
            this.dropSegment(recording, segment, 'The recorder stopped.')
        );
    }

    private async poll(recording: Recording): Promise<void> {
        const segment = recording.segment;
        if (!segment || segment.ended) {
            return;
        }
        const size = await this.deps.statSize(segment.filePath);
        if (segment.ended || recording.stopping) {
            return;
        }
        if (size !== null && size > segment.size) {
            segment.size = size;
            segment.lastGrowthAt = Date.now();
            segment.rowId ??= this.insertRow(recording, segment);
            recording.restarts = 0;
            if (recording.status !== 'recording') {
                recording.status = 'recording';
                this.publish();
            }
        } else if (Date.now() - segment.lastGrowthAt > STALL_MS) {
            this.dropSegment(recording, segment, 'The stream stalled.');
        }
    }

    private dropSegment(
        recording: Recording,
        segment: Segment,
        reason: string
    ): void {
        if (segment.ended || recording.stopping) {
            return;
        }
        void this.endSegment(recording, segment, 'interrupted');
        if (recording.restarts >= MAX_RESTARTS) {
            void this.finish(recording, `${reason} Reconnecting failed.`);
            return;
        }
        recording.restarts += 1;
        recording.status = 'reconnecting';
        this.publish();
        const delay = Math.min(
            1_000 * 2 ** recording.restarts,
            MAX_RESTART_DELAY_MS
        );
        recording.restartTimer = setTimeout(() => {
            void this.reopen(recording, reason);
        }, delay);
    }

    private async reopen(recording: Recording, reason: string): Promise<void> {
        let playback: ResolvedPortalPlayback;
        try {
            playback = await this.resolvePlayback(recording.request);
        } catch (error) {
            playback = recording.request.playback;
            console.warn('[Background recording] re-resolve failed:', error);
        }
        if (this.active !== recording || recording.stopping) {
            return;
        }
        try {
            this.openSegment(recording, playback);
            this.publish();
        } catch (error) {
            void this.finish(recording, `${reason} ${String(error)}`);
        }
    }

    private async endSegment(
        recording: Recording,
        segment: Segment,
        status: SegmentStatus,
        errorMessage?: string
    ): Promise<void> {
        if (segment.ended) {
            return;
        }
        segment.ended = true;
        if (recording.segment === segment) {
            recording.segment = null;
        }
        await segment.process.shutdown();
        const size =
            (await this.deps.statSize(segment.filePath)) ?? segment.size;
        if (size <= 0 && !segment.rowId) {
            // Nothing was recorded: drop the reserved file, keep no row.
            this.deps.releasePath(segment.filePath);
            return;
        }
        segment.rowId ??= this.insertRow(recording, segment);
        this.deps.rows.finalize(segment.rowId, {
            status: size > 0 ? status : 'failed',
            fileSizeBytes: size > 0 ? size : null,
            errorMessage,
            endedAt: new Date().toISOString(),
        });
    }

    private finish(
        recording: Recording,
        error?: string,
        segmentStatus: SegmentStatus = error ? 'interrupted' : 'completed'
    ): Promise<void> {
        if (recording.stopping) {
            return recording.stopping;
        }
        clearTimeout(recording.endTimer);
        clearTimeout(recording.restartTimer);
        clearInterval(recording.pollTimer);
        recording.status = 'stopping';
        this.publish();
        const segment = recording.segment;
        recording.stopping = (async () => {
            if (segment) {
                await this.endSegment(recording, segment, segmentStatus, error);
            }
            this.active = null;
            this.lastError = error;
            this.deps.keepAwake(false);
            this.publish();
        })();
        return recording.stopping;
    }

    private insertRow(
        recording: Recording,
        segment: Segment
    ): Promise<number | null> {
        return this.deps.rows.insert({
            recordingId: recording.id,
            filePath: segment.filePath,
            metadata: recording.request.metadata,
            origin: recording.request.origin,
            startedAt: segment.startedAt,
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

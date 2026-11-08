import type {
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
} from '@iptvnator/shared/interfaces';
import type { RecorderProcess } from './background-recorder-process';
import type { RecorderEvent } from './background-recorder-protocol';
import type {
    RecordingRowEnd,
    RecordingRowStart,
} from './background-recording-rows';
import { BackgroundRecordingService } from './background-recording.service';

class FakeRecorder implements RecorderProcess {
    readonly sent: string[] = [];
    shutdowns = 0;
    private readonly eventListeners: Array<(event: RecorderEvent) => void> = [];
    private readonly exitListeners: Array<(code: number | null) => void> = [];

    send(command: string): void {
        this.sent.push(command);
    }
    onEvent(listener: (event: RecorderEvent) => void): void {
        this.eventListeners.push(listener);
    }
    onExit(listener: (code: number | null) => void): void {
        this.exitListeners.push(listener);
    }
    shutdown(): Promise<void> {
        this.shutdowns += 1;
        this.exit(0);
        return Promise.resolve();
    }
    emit(event: RecorderEvent): void {
        this.eventListeners.forEach((listener) => listener(event));
    }
    exit(code: number | null): void {
        this.exitListeners.forEach((listener) => listener(code));
    }
}

function createHarness() {
    const recorders: FakeRecorder[] = [];
    const sizes = new Map<string, number>();
    const inserted: RecordingRowStart[] = [];
    const finalized: Array<{ rowId: number | null } & RecordingRowEnd> = [];
    const states: BackgroundRecordingState[] = [];
    let fileNo = 0;
    const deps = {
        resolveRecorderPath: () => 'C:\\app\\iptvnator_mpv_recorder.exe',
        spawnRecorder: jest.fn(() => {
            const recorder = new FakeRecorder();
            recorders.push(recorder);
            return recorder;
        }),
        rows: {
            insert: jest.fn(async (start: RecordingRowStart) => {
                inserted.push(start);
                return inserted.length;
            }),
            finalize: jest.fn(
                async (rowId: Promise<number | null>, end: RecordingRowEnd) => {
                    finalized.push({ rowId: await rowId, ...end });
                }
            ),
            whenSettled: () => Promise.resolve(),
            activeRowIds: () => Promise.resolve(new Set<number>()),
        },
        resolveDirectory: jest.fn(
            (requested?: string) => requested ?? 'C:\\rec'
        ),
        reservePath: jest.fn(() => `C:\\rec\\News-${++fileNo}.ts`),
        releasePath: jest.fn(),
        statSize: jest.fn(async (filePath: string) => sizes.get(filePath) ?? 0),
        keepAwake: jest.fn(),
        broadcast: jest.fn((state: BackgroundRecordingState) => {
            states.push(state);
        }),
    };
    const service = new BackgroundRecordingService(deps);
    return { service, deps, recorders, sizes, inserted, finalized, states };
}

const request = (
    overrides: Partial<BackgroundRecordingStartRequest> = {}
): BackgroundRecordingStartRequest => ({
    playback: {
        streamUrl: 'http://provider.example.test/live/1.ts',
        title: 'News',
        userAgent: 'Synthetic/1.0',
        headers: { 'X-Token': 'synthetic' },
    },
    metadata: {
        channelName: 'News',
        playlistId: 'source-a',
        sourceType: 'xtream',
    },
    origin: 'button',
    ...overrides,
});

/** Lets the recorder open, then grows the file across one poll. */
async function startWriting(
    harness: ReturnType<typeof createHarness>,
    recorder: FakeRecorder,
    bytes = 4096
) {
    recorder.emit({ event: 'ready' });
    harness.sizes.set(
        harness.deps.reservePath.mock.results.at(-1)?.value,
        bytes
    );
    await jest.advanceTimersByTimeAsync(2_000);
}

describe('BackgroundRecordingService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('records into a new file and inserts its row once bytes arrive', async () => {
        const harness = createHarness();
        const state = harness.service.start(request());

        expect(state).toMatchObject({ status: 'starting', segment: 1 });
        expect(harness.deps.keepAwake).toHaveBeenCalledWith(true);
        const [recorder] = harness.recorders;
        recorder.emit({ event: 'ready' });
        expect(recorder.sent).toEqual([
            'open\turl=http://provider.example.test/live/1.ts\tpath=C:\\rec\\News-1.ts\tuser-agent=Synthetic/1.0\theaders=X-Token: synthetic',
        ]);
        // No bytes yet: an attempt that never records leaves no row.
        await jest.advanceTimersByTimeAsync(2_000);
        expect(harness.inserted).toEqual([]);

        harness.sizes.set('C:\\rec\\News-1.ts', 4096);
        await jest.advanceTimersByTimeAsync(2_000);

        expect(harness.inserted).toEqual([
            expect.objectContaining({
                recordingId: state.recordingId,
                filePath: 'C:\\rec\\News-1.ts',
                origin: 'button',
            }),
        ]);
        expect(harness.service.getState().status).toBe('recording');
    });

    it('finalizes the file as completed on stop and releases the machine', async () => {
        const harness = createHarness();
        harness.service.start(request());
        await startWriting(harness, harness.recorders[0]);
        harness.sizes.set('C:\\rec\\News-1.ts', 9000);

        await harness.service.stop();
        await jest.advanceTimersByTimeAsync(0);

        expect(harness.recorders[0].shutdowns).toBe(1);
        expect(harness.finalized).toEqual([
            expect.objectContaining({
                rowId: 1,
                status: 'completed',
                fileSizeBytes: 9000,
            }),
        ]);
        expect(harness.deps.keepAwake).toHaveBeenLastCalledWith(false);
        expect(harness.service.getState()).toEqual({
            available: true,
            status: 'idle',
        });
    });

    it('continues a dropped stream in a new file of the same recording', async () => {
        const harness = createHarness();
        const resolver = jest.fn(async () => ({
            streamUrl: 'http://provider.example.test/live/1-fresh.ts',
            title: 'News',
        }));
        harness.service.setPlaybackResolver(resolver);
        const { recordingId } = harness.service.start(request());
        await startWriting(harness, harness.recorders[0]);

        harness.recorders[0].emit({ event: 'ended', reason: 'eof' });
        await jest.advanceTimersByTimeAsync(0);
        expect(harness.service.getState().status).toBe('reconnecting');
        expect(harness.finalized).toEqual([
            expect.objectContaining({ rowId: 1, status: 'interrupted' }),
        ]);

        await jest.advanceTimersByTimeAsync(2_000);
        expect(resolver).toHaveBeenCalledTimes(1);
        const second = harness.recorders[1];
        second.emit({ event: 'ready' });
        expect(second.sent[0]).toContain(
            'url=http://provider.example.test/live/1-fresh.ts'
        );
        expect(second.sent[0]).toContain('path=C:\\rec\\News-2.ts');
        harness.sizes.set('C:\\rec\\News-2.ts', 100);
        await jest.advanceTimersByTimeAsync(2_000);

        expect(harness.inserted.map((row) => row.recordingId)).toEqual([
            recordingId,
            recordingId,
        ]);
        expect(harness.service.getState()).toMatchObject({
            status: 'recording',
            segment: 2,
            recordingId,
        });
    });

    it('treats a file that stops growing as a dropped stream', async () => {
        const harness = createHarness();
        harness.service.start(request());
        await startWriting(harness, harness.recorders[0]);

        // 20 s without growth, then the 2 s reconnect backoff.
        await jest.advanceTimersByTimeAsync(19_000);
        expect(harness.finalized).toEqual([]);
        await jest.advanceTimersByTimeAsync(5_000);

        expect(harness.finalized[0]).toMatchObject({ status: 'interrupted' });
        expect(harness.recorders).toHaveLength(2);
    });

    it('removes an attempt that recorded nothing instead of keeping a row', async () => {
        const harness = createHarness();
        harness.service.start(request());
        harness.recorders[0].emit({
            event: 'ended',
            reason: 'error',
            error: 'loading failed',
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(harness.deps.releasePath).toHaveBeenCalledWith(
            'C:\\rec\\News-1.ts'
        );
        expect(harness.deps.rows.insert).not.toHaveBeenCalled();
        expect(harness.deps.rows.finalize).not.toHaveBeenCalled();
    });

    it('gives up after five failed reopen attempts and reports why', async () => {
        const harness = createHarness();
        harness.service.start(request());
        for (let attempt = 0; attempt <= 5; attempt += 1) {
            harness.recorders[attempt].exit(1);
            await jest.advanceTimersByTimeAsync(30_000);
        }

        expect(harness.recorders).toHaveLength(6);
        expect(harness.service.getState()).toEqual({
            available: true,
            status: 'idle',
            error: 'The recorder stopped. Reconnecting failed.',
        });
        expect(harness.deps.keepAwake).toHaveBeenLastCalledWith(false);
    });

    it('ends without retrying when the file cannot be written', async () => {
        const harness = createHarness();
        harness.service.start(request());
        harness.recorders[0].emit({
            event: 'record-failed',
            error: 'Failed opening output file.',
        });
        await jest.advanceTimersByTimeAsync(60_000);

        expect(harness.recorders).toHaveLength(1);
        expect(harness.service.getState().error).toBe(
            'The recording file could not be written: Failed opening output file.'
        );
    });

    it('stops at the planned end', async () => {
        const harness = createHarness();
        harness.service.start(
            request({ endsAt: new Date(Date.now() + 20_000).toISOString() })
        );
        await startWriting(harness, harness.recorders[0]);
        harness.sizes.set('C:\\rec\\News-1.ts', 8192);
        await jest.advanceTimersByTimeAsync(17_000);
        expect(harness.service.getState().status).toBe('recording');

        await jest.advanceTimersByTimeAsync(1_000);

        expect(harness.finalized).toEqual([
            expect.objectContaining({ status: 'completed' }),
        ]);
        expect(harness.service.getState().status).toBe('idle');
    });

    it('refuses a second recording, DRM streams and past end times', () => {
        const harness = createHarness();
        expect(() =>
            harness.service.start(
                request({ endsAt: new Date(Date.now() - 1).toISOString() })
            )
        ).toThrow('The planned end is not in the future.');
        expect(() =>
            harness.service.start(
                request({
                    playback: {
                        streamUrl: 'http://provider.example.test/dash.mpd',
                        title: 'News',
                        drm: { type: 'clearkey' } as never,
                    },
                })
            )
        ).toThrow('DRM-protected channels cannot be recorded.');
        harness.service.start(request());
        expect(() => harness.service.start(request())).toThrow(
            'A background recording is already running.'
        );
        expect(harness.recorders).toHaveLength(1);
    });

    it('is unavailable without the recorder executable', () => {
        const harness = createHarness();
        harness.deps.resolveRecorderPath = () => null;
        const service = new BackgroundRecordingService(harness.deps);

        expect(service.getState()).toEqual({
            available: false,
            status: 'idle',
        });
        expect(() => service.start(request())).toThrow(
            'Background recording is not available.'
        );
    });
});

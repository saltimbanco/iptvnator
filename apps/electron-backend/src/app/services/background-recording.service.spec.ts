import type {
    BackgroundRecordingOutcome,
    BackgroundRecordingStartRequest,
    BackgroundRecordingState,
} from '@iptvnator/shared/interfaces';
import {
    BackgroundRecordingService,
    type DvrRecordingEngine,
    type DvrRecordingFinal,
    type DvrRecordingOpen,
    type DvrRecordingSessionState,
} from './background-recording.service';

class FakeEngine implements DvrRecordingEngine {
    ready = true;
    reason: string | undefined;
    readonly opened: DvrRecordingOpen[] = [];
    readonly stopped: string[] = [];
    readonly sessions = new Map<string, DvrRecordingSessionState>();
    private readonly listeners: Array<(final: DvrRecordingFinal) => void> = [];
    private nextId = 0;

    canRecord(): { ready: boolean; reason?: string } {
        return this.ready
            ? { ready: true }
            : { ready: false, ...(this.reason ? { reason: this.reason } : {}) };
    }

    open(input: DvrRecordingOpen): string {
        this.opened.push(input);
        const sessionId = `dvr-${++this.nextId}`;
        this.sessions.set(sessionId, {
            status: 'loading',
            active: false,
            targetPath: `/rec/${sessionId}.ts`,
        });
        return sessionId;
    }

    stop(sessionId: string): void {
        this.stopped.push(sessionId);
    }

    state(sessionId: string): DvrRecordingSessionState | null {
        return this.sessions.get(sessionId) ?? null;
    }

    onFinalized(listener: (final: DvrRecordingFinal) => void): void {
        this.listeners.push(listener);
    }

    activeRowIds(): Promise<Set<number>> {
        return Promise.resolve(new Set([42]));
    }

    /** The engine's view of the stream changing under a running recording. */
    setState(
        sessionId: string,
        patch: Partial<DvrRecordingSessionState>
    ): void {
        const current = this.sessions.get(sessionId);
        if (!current) {
            return;
        }
        this.sessions.set(sessionId, { ...current, ...patch });
    }

    /** The tracker finalizing the file. */
    finalize(sessionId: string, final: Partial<DvrRecordingFinal> = {}): void {
        this.sessions.delete(sessionId);
        const payload: DvrRecordingFinal = {
            sessionId,
            status: 'completed',
            fileSizeBytes: 4096,
            ...final,
        };
        this.listeners.forEach((listener) => listener(payload));
    }
}

const started: BackgroundRecordingService[] = [];

function createHarness() {
    const engine = new FakeEngine();
    const states: BackgroundRecordingState[] = [];
    const deps = {
        engine,
        resolveDirectory: jest.fn(
            (requested?: string) => requested ?? 'C:\\rec'
        ),
        keepAwake: jest.fn(),
        broadcast: jest.fn((state: BackgroundRecordingState) => {
            states.push(state);
        }),
    };
    const service = new BackgroundRecordingService(deps);
    started.push(service);
    return { service, deps, engine, states };
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
    origin: 'menu',
    ...overrides,
});

describe('BackgroundRecordingService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(async () => {
        // A test may leave a recording running; its poll interval must not
        // outlive the suite.
        await Promise.all(started.splice(0).map((service) => service.stop()));
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('opens the stream on the player engine in the resolved folder', () => {
        const harness = createHarness();

        const state = harness.service.start(
            request({ origin: 'schedule', scheduleId: 7 })
        );

        expect(harness.deps.resolveDirectory).not.toHaveBeenCalledWith(
            expect.anything()
        );
        expect(harness.deps.resolveDirectory).toHaveBeenCalled();
        expect(harness.engine.opened).toEqual([
            expect.objectContaining({
                playback: expect.objectContaining({
                    streamUrl: 'http://provider.example.test/live/1.ts',
                }),
                directory: 'C:\\rec',
                title: 'News',
                origin: 'schedule',
                metadata: expect.objectContaining({ channelName: 'News' }),
            }),
        ]);
        expect(state).toMatchObject({
            status: 'starting',
            recordingId: 'dvr-1',
            origin: 'schedule',
            channelName: 'News',
            segment: 1,
        });
        expect(harness.deps.keepAwake).toHaveBeenCalledWith(true);
    });

    it('reports recording once the engine says the file is being written', () => {
        const harness = createHarness();
        harness.service.start(request());

        expect(harness.service.getState().status).toBe('starting');
        harness.engine.setState('dvr-1', { status: 'playing', active: true });
        jest.advanceTimersByTime(2_000);

        expect(harness.service.getState()).toMatchObject({
            status: 'recording',
            filePath: '/rec/dvr-1.ts',
        });
    });

    it('stops at the planned end and releases the machine', async () => {
        const harness = createHarness();
        harness.service.start(
            request({ endsAt: new Date(Date.now() + 20_000).toISOString() })
        );
        harness.engine.setState('dvr-1', { status: 'playing', active: true });
        jest.advanceTimersByTime(2_000);

        await jest.advanceTimersByTimeAsync(18_000);

        expect(harness.engine.stopped).toEqual(['dvr-1']);
        expect(harness.deps.keepAwake).toHaveBeenLastCalledWith(false);
        expect(harness.service.getState()).toEqual({
            available: true,
            status: 'idle',
        });
    });

    it('reports the bytes a finished recording wrote', () => {
        const harness = createHarness();
        const outcomes: BackgroundRecordingOutcome[] = [];
        harness.service.setOutcomeListener((_request, outcome) =>
            outcomes.push(outcome)
        );
        harness.service.start(request({ origin: 'schedule', scheduleId: 7 }));

        harness.engine.finalize('dvr-1', { fileSizeBytes: 9000 });

        expect(outcomes).toEqual([{ recordedBytes: 9000 }]);
        expect(harness.service.getState().status).toBe('idle');
    });

    it('reports an empty recording as nothing written, with its reason', () => {
        const harness = createHarness();
        const outcomes: BackgroundRecordingOutcome[] = [];
        harness.service.setOutcomeListener((_request, outcome) =>
            outcomes.push(outcome)
        );
        harness.service.start(request({ origin: 'schedule', scheduleId: 7 }));

        harness.engine.finalize('dvr-1', {
            status: 'failed',
            fileSizeBytes: 0,
            errorMessage: 'Failed opening output file.',
        });

        expect(outcomes).toEqual([
            {
                error: 'Failed opening output file.',
                recordedBytes: 0,
            },
        ]);
    });

    it('ends the recording when the engine reports a stream error', () => {
        const harness = createHarness();
        harness.service.start(request());
        harness.engine.setState('dvr-1', {
            status: 'error',
            error: 'The stream closed.',
        });

        jest.advanceTimersByTime(2_000);

        expect(harness.engine.stopped).toEqual(['dvr-1']);
        expect(harness.service.getState()).toEqual({
            available: true,
            status: 'idle',
            error: 'The stream closed.',
        });
    });

    it('stops on request and reports the outcome after the file is filed', async () => {
        const harness = createHarness();
        const outcomes: BackgroundRecordingOutcome[] = [];
        harness.service.setOutcomeListener((_request, outcome) =>
            outcomes.push(outcome)
        );
        harness.service.start(request());
        harness.engine.setState('dvr-1', { status: 'playing', active: true });
        jest.advanceTimersByTime(2_000);

        await harness.service.stop();
        expect(harness.engine.stopped).toEqual(['dvr-1']);
        expect(harness.service.getState().status).toBe('idle');
        // The tracker finalizes after the stop, not during it.
        expect(outcomes).toEqual([]);

        harness.engine.finalize('dvr-1', { fileSizeBytes: 1200 });
        expect(outcomes).toEqual([{ recordedBytes: 1200 }]);
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
        expect(harness.engine.opened).toHaveLength(1);
    });

    it('is unavailable when the player engine cannot record', () => {
        const harness = createHarness();
        harness.engine.ready = false;
        harness.engine.reason = 'Embedded MPV is not available.';

        expect(harness.service.isAvailable()).toBe(false);
        expect(harness.service.getState()).toEqual({
            available: false,
            status: 'idle',
        });
        expect(() => harness.service.start(request())).toThrow(
            'Background recording is not available. Embedded MPV is not available.'
        );
    });

    it('leaves rows the tracker still owns to startup recovery', async () => {
        const harness = createHarness();
        await expect(harness.service.activeRowIds()).resolves.toEqual(
            new Set([42])
        );
    });
});

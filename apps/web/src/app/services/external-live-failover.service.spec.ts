import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveChannelFailoverService } from '@iptvnator/playback/data-access';
import type {
    ElectronBridgePlayerError,
    ExternalPlayerSession,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import { ExternalLiveFailoverService } from './external-live-failover.service';
import { ExternalPlaybackService } from './external-playback.service';
import { PlayerService } from './player.service';

describe('ExternalLiveFailoverService', () => {
    let failover: {
        enabled: ReturnType<typeof signal<boolean>>;
        isHopTarget: jest.Mock;
        reportLoading: jest.Mock;
        reportRetrying: jest.Mock;
        reportPlaying: jest.Mock;
        reportFailed: jest.Mock;
    };
    let activeSession: ReturnType<typeof signal<ExternalPlayerSession | null>>;
    let lastExternalPlayback: ReturnType<
        typeof signal<ResolvedPortalPlayback | null>
    >;
    let openExternalPlayback: jest.Mock;
    let playerError: (data: ElectronBridgePlayerError) => void;

    const playback: ResolvedPortalPlayback = {
        streamUrl: 'http://a/1.ts',
        title: 'ERT 1',
        headers: { 'User-Agent': 'ua' },
    };

    function session(
        id: string,
        status: ExternalPlayerSession['status'],
        extra: Partial<ExternalPlayerSession> = {}
    ): ExternalPlayerSession {
        return {
            id,
            player: 'mpv',
            status,
            title: 'ERT 1',
            streamUrl: playback.streamUrl,
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            canClose: true,
            ...extra,
        };
    }

    function launch(id: string): void {
        const value = session(id, 'launching');
        // PlayerService records the playback before its IPC call.
        lastExternalPlayback.set(playback);
        activeSession.set(value);
        TestBed.tick();
    }

    function update(next: ExternalPlayerSession): void {
        activeSession.set(next);
        TestBed.tick();
    }

    beforeEach(() => {
        jest.useFakeTimers();
        failover = {
            enabled: signal(true),
            isHopTarget: jest.fn(() => false),
            reportLoading: jest.fn(),
            reportRetrying: jest.fn(),
            reportPlaying: jest.fn(),
            reportFailed: jest.fn(),
        };
        activeSession = signal<ExternalPlayerSession | null>(null);
        lastExternalPlayback = signal(null);
        openExternalPlayback = jest.fn().mockResolvedValue(undefined);
        (
            window as unknown as {
                electron: { onPlayerError: unknown };
            }
        ).electron = {
            onPlayerError: (callback: (data: ElectronBridgePlayerError) => void) => {
                playerError = callback;
            },
        };
        TestBed.configureTestingModule({
            providers: [
                { provide: LiveChannelFailoverService, useValue: failover },
                {
                    provide: ExternalPlaybackService,
                    useValue: {
                        activeSession: activeSession.asReadonly(),
                    },
                },
                {
                    provide: PlayerService,
                    useValue: {
                        lastExternalPlayback: lastExternalPlayback.asReadonly(),
                        openExternalPlayback,
                    },
                },
            ],
        });
        TestBed.runInInjectionContext(() => new ExternalLiveFailoverService());
        TestBed.tick();
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (window as unknown as { electron?: unknown }).electron;
    });

    it('retries a failing external stream three times before failing over', () => {
        launch('launch-1');
        expect(failover.reportLoading).toHaveBeenCalledWith('ERT 1');

        for (let attempt = 1; attempt <= 3; attempt++) {
            const failed = session(`launch-${attempt}`, 'error', {
                errorCode: 'stream-open-failed',
            });
            update(failed);
            expect(openExternalPlayback).toHaveBeenCalledTimes(attempt);
            expect(openExternalPlayback).toHaveBeenCalledWith(playback, 'mpv');
            expect(failover.reportRetrying).toHaveBeenLastCalledWith(attempt);

            // The retry's own session replaces the one that failed.
            launch(`launch-${attempt + 1}`);
        }
        expect(failover.reportFailed).not.toHaveBeenCalled();

        update(
            session('launch-4', 'error', {
                errorCode: 'stream-open-failed',
            })
        );

        expect(openExternalPlayback).toHaveBeenCalledTimes(3);
        expect(failover.reportFailed).toHaveBeenCalledWith('ERT 1');
    });

    it('keeps the retry budget when its own relaunch reports again', () => {
        launch('s1');
        update(session('s1', 'error', { errorCode: 'connection-failed' }));

        // PlayerService replaced the tracked launch with the retry.
        launch('retry-1');
        update(
            session('retry-1', 'error', { errorCode: 'connection-failed' })
        );

        expect(failover.reportRetrying).toHaveBeenLastCalledWith(2);
        expect(failover.reportLoading).toHaveBeenCalledTimes(2);
    });

    it('restores the budget once the external player plays the stream', () => {
        launch('s1');
        update(session('s1', 'error', { errorCode: 'connection-failed' }));
        update(session('s1', 'playing'));

        expect(failover.reportPlaying).toHaveBeenCalledWith('ERT 1');
        jest.advanceTimersByTime(60_000);
        expect(openExternalPlayback).toHaveBeenCalledTimes(1);

        update(session('s1', 'error', { errorCode: 'timed-out' }));
        expect(failover.reportRetrying).toHaveBeenLastCalledWith(1);
    });

    it('fails over on a player-error report for the active session', () => {
        launch('s1');
        update(session('s1', 'opened'));

        playerError({ player: 'mpv', code: 'stream-not-found', error: 'x' });
        TestBed.tick();

        expect(openExternalPlayback).toHaveBeenCalledWith(playback, 'mpv');
    });

    it('ignores close races and other players', () => {
        launch('s1');
        update(session('s1', 'error', { errorCode: 'previous-closing' }));
        playerError({ player: 'vlc', code: 'stream-not-found', error: 'x' });

        expect(openExternalPlayback).not.toHaveBeenCalled();
        expect(failover.reportFailed).not.toHaveBeenCalled();
    });

    it('gives a failover candidate a single attempt', () => {
        failover.isHopTarget.mockReturnValue(true);
        launch('s1');

        update(session('s1', 'error', { errorCode: 'connection-failed' }));

        expect(openExternalPlayback).not.toHaveBeenCalled();
        expect(failover.reportFailed).toHaveBeenCalledWith('ERT 1');
    });

    it('stays out of launches it did not make, and of a disabled setting', () => {
        const other = session('external', 'error', {
            errorCode: 'connection-failed',
        });
        activeSession.set(other);
        TestBed.tick();
        expect(openExternalPlayback).not.toHaveBeenCalled();

        failover.enabled.set(false);
        launch('s1');
        update(session('s1', 'error', { errorCode: 'connection-failed' }));

        expect(openExternalPlayback).not.toHaveBeenCalled();
        expect(failover.reportFailed).not.toHaveBeenCalled();
    });
});

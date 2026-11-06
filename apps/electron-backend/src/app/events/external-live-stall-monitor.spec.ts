import { LIVE_FAILOVER_STALL_MS } from '@iptvnator/shared/interfaces';
import {
    startExternalLiveStallMonitor,
    stopExternalLiveStallMonitor,
    type ExternalLiveProgressSample,
} from './external-live-stall-monitor';
import {
    externalPlayerSessions,
    sendPlayerErrorNotification,
} from './external-player-runtime';

jest.mock('./external-player-runtime', () => ({
    externalPlayerSessions: { getSession: jest.fn() },
    sendPlayerErrorNotification: jest.fn(),
}));

const getSession = externalPlayerSessions.getSession as jest.Mock;
const reportError = sendPlayerErrorNotification as jest.Mock;

describe('external live stall monitor', () => {
    let sample: jest.Mock<Promise<ExternalLiveProgressSample | null>>;

    function disposed(): boolean {
        return (jest.getTimerCount() ?? 0) === 0;
    }

    beforeEach(() => {
        jest.useFakeTimers();
        getSession.mockReturnValue({ status: 'opened' });
        reportError.mockReset();
        sample = jest.fn().mockResolvedValue({
            positionSeconds: 12,
            paused: false,
        });
    });

    afterEach(() => {
        stopExternalLiveStallMonitor();
        jest.useRealTimers();
    });

    it('reports a frozen stream after the stall window', async () => {
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });

        // The first sample is the baseline, so the window is observed from
        // there: stall = baseline + one more sample + the stall window.
        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS + 5_000);

        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(
            'MPV',
            expect.stringContaining('stalled'),
            'timed-out'
        );
        // One report per stream, and the watchdog is gone afterwards.
        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS * 3);
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(disposed()).toBe(true);
    });

    it('keeps watching while the clock moves', async () => {
        let position = 100;
        sample.mockImplementation(() =>
            Promise.resolve({ positionSeconds: position, paused: false })
        );
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });

        for (let tick = 0; tick < 6; tick++) {
            position += 5;
            await jest.advanceTimersByTimeAsync(5_000);
        }

        expect(reportError).not.toHaveBeenCalled();
    });

    it('never treats the user\u2019s pause as a failure', async () => {
        sample.mockResolvedValue({ positionSeconds: 40, paused: true });
        startExternalLiveStallMonitor({
            player: 'VLC',
            sessionId: 's1',
            sample,
        });

        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS * 4);

        expect(reportError).not.toHaveBeenCalled();
    });

    it('clears the window when the player cannot report a position', async () => {
        sample.mockResolvedValue({ positionSeconds: null, paused: false });
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });

        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS * 2);

        expect(reportError).not.toHaveBeenCalled();
    });

    it('stops once the session closes', async () => {
        getSession.mockReturnValue({ status: 'closed' });
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });

        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS * 2);

        expect(reportError).not.toHaveBeenCalled();
        expect(disposed()).toBe(true);
    });

    it('replaces the watchdog of the same session', async () => {
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });
        const first = sample;
        sample = jest.fn().mockResolvedValue({
            positionSeconds: 1,
            paused: false,
        });
        startExternalLiveStallMonitor({
            player: 'MPV',
            sessionId: 's1',
            sample,
        });

        await jest.advanceTimersByTimeAsync(LIVE_FAILOVER_STALL_MS + 5_000);

        expect(first).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledTimes(1);
    });
});

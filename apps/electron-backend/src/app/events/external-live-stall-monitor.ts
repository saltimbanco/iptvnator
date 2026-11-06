import { LIVE_FAILOVER_STALL_MS } from '@iptvnator/shared/interfaces';
import {
    externalPlayerSessions,
    sendPlayerErrorNotification,
} from './external-player-runtime';

/** One look at the player's own clock, plus whether it is holding. */
export interface ExternalLiveProgressSample {
    /** `time-pos` / `get_time`; null while the player cannot report it. */
    positionSeconds: number | null;
    paused: boolean;
}

export interface ExternalLiveStallMonitorOptions {
    /** Name as the `player-error` payload spells it. */
    player: 'MPV' | 'VLC';
    sessionId: string;
    /** Reads the player's clock over its own control channel. */
    sample: () => Promise<ExternalLiveProgressSample | null>;
}

/** One look every five seconds: a stall window is two of them. */
const SAMPLE_INTERVAL_MS = 5_000;

interface Monitor {
    timer: NodeJS.Timeout;
    lastPositionSeconds: number | null;
    /** Time spent standing still, in whole samples. */
    idleMs: number;
}

const monitors = new Map<string, Monitor>();

/**
 * Watches a managed external MPV/VLC live stream for a frozen picture.
 *
 * The renderer cannot see this: external live launches carry no
 * `contentInfo`, so the position feed that VOD/episodes use never starts, and
 * a live stream that freezes keeps the session `opened` with no error — the
 * player itself reports nothing. The control channel each player already
 * exposes (MPV's IPC socket, VLC's RC port) does answer `time-pos`/`get_time`
 * and whether playback is paused, so the main process can tell a stalled
 * stream from a slow one.
 *
 * A sample that shows the clock moving, or playback paused (the user's own
 * pause must never be treated as a failure), clears the window. When the
 * clock has not moved for {@link LIVE_FAILOVER_STALL_MS}, the stream is
 * reported through the ordinary `player-error` path as `timed-out`, which is
 * what the renderer already turns into a retry and then a source hop.
 *
 * The monitor stops itself on the first report, when the session closes or
 * errors, or when it is stopped explicitly. It is a no-op for a session with
 * no control channel: those launches cannot be watched, and silence there is
 * not evidence of a stall.
 */
export function startExternalLiveStallMonitor(
    options: ExternalLiveStallMonitorOptions
): void {
    stopExternalLiveStallMonitor(options.sessionId);
    const { player, sessionId, sample } = options;
    const monitor: Monitor = {
        timer: setInterval(() => {
            void poll();
        }, SAMPLE_INTERVAL_MS),
        lastPositionSeconds: null,
        idleMs: 0,
    };
    // Never keep the app alive just to watch a player.
    monitor.timer.unref?.();
    monitors.set(sessionId, monitor);

    const current = (): Monitor | undefined =>
        monitors.get(sessionId) === monitor ? monitor : undefined;

    async function poll(): Promise<void> {
        if (!current()) {
            return;
        }
        const session = externalPlayerSessions.getSession(sessionId);
        if (
            !session ||
            session.status === 'closed' ||
            session.status === 'error'
        ) {
            stopExternalLiveStallMonitor(sessionId);
            return;
        }

        const sampleResult = await sample().catch(() => null);
        // Stopped, or replaced by a newer launch, while the sample was in
        // flight: its answer belongs to a stream nobody is watching anymore.
        const active = current();
        if (!active) {
            return;
        }
        if (!sampleResult || sampleResult.positionSeconds === null) {
            active.lastPositionSeconds = null;
            active.idleMs = 0;
            return;
        }
        if (sampleResult.paused) {
            active.lastPositionSeconds = sampleResult.positionSeconds;
            active.idleMs = 0;
            return;
        }
        const advanced =
            active.lastPositionSeconds === null ||
            sampleResult.positionSeconds > active.lastPositionSeconds + 0.5;
        active.lastPositionSeconds = sampleResult.positionSeconds;
        if (advanced) {
            active.idleMs = 0;
            return;
        }
        active.idleMs += SAMPLE_INTERVAL_MS;
        if (active.idleMs < LIVE_FAILOVER_STALL_MS) {
            return;
        }

        stopExternalLiveStallMonitor(sessionId);
        sendPlayerErrorNotification(
            player,
            `Stream stalled for ${LIVE_FAILOVER_STALL_MS / 1000} seconds`,
            'timed-out'
        );
    }
}

/** Stops the monitor of one session, or every monitor when omitted. */
export function stopExternalLiveStallMonitor(sessionId?: string): void {
    if (sessionId !== undefined) {
        const monitor = monitors.get(sessionId);
        if (monitor) {
            clearInterval(monitor.timer);
            monitors.delete(sessionId);
        }
        return;
    }
    for (const monitor of monitors.values()) {
        clearInterval(monitor.timer);
    }
    monitors.clear();
}

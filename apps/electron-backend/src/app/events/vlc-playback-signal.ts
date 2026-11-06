import type { ExternalLiveProgressSample } from './external-live-stall-monitor';
import { getVlcPlaybackSnapshot, getVlcPlaybackState } from './vlc-rc';

/**
 * VLC's own clock and play state over its RC port, for the live stall
 * monitor. Sequential on purpose: RC is a single command channel, and two
 * overlapping connections would race each other's replies.
 */
export async function readVlcPlaybackSignal(
    port: number
): Promise<ExternalLiveProgressSample | null> {
    const state = await getVlcPlaybackState(port);
    const snapshot = await getVlcPlaybackSnapshot(port);
    if (!snapshot && !state) {
        return null;
    }
    return {
        positionSeconds: snapshot?.positionSeconds ?? null,
        // A paused or stopped RC state is the user's own doing, never a
        // stream failure.
        paused: state === 'paused' || state === 'stopped',
    };
}

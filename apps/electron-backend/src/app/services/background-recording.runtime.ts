import { app, powerSaveBlocker } from 'electron';
import { mkdirSync } from 'fs';
import { broadcastBackgroundRecordingState } from '../events/database/recording-broadcast';
import {
    BackgroundRecordingService,
    type DvrRecordingEngine,
    type DvrRecordingFinal,
} from './background-recording.service';
import {
    appendRecordingSegment,
    finalizeRecordingRow,
    findLiveAlternatePlaybacks,
    touchRecordingRow,
} from './live-recording-failover';
import { reserveRecordingTargetPath } from './recording-target-path';
import { embeddedMpvNativeService } from './embedded-mpv-native.service';
import { readEmbeddedMpvSessionOptions } from './embedded-mpv-session-options';
import { embeddedMpvRecordingTracker } from './embedded-mpv-recording-tracker';
import { stalkerPlaybackRefresher } from './stalker-schedule-refresh.service';
import { RECORDING_FOLDER, store } from './store.service';

let blockerId: number | null = null;

/**
 * `prevent-app-suspension` keeps Windows from sleeping while recording; the
 * display may still turn off.
 */
function keepAwake(active: boolean): void {
    if (active && blockerId === null) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && blockerId !== null) {
        if (powerSaveBlocker.isStarted(blockerId)) {
            powerSaveBlocker.stop(blockerId);
        }
        blockerId = null;
    }
}

/**
 * The player engine is the DVR recorder: a background recording is a hidden
 * embedded-MPV session recording with `stream-record`, exactly like the
 * player's record button.
 */
const engine: DvrRecordingEngine = {
    canRecord: () => embeddedMpvNativeService.canRecord(),
    open: (input) =>
        embeddedMpvNativeService.openRecordingSession({
            ...input,
            // The user's own session options (network/proxy tuning) apply to
            // a DVR session too; the engine adds vo/ao off on top.
            options: readEmbeddedMpvSessionOptions(),
            // A Stalker `create_link` URL dies with the connection it was
            // minted for, so a reconnect has to mint a new one first.
            ...(input.refresh
                ? {
                      refreshPlayback: stalkerPlaybackRefresher({
                          refresh: input.refresh,
                          playlistId: input.metadata.playlistId,
                          title: input.playback.title,
                          thumbnail: input.playback.thumbnail,
                      }),
                  }
                : {}),
        }),
    stop: (sessionId) =>
        embeddedMpvNativeService.stopRecordingSession(sessionId),
    state: (sessionId) =>
        embeddedMpvNativeService.getRecordingSessionState(sessionId),
    onFinalized: (listener) =>
        embeddedMpvRecordingTracker.onRecordingFinalized((final) => {
            const result: DvrRecordingFinal = {
                sessionId: final.sessionId,
                targetPath: final.targetPath,
                status: final.status,
                fileSizeBytes: final.fileSizeBytes,
                ...(final.errorMessage
                    ? { errorMessage: final.errorMessage }
                    : {}),
            };
            listener(result);
        }),
    activeRowIds: () => embeddedMpvRecordingTracker.activeRowIds(),
};

export const backgroundRecordingService = new BackgroundRecordingService({
    engine,
    resolveDirectory(requested) {
        const directory =
            requested?.trim() ||
            store.get(RECORDING_FOLDER, '').trim() ||
            app.getPath('downloads');
        mkdirSync(directory, { recursive: true });
        return directory;
    },
    keepAwake,
    broadcast: broadcastBackgroundRecordingState,
    reserveTargetPath: (directory, title) =>
        reserveRecordingTargetPath(directory, title),
    // A scheduled recording outlives the renderer, so its source failover
    // reads the desktop catalog in this process instead of asking a player.
    resolveAlternates: (request) =>
        findLiveAlternatePlaybacks(
            request.metadata.channelName,
            request.metadata.playlistId
        ),
    appendSegment: appendRecordingSegment,
    onSegmentMerged: (targetPath) => void touchRecordingRow(targetPath),
    finalizeMerged: (targetPath, error) =>
        void finalizeRecordingRow(targetPath, error),
});

import { app, powerSaveBlocker } from 'electron';
import { mkdirSync } from 'fs';
import { stat } from 'fs/promises';
import { broadcastBackgroundRecordingState } from '../events/database/recording-broadcast';
import {
    resolveBackgroundRecorderPath,
    spawnRecorderProcess,
} from './background-recorder-process';
import { createRecordingRowsStore } from './background-recording-rows';
import { BackgroundRecordingService } from './background-recording.service';
import {
    releaseRecordingTargetPath,
    reserveRecordingTargetPath,
} from './recording-target-path';
import { RECORDING_FOLDER, store } from './store.service';

/**
 * The folder may be on a network share: a stat that hangs must read as
 * "unknown", not stall the service's polling.
 */
const STAT_TIMEOUT_MS = 3_000;

async function statSize(filePath: string): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STAT_TIMEOUT_MS);
    });
    const probe = stat(filePath).then(
        (stats) => (stats.isFile() ? stats.size : null),
        () => null
    );
    try {
        return await Promise.race([probe, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

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

export const backgroundRecordingService = new BackgroundRecordingService({
    resolveRecorderPath: resolveBackgroundRecorderPath,
    spawnRecorder: spawnRecorderProcess,
    rows: createRecordingRowsStore(),
    resolveDirectory(requested) {
        // mpv does not create missing folders; it records nothing instead.
        const directory =
            requested?.trim() ||
            store.get(RECORDING_FOLDER, '').trim() ||
            app.getPath('downloads');
        mkdirSync(directory, { recursive: true });
        return directory;
    },
    reservePath: reserveRecordingTargetPath,
    releasePath: releaseRecordingTargetPath,
    statSize,
    keepAwake,
    broadcast: broadcastBackgroundRecordingState,
});

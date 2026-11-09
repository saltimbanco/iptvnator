import { ipcMain } from 'electron';
import {
    BACKGROUND_RECORDING_GET_STATE,
    BACKGROUND_RECORDING_START,
    BACKGROUND_RECORDING_STOP,
    BackgroundRecordingStartRequest,
} from '@iptvnator/shared/interfaces';
import { backgroundRecordingService } from '../services/background-recording.runtime';

export default class BackgroundRecordingEvents {
    static bootstrapBackgroundRecordingEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

ipcMain.handle(BACKGROUND_RECORDING_GET_STATE, () =>
    backgroundRecordingService.getState()
);

// Errors (already recording, DRM, no recorder) reject the invoke with a
// message the renderer can show.
ipcMain.handle(
    BACKGROUND_RECORDING_START,
    (_event, request: BackgroundRecordingStartRequest) =>
        backgroundRecordingService.start(request)
);

ipcMain.handle(
    BACKGROUND_RECORDING_STOP,
    async (_event, recordingId?: string) => {
        await backgroundRecordingService.stop(recordingId);
        return backgroundRecordingService.getState();
    }
);

/** App quit: the recorder closes its file; the row is repaired on restart. */
export function shutdownBackgroundRecording(): void {
    void backgroundRecordingService.stop();
}

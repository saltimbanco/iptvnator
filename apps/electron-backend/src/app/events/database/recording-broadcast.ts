import type { BrowserWindow } from 'electron';
import {
    BackgroundRecordingState,
    RECORDING_ACTIVE_STATE,
} from '@iptvnator/shared/interfaces';

// Recordings deliberately get their own bare-ping channel instead of sharing
// DOWNLOADS_UPDATE_EVENT: recording state changes ride the embedded-MPV
// session snapshot cadence, and a shared ping would make every transition
// refetch the (availability-probed) downloads list too.
export const RECORDINGS_UPDATE_EVENT = 'RECORDINGS_UPDATE_EVENT';

let mainWindow: BrowserWindow | null = null;

export function setRecordingsMainWindow(win: BrowserWindow): void {
    mainWindow = win;
}

export function broadcastRecordingsUpdate(): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(RECORDINGS_UPDATE_EVENT);
    }
}

/** Pushes the background recording state (Windows) on every change. */
export function broadcastBackgroundRecordingState(
    state: BackgroundRecordingState
): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(RECORDING_ACTIVE_STATE, state);
    }
}

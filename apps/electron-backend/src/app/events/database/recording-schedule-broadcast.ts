import { BrowserWindow } from 'electron';
import App from '../../app';
import { RECORDING_SCHEDULE_UPDATE_EVENT } from '@iptvnator/shared/interfaces';

let mainWindow: BrowserWindow | null = null;

/** The schedule list changed: created, canceled, fired or failed. */
export function setRecordingSchedulesMainWindow(
    window: BrowserWindow | null
): void {
    mainWindow = window;
}

export function broadcastRecordingSchedulesUpdate(): void {
    const window =
        mainWindow && !mainWindow.isDestroyed()
            ? mainWindow
            : App.mainWindow && !App.mainWindow.isDestroyed()
              ? App.mainWindow
              : null;

    window?.webContents.send(RECORDING_SCHEDULE_UPDATE_EVENT);
}

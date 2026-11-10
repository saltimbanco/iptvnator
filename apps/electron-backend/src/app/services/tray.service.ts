import { app, nativeImage, Tray, Menu } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * The tray keeps the daemonized app reachable once its window is closed:
 * scheduled recordings and a running background recording must outlive the
 * window. The tray only exists when an icon can be loaded — without one
 * there is no way back from a hidden window, so closing keeps quitting.
 */

let tray: Tray | null = null;
let showWindowHandler: (() => void) | null = null;
let quitting = false;

function resolveTrayIcon(): Electron.NativeImage | null {
    const candidates = [
        join(process.resourcesPath, 'icon.png'),
        join(app.getAppPath(), 'apps/web/src/assets/icons/icon.png'),
        join(app.getAppPath(), 'assets/icons/icon.png'),
    ];
    for (const candidate of candidates) {
        if (!existsSync(candidate)) {
            continue;
        }
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
            return image;
        }
    }
    // Windows can use the executable's own icon.
    const executable = nativeImage.createFromPath(app.getPath('exe'));
    return executable.isEmpty() ? null : executable;
}

function showWindow(): void {
    showWindowHandler?.();
}

export function createAppTray(onShowWindow: () => void): Tray | null {
    if (tray) {
        return tray;
    }
    if (process.env['IPTVNATOR_NO_TRAY'] === '1') {
        return null;
    }
    const icon = resolveTrayIcon();
    if (!icon) {
        return null;
    }

    showWindowHandler = onShowWindow;
    tray = new Tray(icon);
    tray.setToolTip('IPTVnator');
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: 'Show IPTVnator', click: showWindow },
            { type: 'separator' },
            {
                label: 'Quit IPTVnator',
                click: () => {
                    markAppQuitting();
                    app.quit();
                },
            },
        ])
    );
    // Windows/Linux: a click restores the window instead of opening the menu.
    tray.on('click', showWindow);
    return tray;
}

/** `app.quit()` and the tray's Quit set this before windows start closing. */
export function markAppQuitting(): void {
    quitting = true;
}

/**
 * A close request hides the window instead of ending the process, so a
 * scheduled recording still fires and an active one is not cut short.
 * Quitting from the tray, the menu or an update install does not hide.
 */
export function shouldHideOnClose(): boolean {
    return tray !== null && !quitting;
}

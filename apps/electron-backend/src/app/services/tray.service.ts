import { app, nativeImage, Tray, Menu } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * The tray keeps the daemonized app reachable once its window is closed:
 * scheduled recordings and a running background recording must outlive the
 * window. The tray only exists when an icon can be loaded — without one
 * there is no way back from a hidden window, so closing keeps quitting.
 *
 * `nativeImage.createFromPath` reads PNG/JPEG (ICO on Windows) only, and it
 * cannot read inside `app.asar`, so the packaged build ships the tray image
 * as a real file in `resources/` — see `extraResources` in
 * `electron-builder.json`. The web assets are only reachable in a dev run.
 */

let tray: Tray | null = null;
let showWindowHandler: (() => void) | null = null;
let quitting = false;

function joinIfPresent(base: unknown, relative: string): string | null {
    return typeof base === 'string' && base ? join(base, relative) : null;
}

/** The test harnesses stub only the Electron calls a spec exercises. */
function readAppPath(): string | undefined {
    try {
        const path = app.getAppPath();
        return typeof path === 'string' ? path : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Icon files a tray can load, most likely first. A packaged build resolves
 * both `resources/` entries; a dev run falls back to the workspace assets.
 */
export function trayIconCandidates(): string[] {
    const resourcesPath = process.resourcesPath;
    const appPath = readAppPath();
    return [
        joinIfPresent(resourcesPath, 'tray-icon.png'),
        joinIfPresent(resourcesPath, 'icon.png'),
        joinIfPresent(appPath, 'web/assets/icons/icon-32.png'),
        joinIfPresent(appPath, 'apps/web/src/assets/icons/icon-32.png'),
        joinIfPresent(appPath, 'assets/icons/icon-32.png'),
    ].filter((candidate): candidate is string => candidate !== null);
}

function resolveTrayIcon(): Electron.NativeImage | null {
    for (const candidate of trayIconCandidates()) {
        if (!existsSync(candidate)) {
            continue;
        }
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
            return image;
        }
    }
    return null;
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

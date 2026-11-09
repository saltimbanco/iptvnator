import { spawn } from 'child_process';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';
import readline from 'readline';
import {
    parseRecorderEvent,
    RecorderEvent,
} from './background-recorder-protocol';
import { getEmbeddedMpvAddonCandidatePaths } from './embedded-mpv-frame-copy-platform.util';

export const BACKGROUND_RECORDER_FILE_NAME = 'iptvnator_mpv_recorder.exe';

/** How long `shutdown` waits for the recorder to flush and exit. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** One running `iptvnator_mpv_recorder.exe`, as the service sees it. */
export interface RecorderProcess {
    send(command: string): void;
    onEvent(listener: (event: RecorderEvent) => void): void;
    onExit(listener: (code: number | null) => void): void;
    /**
     * Asks the recorder to close its file and exit, and resolves once it
     * has (or after a bounded wait, when it is killed).
     */
    shutdown(): Promise<void>;
}

/**
 * The recorder ships beside the embedded MPV addon and its mpv DLL, so it
 * is found the same way: packaged builds only look inside the app, never at
 * development paths a writable launch directory could supply.
 */
export function resolveBackgroundRecorderPath(): string | null {
    if (process.platform !== 'win32') {
        return null;
    }
    for (const addonPath of getEmbeddedMpvAddonCandidatePaths()) {
        const candidate = path.join(
            path.dirname(addonPath),
            BACKGROUND_RECORDER_FILE_NAME
        );
        try {
            accessSync(candidate, fsConstants.X_OK);
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Try the next location.
        }
    }
    return null;
}

export function spawnRecorderProcess(executablePath: string): RecorderProcess {
    const child = spawn(executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const eventListeners: Array<(event: RecorderEvent) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];
    let exited = false;
    let exitCode: number | null = null;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const event = parseRecorderEvent(line);
        if (!event) {
            return;
        }
        if (event.event === 'log') {
            // The recorder already redacts lines that contain URLs.
            if (event.level === 'error' && event.prefix !== 'ffmpeg/video') {
                console.error(
                    `[Background recording][mpv/${event.prefix ?? ''}] ${event.text}`
                );
            }
            return;
        }
        eventListeners.forEach((listener) => listener(event));
    });
    // Drained so a chatty DLL can never block the recorder on a full pipe.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);

    const markExited = (code: number | null) => {
        if (exited) {
            return;
        }
        exited = true;
        exitCode = code;
        exitListeners.forEach((listener) => listener(code));
    };
    child.on('exit', (code) => markExited(code));
    child.on('error', (error) => {
        console.error('[Background recording] recorder failed:', error);
        markExited(null);
    });

    const send = (command: string) => {
        if (!exited && child.stdin.writable) {
            child.stdin.write(`${command}\n`);
        }
    };

    return {
        send,
        onEvent(listener) {
            eventListeners.push(listener);
        },
        onExit(listener) {
            if (exited) {
                listener(exitCode);
                return;
            }
            exitListeners.push(listener);
        },
        shutdown() {
            if (exited) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    child.kill();
                    resolve();
                }, SHUTDOWN_TIMEOUT_MS);
                exitListeners.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
                // `quit` stops (flushing the file) and exits; closing stdin
                // has the same effect if the line is never read.
                send('quit');
                child.stdin.end();
            });
        },
    };
}

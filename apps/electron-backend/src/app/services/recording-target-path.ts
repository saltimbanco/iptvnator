import { closeSync, openSync, unlinkSync } from 'fs';
import path from 'path';

/**
 * File naming for live-TV recordings, shared by the embedded MPV recording
 * and the Windows background recorder:
 * `<sanitized title, max 120 chars>-<YYYYMMDD-HHMMSS local time>.ts`, with
 * `-2`, `-3`… on a clash. The name is claimed with an exclusive create, so
 * two recordings started in the same second never share a file.
 */
export function reserveRecordingTargetPath(
    directory: string,
    title: string,
    now: Date = new Date()
): string {
    const baseName = sanitizeRecordingFileName(title);
    const timestamp = formatRecordingTimestamp(now);
    let candidate = path.join(directory, `${baseName}-${timestamp}.ts`);
    let suffix = 2;

    while (true) {
        try {
            const fd = openSync(candidate, 'wx');
            closeSync(fd);
            return candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                candidate = path.join(
                    directory,
                    `${baseName}-${timestamp}-${suffix}.ts`
                );
                suffix += 1;
                continue;
            }

            throw error;
        }
    }
}

/** Removes a reserved path whose recording never started. */
export function releaseRecordingTargetPath(targetPath: string): void {
    try {
        unlinkSync(targetPath);
    } catch {
        // Ignore cleanup failures; the start error is more useful.
    }
}

function sanitizeRecordingFileName(title: string): string {
    const normalized = title
        // Control characters are invalid in file names on Windows; the
        // range is matched intentionally.
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return (normalized || 'IPTVnator recording').slice(0, 120);
}

function formatRecordingTimestamp(date: Date): string {
    const parts = [
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
    ].map((part) => String(part).padStart(2, '0'));

    return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

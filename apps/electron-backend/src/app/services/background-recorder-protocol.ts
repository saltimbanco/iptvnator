import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { joinMpvHeaderFields } from '../util/mpv-string-list.util';
import { encodeProtocolValue } from './embedded-mpv-frame-copy-protocol';

/**
 * Wire protocol for `iptvnator_mpv_recorder.exe`
 * (native/helper/mpv_recorder.cpp): the frame helper's tab-separated,
 * percent-encoded commands on stdin, one JSON event per line on stdout.
 * The stream URL and headers only ever travel over stdin.
 */

export type RecorderEvent =
    | { event: 'ready' }
    | { event: 'opened' }
    | { event: 'recording'; path: string }
    | { event: 'buffering'; active: boolean }
    | { event: 'record-failed'; error: string }
    | { event: 'ended'; reason: string; error?: string }
    | { event: 'stopped' }
    | { event: 'fatal'; error: string }
    | { event: 'log'; level: string; prefix?: string; text: string };

/** `open`: start playing `playback` and recording it into `path`. */
export function buildRecorderOpenCommand(
    playback: ResolvedPortalPlayback,
    path: string
): string {
    const fields = [
        `url=${encodeProtocolValue(playback.streamUrl)}`,
        `path=${encodeProtocolValue(path)}`,
    ];
    if (playback.userAgent) {
        fields.push(`user-agent=${encodeProtocolValue(playback.userAgent)}`);
    }
    if (playback.referer) {
        fields.push(`referrer=${encodeProtocolValue(playback.referer)}`);
    }
    const headers = Object.entries(playback.headers ?? {}).map(
        ([key, value]) => `${key}: ${value}`
    );
    if (
        playback.origin &&
        !Object.keys(playback.headers ?? {}).some(
            (key) => key.toLowerCase() === 'origin'
        )
    ) {
        headers.push(`Origin: ${playback.origin}`);
    }
    if (headers.length > 0) {
        // Set as mpv's comma-separated http-header-fields list, so commas
        // inside values (MAG user agents) must be mpv-escaped.
        fields.push(
            `headers=${encodeProtocolValue(joinMpvHeaderFields(headers))}`
        );
    }
    return `open\t${fields.join('\t')}`;
}

/** Parses one stdout line; anything that is not an event object is null. */
export function parseRecorderEvent(line: string): RecorderEvent | null {
    try {
        const value = JSON.parse(line) as unknown;
        if (
            value &&
            typeof value === 'object' &&
            typeof (value as { event?: unknown }).event === 'string'
        ) {
            return value as RecorderEvent;
        }
    } catch {
        // Not JSON: libmpv or a DLL wrote to stdout directly.
    }
    return null;
}

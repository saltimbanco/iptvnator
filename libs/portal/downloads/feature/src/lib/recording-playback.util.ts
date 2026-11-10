import { VideoPlayer } from '@iptvnator/shared/interfaces';

/** `C:` / `D:` drive segments stay literal inside a file URL. */
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

/**
 * `file://` URL for a local recording.
 *
 * A bare `C:\recordings\News.ts` handed to a `<video>`/Video.js source is read
 * as a relative URL and 404s; the renderer (a `file://` document in packaged
 * Electron, per the CSP `media-src file:`) needs the absolute file URL.
 * Segments are encoded individually so a drive letter survives while spaces,
 * `#` and `?` in channel-derived file names do not truncate the URL.
 */
export function recordingFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = normalized
        .split('/')
        .map((segment) =>
            WINDOWS_DRIVE.test(segment) ? segment : encodeURIComponent(segment)
        )
        .join('/');

    // UNC path (`\\server\share\file.ts`) — the host stays the URL authority.
    if (encoded.startsWith('//')) {
        return `file:${encoded}`;
    }
    return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * Source for the player engine that will actually play the recording.
 *
 * Recordings are MPEG-TS. The embedded MPV engine takes the filesystem path
 * natively; the web engines (HTML5, Video.js, ArtPlayer) only load it as a
 * `file://` URL.
 */
export function recordingPlaybackSource(
    filePath: string,
    player: VideoPlayer
): string {
    return player === VideoPlayer.EmbeddedMpv
        ? filePath
        : recordingFileUrl(filePath);
}

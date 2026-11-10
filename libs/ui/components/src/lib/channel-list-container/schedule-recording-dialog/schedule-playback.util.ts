import type {
    RecordingStartMetadata,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import type { Channel } from '@iptvnator/shared/interfaces';

/**
 * The playback a scheduled M3U recording replays when the timer fires. The
 * stream URL and its headers come from the channel itself; per-playlist
 * defaults (user agent, referrer) are not needed here because a channel
 * that relies on them carries them in its own `http` block.
 */
export function buildM3uSchedulePlayback(
    channel: Channel
): ResolvedPortalPlayback {
    const userAgent = channel.http?.['user-agent']?.trim();
    const referer = channel.http?.referrer?.trim();
    const origin = channel.http?.origin?.trim();

    const headers: Record<string, string> = {};
    if (userAgent) {
        headers['User-Agent'] = userAgent;
    }
    if (referer) {
        headers['Referer'] = referer;
    }
    if (origin) {
        headers['Origin'] = origin;
    }

    return {
        streamUrl: channel.url ?? '',
        title: channel.name ?? '',
        thumbnail: channel.tvg?.logo ?? null,
        isLive: true,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        userAgent,
        referer,
        origin,
    };
}

/** Recording metadata for a channel, without a playlist-level lookup. */
export function buildM3uRecordingMetadata(
    channel: Channel,
    playlist?: { id?: string; name?: string }
): RecordingStartMetadata {
    return {
        channelName: channel.name ?? '',
        channelLogoUrl: channel.tvg?.logo,
        epgChannelId: channel.tvg?.id || undefined,
        playlistId: playlist?.id,
        playlistName: playlist?.name,
        sourceType: 'm3u',
    };
}

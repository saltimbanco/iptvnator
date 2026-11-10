import type {
    ResolvedPortalPlayback,
    StalkerScheduleRefresh,
} from '@iptvnator/shared/interfaces';
import type { ScheduleRecordingTarget } from '@iptvnator/ui/components';

/** The parts of a Stalker ITV/radio row a schedule snapshot needs. */
export interface StalkerScheduleChannel {
    readonly id?: string | number;
    readonly cmd?: string;
    readonly name?: string;
    readonly o_name?: string;
    readonly logo?: string;
}

export interface StalkerSchedulePlaylist {
    readonly _id?: string | number | null;
    readonly title?: string | null;
}

export function stalkerScheduleChannelName(
    channel: StalkerScheduleChannel
): string {
    return (
        channel.o_name?.trim() ||
        channel.name?.trim() ||
        String(channel.id ?? '').trim()
    );
}

/**
 * What a Stalker schedule stores: the playback the portal resolved right now
 * (`create_link` plus the portal's mac cookie headers) and a metadata
 * snapshot, so the row still reads correctly after the playlist is gone.
 *
 * Portals expire `create_link` URLs, so the row also keeps the channel's
 * portal command: the main process mints a fresh link at the start instant
 * and only falls back to this snapshot when the portal is unreachable.
 */
export function buildStalkerScheduleTarget(
    channel: StalkerScheduleChannel,
    playback: ResolvedPortalPlayback,
    playlist: StalkerSchedulePlaylist | null | undefined,
    contentType: StalkerScheduleRefresh['contentType']
): ScheduleRecordingTarget | null {
    const channelName = stalkerScheduleChannelName(channel);
    if (!channelName || !playback.streamUrl) {
        return null;
    }

    return {
        playback: {
            ...playback,
            title: playback.title || channelName,
            isLive: true,
        },
        metadata: {
            channelName,
            channelLogoUrl: channel.logo,
            playlistId:
                playlist?._id == null ? undefined : String(playlist._id),
            playlistName: playlist?.title ?? undefined,
            sourceType: 'stalker',
        },
        refresh: channel.cmd?.trim()
            ? {
                  kind: 'stalker',
                  cmd: channel.cmd.trim(),
                  contentType,
              }
            : undefined,
    };
}

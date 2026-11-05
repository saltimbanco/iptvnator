import type { StalkerLiveChannelIndexEntry } from '@iptvnator/shared/interfaces';
import {
    serializeStalkerLiveChannelIndex,
    stalkerLiveChannelIndexKey,
} from '@iptvnator/shared/interfaces';
import type { DatabaseService } from '@iptvnator/services';
import type { StalkerItvChannel } from './models';

/**
 * Reduces a portal's ITV list to what a hop needs: the provider id that opens
 * the channel, its name for fuzzy matching, and its genre.
 */
export function toStalkerLiveIndexEntries(
    channels: readonly StalkerItvChannel[]
): StalkerLiveChannelIndexEntry[] {
    const entries: StalkerLiveChannelIndexEntry[] = [];
    const seen = new Set<string>();
    for (const channel of channels) {
        const id = String(channel?.id ?? '').trim();
        const title = String(channel?.name ?? channel?.o_name ?? '').trim();
        if (!id || !title || seen.has(id)) {
            continue;
        }
        seen.add(id);
        const genreId = channel?.tv_genre_id;
        entries.push({
            id,
            title,
            genreId:
                genreId === undefined || genreId === null || genreId === ''
                    ? null
                    : String(genreId),
            logo: channel?.logo ? String(channel.logo) : null,
        });
    }
    return entries;
}

/**
 * Stores the channel list under the portal's app-state key, where the live
 * failover looks for hop candidates. Fire-and-forget: the index is a cache, so
 * a failed write (no bridge, read-only profile) costs a hop, never a load.
 */
export async function persistStalkerLiveChannelIndex(
    database: Pick<DatabaseService, 'setAppState'>,
    playlistId: string | null | undefined,
    channels: readonly StalkerItvChannel[]
): Promise<void> {
    if (!playlistId) {
        return;
    }
    try {
        await database.setAppState(
            stalkerLiveChannelIndexKey(playlistId),
            serializeStalkerLiveChannelIndex(toStalkerLiveIndexEntries(channels))
        );
    } catch {
        // See the doc comment: an index write never breaks the catalog.
    }
}

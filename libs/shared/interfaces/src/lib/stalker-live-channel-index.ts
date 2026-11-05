/**
 * Index of the live channels a Stalker portal has served.
 *
 * Stalker channels never reach the `content` table (the portal is paginated
 * behind an authenticated `get_ordered_list`), so the catalog search the live
 * failover runs cannot see them and a Stalker-only setup has no candidate to
 * hop to. The ITV cache persists what it loaded under one app-state key per
 * portal; the failover reads those keys to find the same channel on the
 * user's other portals. One row per channel, carrying the portal's own
 * provider id and genre, because opening the channel needs both.
 */
export interface StalkerLiveChannelIndexEntry {
    /** The portal's provider channel id (`get_ordered_list`'s `id`). */
    id: string;
    title: string;
    /** The channel's genre (`tv_genre_id`), when the portal names one. */
    genreId: string | null;
    logo: string | null;
}

const STALKER_LIVE_CHANNEL_INDEX_PREFIX = 'stalker-live-channel-index:';

export function stalkerLiveChannelIndexKey(playlistId: string): string {
    return `${STALKER_LIVE_CHANNEL_INDEX_PREFIX}${playlistId}`;
}

export function serializeStalkerLiveChannelIndex(
    entries: readonly StalkerLiveChannelIndexEntry[]
): string {
    return JSON.stringify(entries);
}

/**
 * Entries from a stored index, tolerating anything unreadable: the value is a
 * cache written by an older version (or a half-written blob), and a bad one
 * must cost a failover candidate, never an exception in the player.
 */
export function parseStalkerLiveChannelIndex(
    raw: string | null | undefined
): StalkerLiveChannelIndexEntry[] {
    if (!raw) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    const entries: StalkerLiveChannelIndexEntry[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const row = item as Record<string, unknown>;
        const rawId = row['id'];
        const rawTitle = row['title'];
        const rawGenreId = row['genreId'];
        const rawLogo = row['logo'];
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
        if (!id || !title) {
            continue;
        }
        entries.push({
            id,
            title,
            genreId:
                typeof rawGenreId === 'string' && rawGenreId.trim() !== ''
                    ? rawGenreId
                    : null,
            logo: typeof rawLogo === 'string' && rawLogo !== '' ? rawLogo : null,
        });
    }
    return entries;
}

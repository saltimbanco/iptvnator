import {
    normalizeImportScope,
    Playlist,
    PlaylistImportScope,
} from '@iptvnator/shared/interfaces';
import { isLikelyM3uVod } from './m3u-vod-detection.util';

export interface M3uScopeFilterItem {
    url?: string;
    radio?: string;
}

/**
 * Drops the sections of a parsed M3U the import scope excludes. VOD is the
 * `isLikelyM3uVod` heuristic (movie containers, `/movie|movies|vod|series/`
 * paths); everything else counts as live. A full scope returns the input
 * untouched so the common path pays no copy.
 */
export function filterM3uItemsByImportScope<T extends M3uScopeFilterItem>(
    items: T[],
    scope: PlaylistImportScope | null | undefined
): T[] {
    const { importLive, importVod } = normalizeImportScope(scope);
    if (importLive && importVod) {
        return items;
    }
    return items.filter((item) => {
        const isVod = isLikelyM3uVod({
            url: item.url ?? '',
            radio: item.radio ?? '',
        });
        return isVod ? importVod : importLive;
    });
}

/**
 * Applies an import scope to a parsed M3U playlist: drops the excluded
 * section's items and records a partial scope on the row so later refreshes
 * keep it. A full scope strips stale opt-outs (the user re-enabled the
 * section) and otherwise returns the playlist untouched.
 */
export function applyImportScopeToPlaylist<T extends Playlist>(
    playlist: T,
    scope: PlaylistImportScope | null | undefined
): T {
    const { importLive, importVod } = normalizeImportScope(scope);
    const items = playlist.playlist?.items;
    const needsFiltering = (!importLive || !importVod) && Array.isArray(items);
    const staleOptOut =
        (importLive && playlist.importLive === false) ||
        (importVod && playlist.importVod === false);
    if (!needsFiltering && !staleOptOut) {
        return playlist;
    }
    const next: T = { ...playlist };
    if (importLive) {
        delete next.importLive;
    } else {
        next.importLive = false;
    }
    if (importVod) {
        delete next.importVod;
    } else {
        next.importVod = false;
    }
    if (needsFiltering) {
        const filtered = (items as M3uScopeFilterItem[]).filter((item) => {
            const isVod = isLikelyM3uVod({
                url: item?.url ?? '',
                radio: item?.radio ?? '',
            });
            return isVod ? importVod : importLive;
        });
        next.count = filtered.length;
        next.playlist = { ...playlist.playlist, items: filtered };
    }
    return next;
}

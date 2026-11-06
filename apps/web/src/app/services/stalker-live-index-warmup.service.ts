import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { selectAllPlaylistsMeta } from '@iptvnator/m3u-state';
import { StalkerItvCacheService } from '@iptvnator/portal/stalker/data-access';
import { DatabaseService, SettingsStore } from '@iptvnator/services';
import {
    stalkerLiveChannelIndexKey,
    type PlaylistMeta,
} from '@iptvnator/shared/interfaces';
import { filter, firstValueFrom, take } from 'rxjs';

/**
 * Builds the Stalker live channel index once per portal at startup.
 *
 * `LiveChannelFailoverService` can only hop to a Stalker channel that the
 * index knows about, and the index is written as a side effect of loading a
 * portal's full live list. Without this warm-up that list is loaded only when
 * the portal is opened, so after a restart a failover has nothing to hop to
 * until the user visits every portal by hand.
 *
 * Deliberately conservative:
 * - Only runs with Settings → Live channel failover on: the index has no
 *   other reader, and a cold start must not crawl portals the user does not
 *   use for failover.
 * - Skips portals that already carry an index: channel ids are stable, and
 *   re-crawling every portal on every start would be far more traffic than
 *   the feature is worth. A refreshed list still wins when the portal is
 *   opened, and the next start picks that up.
 * - Loads one portal at a time and swallows failures: an unreachable or
 *   legacy paged portal leaves no index, exactly as before, and the
 *   workspace's own lazy load keeps working.
 */
@Injectable({ providedIn: 'root' })
export class StalkerLiveIndexWarmupService {
    private readonly store = inject(Store);
    private readonly database = inject(DatabaseService);
    private readonly settings = inject(SettingsStore);
    private readonly itvCache = inject(StalkerItvCacheService);

    private started = false;

    /** Starts the warm-up once; later calls are no-ops. */
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        void this.run();
    }

    private async run(): Promise<void> {
        const playlists = await this.loadPlaylists();
        if (!playlists.some((playlist) => Boolean(playlist.portalUrl))) {
            return;
        }
        await this.settings.loadSettings().catch(() => undefined);
        if (this.settings.liveChannelFailover?.() !== true) {
            return;
        }
        for (const playlist of playlists) {
            if (!playlist.portalUrl) {
                continue;
            }
            if (await this.hasIndex(playlist._id)) {
                continue;
            }
            // `ensureLoaded` itself is shared with the workspace: a portal
            // the user opens while the warm-up runs is crawled once.
            await this.itvCache.ensureLoaded(playlist).catch(() => undefined);
        }
    }

    private loadPlaylists(): Promise<PlaylistMeta[]> {
        return firstValueFrom(
            this.store.select(selectAllPlaylistsMeta).pipe(
                filter((playlists) => playlists.length > 0),
                take(1)
            )
        );
    }

    private async hasIndex(playlistId: string): Promise<boolean> {
        try {
            const raw = await this.database.getAppState(
                stalkerLiveChannelIndexKey(playlistId)
            );
            return raw !== null && raw !== undefined;
        } catch {
            // A read failure is not a reason to skip: the load below writes
            // the index anyway, and its own failure is swallowed there.
            return false;
        }
    }
}

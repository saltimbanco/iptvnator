import { inject, Injectable, type Provider } from '@angular/core';
import {
    DataService,
    PORTAL_CONTENT_SEEDERS,
    SettingsStore,
    type PortalContentSeeder,
} from '@iptvnator/services';
import {
    shouldImportLive,
    shouldImportVod,
    StalkerPortalActions,
    type Playlist,
} from '@iptvnator/shared/interfaces';
import { StalkerContentTypes } from './stalker-content-types';
import { StalkerItvCacheService } from './stalker-itv-cache.service';
import { StalkerPortalRepairService } from './stalker-portal-repair.service';
import { StalkerSessionService } from './stalker-session.service';
import { executeStalkerRequest, type StalkerRequestDeps } from './stores/utils';

/** One page of `get_ordered_list`, the same call the workspace opens with. */
interface StalkerSeedPageResponse {
    js?: {
        data?: unknown;
        total_items?: number | string;
    };
}

interface StalkerSeedCategoriesResponse {
    js?: unknown;
}

/**
 * Validates a freshly imported Stalker source and starts warming its live
 * catalog. Bulk import hands every portal row here before it counts as
 * imported:
 *
 * - One page-1 `get_ordered_list` request proves the portal answers for this
 *   MAC and actually carries live channels; a rejected handshake, an
 *   unreadable panel or an empty list throws, so the bulk import skips the
 *   source and deletes the row's stored playlist, exactly like the Xtream
 *   seeder.
 * - The full channel list is then warmed through `StalkerItvCacheService` in
 *   the background (the workspace loads it the same way on first open), so
 *   the first visit and search do not wait for the crawl. It is deliberately
 *   not awaited: a large panel must not use up the row's one-minute import
 *   budget, and a failed warm just leaves the workspace's own lazy load to
 *   run.
 *
 * Only one page is fetched here, so a portal that pages slowly still imports.
 * Stalker VOD and series catalogs are paged too and are NOT crawled during the
 * import; a VOD-only row is validated with its category list instead.
 */
@Injectable({ providedIn: 'root' })
export class StalkerContentSeedService implements PortalContentSeeder {
    private readonly dataService = inject(DataService);
    private readonly stalkerSession = inject(StalkerSessionService);
    private readonly portalRepair = inject(StalkerPortalRepairService);
    private readonly itvCache = inject(StalkerItvCacheService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly requestDeps: StalkerRequestDeps = {
        dataService: this.dataService,
        stalkerSession: this.stalkerSession,
        portalRepair: this.portalRepair,
    };

    async seed(playlist: Playlist): Promise<void> {
        if (!playlist._id || !playlist.portalUrl || !playlist.macAddress) {
            return;
        }

        // The global Disable VOD setting leaves every row live-only, exactly
        // like the workspace's own section gate.
        const importVod =
            shouldImportVod(playlist) &&
            this.settingsStore.disableVod?.() !== true;
        const importLive = shouldImportLive(playlist) || !importVod;

        if (importLive) {
            const response =
                await executeStalkerRequest<StalkerSeedPageResponse>(
                    this.requestDeps,
                    playlist,
                    {
                        action: StalkerPortalActions.GetOrderedList,
                        type: 'itv',
                        category: '*',
                        genre: '*',
                        sortby: 'number',
                        p: 1,
                    }
                );
            const channels = response?.js?.data;
            if (!Array.isArray(channels) || channels.length === 0) {
                throw new Error('The source returned no live channels');
            }
            void this.itvCache
                .ensureLoaded(playlist)
                .catch(() => undefined);
            return;
        }

        const response =
            await executeStalkerRequest<StalkerSeedCategoriesResponse>(
                this.requestDeps,
                playlist,
                {
                    action: StalkerContentTypes.vod.getCategoryAction,
                    type: 'vod',
                }
            );
        if (!Array.isArray(response?.js)) {
            throw new Error('The source did not return categories');
        }
    }
}

/** Registers the Stalker seeder with the bulk import's seeder list. */
export function provideStalkerContentSeeder(): Provider[] {
    return [
        {
            provide: PORTAL_CONTENT_SEEDERS,
            multi: true,
            useExisting: StalkerContentSeedService,
        },
    ];
}

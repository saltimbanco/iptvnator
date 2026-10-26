import { inject, Injectable } from '@angular/core';
import { createLogger } from '@iptvnator/portal/shared/util/logger';
import { DatabaseService, SettingsStore } from '@iptvnator/services';
import { shouldImportLive, shouldImportVod } from '@iptvnator/shared/interfaces';
import { XTREAM_DATA_SOURCE } from './data-sources/xtream-data-source.interface';
import type {
    CategoryType,
    StreamType,
    XtreamCredentials,
} from './services/xtream-api.service';
import type { PortalContentSeeder } from '@iptvnator/services';
import type { Playlist } from '@iptvnator/shared/interfaces';

/**
 * Fills the stored catalogs of a freshly imported Xtream source: categories
 * plus live channels, and — only when the row's import scope wants them —
 * movies and series. The workspace hydrates from those stores on first
 * open, so a bulk-imported source is usable without waiting for a live
 * portal download there.
 */
@Injectable({ providedIn: 'root' })
export class XtreamContentSeedService implements PortalContentSeeder {
    private readonly dataSource = inject(XTREAM_DATA_SOURCE);
    private readonly databaseService = inject(DatabaseService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly logger = createLogger('XtreamContentSeed');

    async seed(playlist: Playlist): Promise<void> {
        const playlistId = playlist._id;
        const credentials: XtreamCredentials = {
            serverUrl: playlist.serverUrl ?? '',
            username: playlist.username ?? '',
            password: playlist.password ?? '',
        };
        if (
            !playlistId ||
            !credentials.serverUrl ||
            !credentials.username ||
            !credentials.password
        ) {
            return;
        }

        // The global Disable VOD setting wins over the row's scope, exactly
        // like the workspace catalogs: even a VOD-only row seeds live only.
        const importVod =
            shouldImportVod(playlist) &&
            this.settingsStore.disableVod?.() !== true;
        const importLive = shouldImportLive(playlist) || !importVod;

        try {
            const categoryTypes: CategoryType[] = importLive
                ? importVod
                    ? ['live', 'vod', 'series']
                    : ['live']
                : ['vod', 'series'];
            for (const type of categoryTypes) {
                await this.dataSource.getCategories(
                    playlistId,
                    credentials,
                    type
                );
            }

            const streamTypes: StreamType[] = importLive
                ? importVod
                    ? ['live', 'movie', 'series']
                    : ['live']
                : ['movie', 'series'];
            for (const type of streamTypes) {
                await this.dataSource.getContent(
                    playlistId,
                    credentials,
                    type
                );
                // Mark the section done so the workspace's first open reads
                // the cache instead of re-fetching it from the portal.
                await this.databaseService.setXtreamImportStatus(
                    playlistId,
                    type,
                    'completed'
                );
            }
        } catch (error) {
            // Seeding is best effort: the source stays importable, and the
            // workspace imports on first open where errors surface properly.
            this.logger.warn(
                'Background content seed failed for an Xtream source:',
                error
            );
        }
    }
}

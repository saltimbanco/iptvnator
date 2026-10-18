import { InjectionToken } from '@angular/core';
import { Playlist } from '@iptvnator/shared/interfaces';

/**
 * Fills a portal source's stored catalogs (channels, movies, series) so a
 * source freshly added by a bulk import is ready before its workspace is
 * ever opened. Implementations are seeded sequentially by the bulk import
 * and are best effort: they resolve even when a fetch fails so one bad
 * provider cannot stall the remaining sources of the batch.
 */
export type PortalContentSeeder = {
    seed(playlist: Playlist): Promise<void>;
};

export const PORTAL_CONTENT_SEEDERS = new InjectionToken<
    PortalContentSeeder[]
>('PORTAL_CONTENT_SEEDERS');

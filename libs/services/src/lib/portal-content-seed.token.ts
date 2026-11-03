import { InjectionToken } from '@angular/core';
import { Playlist } from '@iptvnator/shared/interfaces';

/**
 * Fills a portal source's stored catalogs (channels, movies, series) so a
 * source freshly added by a bulk import is ready before its workspace is
 * ever opened. The bulk import seeds sources one at a time under a
 * per-source timeout; implementations reject when the source cannot be
 * read, so the import skips that source and moves on to the next.
 */
export type PortalContentSeeder = {
    seed(playlist: Playlist): Promise<void>;
};

export const PORTAL_CONTENT_SEEDERS = new InjectionToken<
    PortalContentSeeder[]
>('PORTAL_CONTENT_SEEDERS');

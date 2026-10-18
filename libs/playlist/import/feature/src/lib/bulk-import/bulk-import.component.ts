import {
    Component,
    computed,
    inject,
    output,
    signal,
    ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIcon } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlaylistActions } from '@iptvnator/m3u-state';
import {
    DataService,
    PlaylistsService,
    PORTAL_CONTENT_SEEDERS,
    type PortalContentSeeder,
} from '@iptvnator/services';
import {
    BulkImportEntry,
    bulkEntriesFromJson,
    bulkEntryToPlaylist,
    candidatesToBulkEntries,
    detectProviderImportCandidates,
    isDirectBulkPlaylistEntry,
    PLAYLIST_PARSE_BY_URL,
    SOURCE_TYPE_ICONS,
    storedImportScopeFlags,
    type Playlist,
    type ProviderImportKind,
} from '@iptvnator/shared/interfaces';

const KIND_ICONS: Record<ProviderImportKind, string> = {
    xtream: SOURCE_TYPE_ICONS.xtream,
    stalker: SOURCE_TYPE_ICONS.stalker,
    'm3u-url': SOURCE_TYPE_ICONS['m3u-url'],
    'm3u-text': SOURCE_TYPE_ICONS['m3u-text'],
};

const KIND_LABEL_KEYS: Record<ProviderImportKind, string> = {
    xtream: 'HOME.ADD_PLAYLIST.METHOD_XTREAM_LABEL',
    stalker: 'HOME.ADD_PLAYLIST.METHOD_STALKER_LABEL',
    'm3u-url': 'HOME.ADD_PLAYLIST.METHOD_URL_LABEL',
    'm3u-text': 'HOME.ADD_PLAYLIST.METHOD_TEXT_LABEL',
};

/**
 * Bulk source import: everything the user wants is inside one file
 * (`.txt` of provider handouts, or `.json` with the explicit
 * `{ "sources": [...] }` shape — no free-text field). File content runs
 * through the same deterministic detection as the auto import. Each row
 * carries its own title plus Live/VOD scope toggles (VOD starts off), and
 * rows can be dropped before importing. Portal rows (Xtream/Stalker) are
 * persisted in one awaited `addManyPlaylists` and seeded in the background
 * so their catalogs exist before first open; M3U rows go through the
 * regular URL/text pipelines with the row's scope attached.
 */
@Component({
    selector: 'app-bulk-import',
    templateUrl: './bulk-import.component.html',
    styleUrl: './bulk-import.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatCheckboxModule,
        MatIcon,
        TranslatePipe,
    ],
})
export class BulkImportComponent {
    readonly imported = output<void>();

    private readonly store = inject(Store);
    private readonly router = inject(Router);
    private readonly dataService = inject(DataService);
    private readonly playlistsService = inject(PlaylistsService);
    private readonly seeders = inject(PORTAL_CONTENT_SEEDERS, {
        optional: true,
    }) ?? [];
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);

    readonly entries = signal<BulkImportEntry[]>([]);
    /** Translated message; null when there is nothing to report. */
    readonly fileError = signal<string | null>(null);
    readonly loadedFileName = signal<string | null>(null);
    readonly isImporting = signal(false);

    readonly importableEntries = computed(() =>
        this.entries().filter((entry) => entry.valid)
    );
    readonly hasEntries = computed(() => this.entries().length > 0);

    clearForm(): void {
        this.entries.set([]);
        this.fileError.set(null);
        this.loadedFileName.set(null);
    }

    async onFilePicked(input: HTMLInputElement): Promise<void> {
        const file = input.files?.[0];
        input.value = '';
        if (!file) {
            return;
        }
        this.fileError.set(null);
        let contents: string;
        try {
            contents = await file.text();
        } catch {
            this.fileError.set(
                this.translate.instant('HOME.FILE_UPLOAD.OPEN_FAILED', {
                    filename: file.name,
                })
            );
            return;
        }

        if (!this.parseSourceFile(contents)) {
            return;
        }
        this.loadedFileName.set(file.name);
    }

    setEntryTitle(id: string, title: string): void {
        this.patchEntry(id, { title });
    }

    setEntryLive(id: string, checked: boolean): void {
        const entry = this.entries().find((row) => row.id === id);
        if (!entry) {
            return;
        }
        // Same guard as the single-source scope picker: a source that
        // imports nothing is broken, so the last checked box stays on.
        this.patchEntry(id, { importLive: checked || !entry.importVod });
    }

    setEntryVod(id: string, checked: boolean): void {
        const entry = this.entries().find((row) => row.id === id);
        if (!entry) {
            return;
        }
        this.patchEntry(id, { importVod: checked || !entry.importLive });
    }

    removeEntry(id: string): void {
        this.entries.update((rows) => rows.filter((row) => row.id !== id));
    }

    kindIcon(kind: ProviderImportKind): string {
        return KIND_ICONS[kind];
    }

    kindLabelKey(kind: ProviderImportKind): string {
        return KIND_LABEL_KEYS[kind];
    }

    /** One-line masked summary; passwords are never rendered. */
    entrySummary(entry: BulkImportEntry): string {
        const candidate = entry.candidate;
        switch (candidate.kind) {
            case 'm3u-url':
                return candidate.url ?? '';
            case 'm3u-text':
                return this.translate.instant(
                    'HOME.ADD_PLAYLIST.METHOD_TEXT_LABEL'
                );
            case 'xtream':
                return [candidate.serverUrl, candidate.username]
                    .filter(Boolean)
                    .join(' · ');
            case 'stalker':
                return [candidate.portalUrl, candidate.macAddress]
                    .filter(Boolean)
                    .join(' · ');
        }
    }

    async importAll(): Promise<void> {
        const rows = this.importableEntries();
        if (rows.length === 0 || this.isImporting()) {
            return;
        }
        this.isImporting.set(true);
        try {
            // Portal rows persist in one awaited write, then the NgRx state
            // syncs without persisting again (`persist: false`).
            const portalPlaylists = rows
                .filter(isDirectBulkPlaylistEntry)
                .map(bulkEntryToPlaylist)
                .filter((playlist) => playlist !== null);
            if (portalPlaylists.length > 0) {
                await firstValueFrom(
                    this.playlistsService.addManyPlaylists(portalPlaylists)
                );
                this.store.dispatch(
                    PlaylistActions.addManyPlaylists({
                        playlists: portalPlaylists,
                        persist: false,
                    })
                );
            }
            let m3uCount = 0;
            for (const row of rows) {
                const scope = storedImportScopeFlags(row);
                if (
                    row.kind === 'm3u-url' &&
                    row.candidate.url
                ) {
                    m3uCount += 1;
                    this.dataService.sendIpcEvent(PLAYLIST_PARSE_BY_URL, {
                        url: row.candidate.url,
                        title: row.title,
                        ...scope,
                    });
                } else if (
                    row.kind === 'm3u-text' &&
                    row.candidate.text
                ) {
                    m3uCount += 1;
                    this.store.dispatch(
                        PlaylistActions.parsePlaylist({
                            uploadType: 'TEXT',
                            playlist: row.candidate.text,
                            title: row.title,
                            ...scope,
                        })
                    );
                }
            }
            // Portal catalogs fill in the background right after the rows
            // land, so a distant source is populated without ever being
            // opened. Failures surface there, not here.
            void this.seedPortals(portalPlaylists);
            // Portal rows persist silently (no per-row navigation), so open
            // the first one to start its catalog import like a single add.
            // M3U rows navigate on completion by themselves.
            if (m3uCount === 0 && portalPlaylists.length > 0) {
                const first = portalPlaylists[0];
                await this.router.navigate(
                    first.serverUrl
                        ? ['/workspace', 'xtreams', first._id]
                        : ['/workspace', 'stalker', first._id]
                );
            }
            this.snackBar.open(
                this.translate.instant(
                    'HOME.ADD_PLAYLIST.BULK_IMPORT_STARTED',
                    { count: rows.length }
                ),
                undefined,
                { duration: 3000 }
            );
            this.imported.emit();
        } finally {
            this.isImporting.set(false);
        }
    }

    /**
     * Parses a picked file into preview rows. True when the content was a
     * parsable bulk list (empty valid-rows included); false when it should
     * be reported as unreadable.
     */
    private patchEntry(id: string, patch: Partial<BulkImportEntry>): void {
        this.entries.update((rows) =>
            rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
        );
    }

    private parseSourceFile(contents: string): boolean {
        this.fileError.set(null);
        this.loadedFileName.set(null);
        const trimmed = contents.trim();
        if (!trimmed) {
            this.fileError.set(
                this.translate.instant('HOME.ADD_PLAYLIST.BULK_NO_SOURCES')
            );
            return false;
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = bulkEntriesFromJson(JSON.parse(trimmed));
                if (!parsed) {
                    throw new Error('Not a bulk source list');
                }
                this.entries.set(parsed);
            } catch {
                this.entries.set([]);
                this.fileError.set(
                    this.translate.instant(
                        'HOME.ADD_PLAYLIST.BULK_INVALID_JSON'
                    )
                );
                return false;
            }
            return true;
        }
        this.entries.set(
            candidatesToBulkEntries(
                detectProviderImportCandidates(trimmed)
            )
        );
        return true;
    }

    /**
     * Seeds each freshly persisted portal source so its channels and VOD
     * lists exist without waiting for a workspace open. Sources run
     * sequentially so one batch never hammers the DB worker with parallel
     * downloads, and single failures do not stop the rest.
     */
    private async seedPortals(playlists: Playlist[]): Promise<void> {
        if (playlists.length === 0 || this.seeders.length === 0) {
            return;
        }
        for (const playlist of playlists) {
            for (const seeder of this.seeders) {
                try {
                    await seeder.seed(playlist);
                } catch {
                    // Keep seeding the remaining sources; the seeder has
                    // already recorded its own failure.
                }
            }
        }
    }
}

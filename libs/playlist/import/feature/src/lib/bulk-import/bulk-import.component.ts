import {
    Component,
    computed,
    inject,
    output,
    signal,
    ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlaylistActions } from '@iptvnator/m3u-state';
import { DataService } from '@iptvnator/services';
import {
    BulkImportEntry,
    bulkEntriesFromJson,
    bulkEntryToPlaylist,
    candidatesToBulkEntries,
    detectProviderImportCandidates,
    isDirectBulkPlaylistEntry,
    PLAYLIST_PARSE_BY_URL,
    ProviderImportKind,
    SOURCE_TYPE_ICONS,
    storedImportScopeFlags,
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
 * Bulk source import: paste many provider handouts (or load them from a
 * `.txt`/`.json` file) and import every recognized source at once. Free
 * text runs through the same deterministic detection as the auto import;
 * JSON accepts an explicit `{ "sources": [...] }` (or bare array) list.
 * Each row carries its own title plus Live/VOD scope toggles, and rows can
 * be dropped before importing. Portal rows (Xtream/Stalker) persist in one
 * `addManyPlaylists`; M3U rows go through the regular URL/text pipelines
 * with the row's scope attached.
 */
@Component({
    selector: 'app-bulk-import',
    templateUrl: './bulk-import.component.html',
    styleUrl: './bulk-import.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatIcon,
        MatInputModule,
        ReactiveFormsModule,
        TranslatePipe,
    ],
})
export class BulkImportComponent {
    readonly imported = output<void>();

    private readonly store = inject(Store);
    private readonly router = inject(Router);
    private readonly dataService = inject(DataService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);

    readonly textControl = new FormControl('', { nonNullable: true });
    readonly entries = signal<BulkImportEntry[]>([]);
    /** Translated message; null when there is nothing to report. */
    readonly fileError = signal<string | null>(null);
    readonly isImporting = signal(false);

    readonly importableEntries = computed(() =>
        this.entries().filter((entry) => entry.valid)
    );
    readonly hasEntries = computed(() => this.entries().length > 0);

    constructor() {
        this.textControl.valueChanges
            .pipe(takeUntilDestroyed())
            .subscribe((value) => this.parseSourceText(value));
    }

    clearForm(): void {
        this.textControl.setValue('');
        this.entries.set([]);
        this.fileError.set(null);
    }

    async onFilePicked(input: HTMLInputElement): Promise<void> {
        const file = input.files?.[0];
        input.value = '';
        if (!file) {
            return;
        }
        try {
            this.textControl.setValue(await file.text());
        } catch {
            this.fileError.set(
                this.translate.instant('HOME.FILE_UPLOAD.OPEN_FAILED', {
                    filename: file.name,
                })
            );
        }
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
            const portalPlaylists = rows
                .filter(isDirectBulkPlaylistEntry)
                .map(bulkEntryToPlaylist)
                .filter((playlist) => playlist !== null);
            if (portalPlaylists.length > 0) {
                this.store.dispatch(
                    PlaylistActions.addManyPlaylists({
                        playlists: portalPlaylists,
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

    private parseSourceText(text: string): void {
        this.fileError.set(null);
        if (!text.trim()) {
            this.entries.set([]);
            return;
        }
        const trimmed = text.trim();
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
            }
            return;
        }
        this.entries.set(
            candidatesToBulkEntries(detectProviderImportCandidates(text))
        );
    }

    private patchEntry(id: string, patch: Partial<BulkImportEntry>): void {
        this.entries.update((rows) =>
            rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
        );
    }
}

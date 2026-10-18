import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { Store } from '@ngrx/store';
import { of } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { PlaylistActions } from '@iptvnator/m3u-state';
import {
    DataService,
    PlaylistsService,
    PORTAL_CONTENT_SEEDERS,
} from '@iptvnator/services';
import { PLAYLIST_PARSE_BY_URL } from '@iptvnator/shared/interfaces';
import { BulkImportComponent } from './bulk-import.component';

describe('BulkImportComponent', () => {
    let component: BulkImportComponent;
    let fixture: ComponentFixture<BulkImportComponent>;
    let store: { dispatch: jest.Mock };
    let dataService: { sendIpcEvent: jest.Mock };
    let playlistsService: { addManyPlaylists: jest.Mock };
    let seeders: { seed: jest.Mock }[];

    beforeEach(waitForAsync(() => {
        store = { dispatch: jest.fn() };
        dataService = { sendIpcEvent: jest.fn() };
        playlistsService = {
            addManyPlaylists: jest.fn().mockReturnValue(of(undefined)),
        };
        seeders = [{ seed: jest.fn().mockResolvedValue(undefined) }];
        TestBed.configureTestingModule({
            imports: [BulkImportComponent, TranslateModule.forRoot()],
            providers: [
                provideNoopAnimations(),
                provideRouter([]),
                { provide: Store, useValue: store },
                { provide: DataService, useValue: dataService },
                { provide: PlaylistsService, useValue: playlistsService },
                { provide: PORTAL_CONTENT_SEEDERS, useValue: seeders },
            ],
        }).compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(BulkImportComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    /** Picks a bulk list file the way the hidden input does. */
    async function pickFile(name: string, contents: string): Promise<void> {
        await component.onFilePicked(
            createFileInput(name, contents)
        );
    }

    function createFileInput(
        name: string,
        contents: string
    ): HTMLInputElement {
        const file = {
            name,
            text: jest.fn().mockResolvedValue(contents),
        };
        const input = document.createElement('input');
        Object.defineProperty(input, 'files', {
            value: [file],
        });
        return input;
    }

    it('detects several sources from one file', async () => {
        await pickFile(
            'sources.txt',
            'http://lists.example.com/a.m3u\nhttp://lists.example.com/b.m3u'
        );

        expect(component.entries()).toHaveLength(2);
        expect(component.importableEntries()).toHaveLength(2);
        expect(component.loadedFileName()).toBe('sources.txt');
        expect(component.fileError()).toBeNull();
    });

    it('parses a structured JSON source list', async () => {
        await pickFile(
            'sources.json',
            JSON.stringify({
                sources: [
                    {
                        type: 'xtream',
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        username: 'user',
                        password: 'pass',
                        importVod: false,
                    },
                ],
            })
        );

        expect(component.entries()).toHaveLength(1);
        expect(component.entries()[0]).toMatchObject({
            kind: 'xtream',
            title: 'Gold',
            importVod: false,
            valid: true,
        });
    });

    it('starts every row with VOD off until it is selected', async () => {
        await pickFile(
            'sources.txt',
            'http://lists.example.com/a.m3u\nhttp://lists.example.com/b.m3u'
        );

        expect(component.entries().map((entry) => entry.importLive)).toEqual([
            true,
            true,
        ]);
        expect(component.entries().map((entry) => entry.importVod)).toEqual([
            false,
            false,
        ]);
    });

    it('reports JSON that is not a source list instead of guessing', async () => {
        await pickFile('sources.json', '{"oops": true}');

        expect(component.entries()).toHaveLength(0);
        // TranslateModule.forRoot() ships no translations in tests, so the
        // service echoes the key — the dialog shows the translated message.
        expect(component.fileError()).toBe(
            'HOME.ADD_PLAYLIST.BULK_INVALID_JSON'
        );
    });

    it('treats a well-shaped list with no usable items as empty', async () => {
        await pickFile('sources.json', '{"sources": [42]}');

        expect(component.entries()).toHaveLength(0);
        expect(component.fileError()).toBeNull();
    });

    it('keeps at least one section per row', async () => {
        await pickFile('sources.txt', 'http://lists.example.com/a.m3u');
        const [entry] = component.entries();

        component.setEntryVod(entry.id, false);
        component.setEntryLive(entry.id, false);

        const updated = component.entries()[0];
        expect(updated.importVod).toBe(false);
        expect(updated.importLive).toBe(true);
    });

    it('imports portal rows in one awaited batch and M3U rows through their pipelines', async () => {
        await pickFile(
            'sources.json',
            JSON.stringify({
                sources: [
                    {
                        type: 'xtream',
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        username: 'user',
                        password: 'pass',
                        importLive: false,
                        importVod: true,
                    },
                    {
                        type: 'm3u-url',
                        title: 'List',
                        url: 'http://lists.example.com/a.m3u',
                        importVod: false,
                    },
                ],
            })
        );
        const emitted: void[] = [];
        component.imported.subscribe(() => emitted.push(undefined));

        await component.importAll();

        expect(playlistsService.addManyPlaylists).toHaveBeenCalledWith([
            expect.objectContaining({
                title: 'Gold',
                serverUrl: 'http://panel.example',
                importLive: false,
            }),
        ]);
        expect(store.dispatch).toHaveBeenCalledWith(
            PlaylistActions.addManyPlaylists({
                playlists: [
                    expect.objectContaining({
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        importLive: false,
                    }),
                ],
                persist: false,
            })
        );
        expect(dataService.sendIpcEvent).toHaveBeenCalledWith(
            PLAYLIST_PARSE_BY_URL,
            {
                url: 'http://lists.example.com/a.m3u',
                title: 'List',
                importVod: false,
            }
        );
        expect(emitted).toHaveLength(1);
    });

    it('seeds the persisted portal sources with their catalogs', async () => {
        await pickFile(
            'sources.json',
            JSON.stringify({
                sources: [
                    {
                        type: 'xtream',
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        username: 'user',
                        password: 'pass',
                    },
                    {
                        type: 'm3u-url',
                        title: 'List',
                        url: 'http://lists.example.com/a.m3u',
                    },
                ],
            })
        );

        await component.importAll();
        // Seeding runs in the background; flush it before asserting.
        await new Promise((resolve) => setTimeout(resolve));

        expect(seeders[0].seed).toHaveBeenCalledTimes(1);
        expect(seeders[0].seed).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Gold' })
        );
    });

    it('continues seeding when one source fails', async () => {
        seeders[0].seed
            .mockRejectedValueOnce(new Error('down'))
            .mockResolvedValueOnce(undefined);
        await pickFile(
            'sources.json',
            JSON.stringify({
                sources: [
                    {
                        type: 'xtream',
                        title: 'First',
                        serverUrl: 'http://panel.example',
                        username: 'user',
                        password: 'pass',
                    },
                    {
                        type: 'xtream',
                        title: 'Second',
                        serverUrl: 'http://panel2.example',
                        username: 'user',
                        password: 'pass',
                    },
                    // An M3U row keeps the flow off the try-navigate branch
                    // (no workspace routes exist in this test module).
                    {
                        type: 'm3u-url',
                        title: 'List',
                        url: 'http://lists.example.com/a.m3u',
                    },
                ],
            })
        );

        await component.importAll();
        // Seeding runs in the background; flush it before asserting.
        await new Promise((resolve) => setTimeout(resolve));

        expect(seeders[0].seed).toHaveBeenCalledTimes(2);
    });

    it('keeps row scope stable after parsing', async () => {
        await pickFile(
            'sources.json',
            JSON.stringify({
                sources: [
                    {
                        type: 'm3u-url',
                        title: 'Live Only',
                        url: 'http://lists.example.com/a.m3u',
                        importVod: false,
                    },
                ],
            })
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        const row = fixture.nativeElement.querySelector('.bulk__row');
        const boxes: HTMLInputElement[] = Array.from(
            row.querySelectorAll('input[type="checkbox"]')
        );
        expect(component.entries()[0]).toMatchObject({
            importLive: true,
            importVod: false,
        });
        expect(boxes).toHaveLength(2);
        expect(boxes[0].checked).toBe(true);
        expect(boxes[1].checked).toBe(false);
    });

    it('does nothing without importable rows', async () => {
        await pickFile('sources.txt', 'hello world');

        await component.importAll();

        expect(store.dispatch).not.toHaveBeenCalled();
        expect(dataService.sendIpcEvent).not.toHaveBeenCalled();
    });
});

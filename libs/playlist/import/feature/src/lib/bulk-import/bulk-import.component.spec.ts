import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateModule } from '@ngx-translate/core';
import { PlaylistActions } from '@iptvnator/m3u-state';
import { DataService } from '@iptvnator/services';
import { PLAYLIST_PARSE_BY_URL } from '@iptvnator/shared/interfaces';
import { BulkImportComponent } from './bulk-import.component';

describe('BulkImportComponent', () => {
    let component: BulkImportComponent;
    let fixture: ComponentFixture<BulkImportComponent>;
    let store: { dispatch: jest.Mock };
    let dataService: { sendIpcEvent: jest.Mock };

    beforeEach(waitForAsync(() => {
        store = { dispatch: jest.fn() };
        dataService = { sendIpcEvent: jest.fn() };
        TestBed.configureTestingModule({
            imports: [BulkImportComponent, TranslateModule.forRoot()],
            providers: [
                provideNoopAnimations(),
                provideRouter([]),
                { provide: Store, useValue: store },
                { provide: DataService, useValue: dataService },
            ],
        }).compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(BulkImportComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('detects several sources from one paste', () => {
        component.textControl.setValue(
            'http://lists.example.com/a.m3u\nhttp://lists.example.com/b.m3u'
        );

        expect(component.entries()).toHaveLength(2);
        expect(component.importableEntries()).toHaveLength(2);
    });

    it('parses a structured JSON source list', () => {
        component.textControl.setValue(
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

    it('reports JSON that is not a source list instead of guessing', () => {
        component.textControl.setValue('{"oops": true}');

        expect(component.entries()).toHaveLength(0);
        // TranslateModule.forRoot() ships no translations in tests, so the
        // service echoes the key — the dialog shows the translated message.
        expect(component.fileError()).toBe(
            'HOME.ADD_PLAYLIST.BULK_INVALID_JSON'
        );
    });

    it('treats a well-shaped list with no usable items as empty', () => {
        component.textControl.setValue('{"sources": [42]}');

        expect(component.entries()).toHaveLength(0);
        expect(component.fileError()).toBeNull();
    });

    it('keeps at least one section per row', () => {
        component.textControl.setValue('http://lists.example.com/a.m3u');
        const [entry] = component.entries();

        component.setEntryVod(entry.id, false);
        component.setEntryLive(entry.id, false);

        const updated = component.entries()[0];
        expect(updated.importVod).toBe(false);
        expect(updated.importLive).toBe(true);
    });

    it('imports portal rows in one batch and M3U rows through their pipelines', async () => {
        component.textControl.setValue(
            JSON.stringify({
                sources: [
                    {
                        type: 'xtream',
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        username: 'user',
                        password: 'pass',
                        importLive: false,
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

        expect(store.dispatch).toHaveBeenCalledWith(
            PlaylistActions.addManyPlaylists({
                playlists: [
                    expect.objectContaining({
                        title: 'Gold',
                        serverUrl: 'http://panel.example',
                        importLive: false,
                    }),
                ],
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

    it('keeps row scope stable after parsing', async () => {
        component.textControl.setValue(
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
        component.textControl.setValue('hello world');

        await component.importAll();

        expect(store.dispatch).not.toHaveBeenCalled();
        expect(dataService.sendIpcEvent).not.toHaveBeenCalled();
    });
});
